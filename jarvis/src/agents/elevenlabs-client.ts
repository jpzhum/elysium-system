import WebSocket, { type RawData } from 'ws';

export interface AgentSession {
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  sendText(text: string): void;
  /** Signed 16-bit little-endian, mono PCM at inputSampleRate. */
  sendAudio(pcm: Buffer): void;
  sendContext(text: string): void;
  /** Stop transport; optional drain only accepts PCM already received, never confirms a turn. */
  close(options?: { drainAudio?: boolean }): void;
}

export interface AgentResponseIdentity {
  eventId?: number;
  responseId?: string;
}

/** Private, bounded content for the caller's consent-scoped RAM history, never diagnostics. */
export interface AgentConversationText extends AgentResponseIdentity {
  kind: 'user_final' | 'agent_final' | 'agent_correction';
  text: string;
  truncated: boolean;
}

export interface AgentCallbacks {
  /** Copy borrowed PCM before returning/resolving; it is erased after bounded acceptance. */
  onAudio(pcm: Buffer, eventId: number, info?: { responseId?: string }): void | Promise<void>;
  onResponseComplete(eventId?: number): void | Promise<void>;
  /** Content-free signals only. Never forward the provider's text to diagnostics. */
  onTextResponse?(identity?: AgentResponseIdentity): void;
  /** Content-free recognition marker; tentative transcripts never trigger it. */
  onUserTranscript?(identity?: AgentResponseIdentity): void;
  /**
   * Opt-in private text, at most 4 KiB UTF-8 per event, in wire order with PCM.
   * Final text is not proof of generation completion or audible delivery.
   * Never send this payload to logs, errors, status, or another user's session.
   */
  onConversationText?(event: AgentConversationText): void;
  onToolActivity?(pending: number): void;
  onProtocolEvent?(event: 'audio' | 'agent_response' | 'agent_response_complete' | 'client_error'): void;
  onInterruption(): void;
  onClose(): void;
  onError(code: string): void;
}

export interface ConnectAgentOptions {
  apiKey: string;
  agentId: string;
  dynamicVariables: Record<string, string | number | boolean>;
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
  /** Requires Security > First message override permission; never retried without suppression. */
  suppressFirstMessage?: boolean;
  /** Identity and authorization must come from the caller's trusted closure. */
  tools?: (name: string, parameters: unknown, signal: AbortSignal) => Promise<unknown>;
  /** Fixed tool/stage classifications only: parameters, IDs and results never enter diagnostics. */
  onToolEvent?(event: AgentToolDiagnostic): void;
  /** Monotonic connection stages only; never expose credentials, URLs or provider IDs. */
  onConnectionStage?(event: AgentConnectionStage): void;
}

export interface AgentConnectionStage {
  stage: 'signed_url' | 'websocket_handshake' | 'audio_negotiation';
  durationMs: number;
}

export interface AgentToolDiagnostic {
  stage: 'received' | 'started' | 'completed' | 'failed';
  tool: 'search_game_info' | 'get_voice_participants' | 'unknown';
  waitForResponse: boolean;
  durationMs?: number;
  code?: 'TOOL_UNAVAILABLE' | 'TOOL_FAILED' | 'TOOL_TIMEOUT' | 'TOOL_CANCELLED';
}

export class AgentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentError';
  }
}

type AgentSocket = Pick<WebSocket,
  'on' | 'send' | 'close' | 'terminate' | 'readyState' | 'bufferedAmount'>
  & Partial<Pick<WebSocket, 'pause' | 'resume'>>;

/** Injection is for protocol tests; production always uses the fixed HTTPS origin. */
export interface AgentDependencies {
  fetch: typeof fetch;
  createSocket(url: string): AgentSocket;
  random(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

const MAX_MESSAGE_BYTES = 384 * 1024;
const MAX_PCM_BYTES = 192_000;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_INGRESS_PCM_BYTES = 384 * 1024;
const PAUSE_INGRESS_PCM_BYTES = 256 * 1024;
const RESUME_INGRESS_PCM_BYTES = 128 * 1024;
const MAX_INGRESS_EVENTS = 1024;
const MAX_CONVERSATION_TEXT_BYTES = 4096;
const MAX_INGRESS_TEXT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const METADATA_TIMEOUT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const PCM_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('invalid_agent_event');
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentError('invalid_agent_event');
  }
  return value;
}

function responseIdentity(value: Record<string, unknown>): AgentResponseIdentity {
  return {
    ...(value.event_id === undefined ? {} : { eventId: integer(value.event_id) }),
    ...(value.response_id === undefined ? {} : { responseId: boundedString(value.response_id, 200) }),
  };
}

function boundedString(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > bytes) {
    throw new AgentError('invalid_agent_event');
  }
  return value;
}

function conversationText(
  kind: AgentConversationText['kind'], value: string, identity: AgentResponseIdentity,
): AgentConversationText {
  const encoded = Buffer.from(value, 'utf8');
  let end = Math.min(encoded.length, MAX_CONVERSATION_TEXT_BYTES);
  // The prefix must end before a multibyte code point rather than inserting a
  // replacement character or retaining a view of the provider's full payload.
  while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
  return { kind, text: encoded.subarray(0, end).toString('utf8'),
    truncated: end < encoded.length, ...identity };
}

function pcmRate(format: unknown): number {
  if (typeof format !== 'string' || !/^pcm_\d+$/.test(format)) {
    throw new AgentError('unsupported_audio_format');
  }
  const rate = Number(format.slice(4));
  if (!PCM_RATES.has(rate)) throw new AgentError('unsupported_audio_format');
  return rate;
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'agent_authentication_failed';
  if (status === 402) return 'agent_credit_limit';
  if (status === 429) return 'agent_rate_limited';
  return 'agent_unavailable';
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AgentError('agent_aborted')); return; }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AgentError('agent_aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function limitedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => { /* Do not await an untrusted cancel handler. */ });
    throw new AgentError('invalid_agent_reply');
  }
  if (!response.body) throw new AgentError('invalid_agent_reply');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let rejectAborted: ((reason: AgentError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = (): void => {
    rejectAborted?.(new AgentError('agent_request_timeout'));
    // Cancellation itself may be implemented by a stalled upstream stream.
    void reader.cancel().catch(() => { /* The public error is always sanitized. */ });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw new AgentError('agent_request_timeout');
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => { /* No remote error text is exposed. */ });
        throw new AgentError('invalid_agent_reply');
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

async function getSignedUrl(options: ConnectAgentOptions, deps: AgentDependencies): Promise<string> {
  const endpoint = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
  endpoint.searchParams.set('agent_id', options.agentId);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (options.signal?.aborted) throw new AgentError('agent_aborted');
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await deps.fetch(endpoint, {
        headers: { 'xi-api-key': options.apiKey, Accept: 'application/json' },
        signal,
        redirect: 'error',
      });
    } catch {
      throw new AgentError(options.signal?.aborted ? 'agent_aborted' : 'agent_unavailable');
    }
    if (!response.ok) {
      // Never parse, propagate or log an upstream error body or signed URL.
      void response.body?.cancel().catch(() => { /* Upstream error bodies are discarded. */ });
      if (attempt < 2 && (response.status === 429 || (response.status >= 500 && response.status <= 599))) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 2000)
          : 250 * 2 ** attempt * (0.5 + deps.random() * 0.5);
        await deps.sleep(delay, options.signal);
        continue;
      }
      throw new AgentError(statusCode(response.status));
    }
    try {
      const data = record(await limitedJson(response, 16 * 1024, signal));
      const signed = new URL(boundedString(data.signed_url, 8192));
      if (signed.protocol !== 'wss:' || signed.hostname !== 'api.elevenlabs.io'
        || (signed.port !== '' && signed.port !== '443') || signed.username || signed.password
        || signed.hash || signed.pathname !== '/v1/convai/conversation'
        || signed.searchParams.get('agent_id') !== options.agentId
        || !(signed.searchParams.get('conversation_signature') || signed.searchParams.get('token'))) {
        throw new AgentError('invalid_signed_url');
      }
      return signed.href;
    } catch (error) {
      if (options.signal?.aborted) throw new AgentError('agent_aborted');
      if (error instanceof AgentError && ['invalid_signed_url', 'invalid_agent_reply', 'agent_request_timeout'].includes(error.code)) throw error;
      throw new AgentError('invalid_agent_reply');
    }
  }
  throw new AgentError('agent_unavailable');
}

const productionDependencies: AgentDependencies = {
  fetch: (...args) => fetch(...args),
  createSocket: url => new WebSocket(url, {
    handshakeTimeout: REQUEST_TIMEOUT_MS,
    maxPayload: MAX_MESSAGE_BYTES,
    followRedirects: false,
    perMessageDeflate: false,
  }),
  random: () => Math.random(),
  sleep: abortableSleep,
};

/**
 * Opens a fresh private session and resolves only after mono PCM is negotiated.
 * No audio, transcripts, remote error messages, credentials or signed URLs are logged.
 * Configure audio formats and `agent_response_complete` in the ElevenLabs dashboard.
 */
export function connectAgent(options: ConnectAgentOptions): Promise<AgentSession> {
  return createAgentConnector(productionDependencies)(options);
}

export function createAgentConnector(deps: AgentDependencies): (options: ConnectAgentOptions) => Promise<AgentSession> {
  return async options => {
    if (!options.apiKey || !/^[\w-]{1,200}$/.test(options.agentId)) {
      throw new AgentError('invalid_agent_configuration');
    }
    const variables = Object.entries(options.dynamicVariables);
    if (variables.length > 32 || variables.some(([key, value]) =>
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || key.startsWith('system__')
      || !['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value)))) {
      throw new AgentError('invalid_agent_configuration');
    }
    const initiation = JSON.stringify({
      type: 'conversation_initiation_client_data',
      source_info: { source: 'unknown', version: 'jarvis-1' },
      dynamic_variables: options.dynamicVariables,
      ...(options.suppressFirstMessage ? { conversation_config_override: { agent: { first_message: '' } } } : {}),
    });
    if (Buffer.byteLength(initiation) > 16 * 1024) throw new AgentError('invalid_agent_configuration');
    const connectionStage = (stage: AgentConnectionStage['stage'], started: number): void => {
      try { options.onConnectionStage?.({ stage, durationMs: Math.max(0, performance.now() - started) }); }
      catch { /* Diagnostics must never alter provider connectivity. */ }
    };
    const signedUrlStarted = performance.now();
    const signedUrl = await getSignedUrl(options, deps);
    connectionStage('signed_url', signedUrlStarted);
    if (options.signal?.aborted) throw new AgentError('agent_aborted');
    const socketStarted = performance.now();
    let socketOpenedAt: number | undefined;
    let ws: AgentSocket;
    try { ws = deps.createSocket(signedUrl); }
    catch { throw new AgentError('agent_unavailable'); }

    return new Promise<AgentSession>((resolve, reject) => {
      let negotiated = false;
      let closed = false;
      let finalized = false;
      let draining = false;
      let pumping = false;
      let ingressBytes = 0;
      let ingressTextBytes = 0;
      let paused = false;
      let inFlightPcm: Buffer | undefined;
      let deliveryEpoch = 0;
      let lastInterruptId = 0;
      let inputSampleRate = 0;
      let outputSampleRate = 0;
      let toolsActive = 0;
      let toolsUsed = 0;
      let lastMessageAt = Date.now();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const toolIds = new Set<string>();
      const pendingToolIds = new Set<string>();
      const cancelTools = new Set<() => void>();
      type Delivery = { kind: 'audio'; pcm: Buffer; eventId: number; info?: { responseId?: string } }
        | { kind: 'complete'; eventId: number }
        | { kind: 'text'; identity: AgentResponseIdentity; content?: AgentConversationText }
        | { kind: 'user_transcript'; identity: AgentResponseIdentity; content?: AgentConversationText }
        | { kind: 'correction'; content: AgentConversationText }
        | { kind: 'tool'; start(): void; cancel(): void };
      const deliveries: Delivery[] = [];
      const notify = (callback: () => void): void => { try { callback(); } catch { /* Do not expose callback data. */ } };
      const cleanup = (removeAbort: boolean): void => {
        clearTimeout(metadataTimer);
        clearInterval(heartbeatTimer);
        if (removeAbort) options.signal?.removeEventListener('abort', onAbort);
        for (const cancel of cancelTools) cancel();
        cancelTools.clear();
        toolIds.clear();
        pendingToolIds.clear();
      };
      const resumeIngress = (): void => {
        if (!paused || ingressBytes > RESUME_INGRESS_PCM_BYTES) return;
        paused = false;
        // A local TCP pause hides provider pings. Restart their liveness window
        // when we can receive again; independent session/playback limits bound it.
        lastMessageAt = Date.now();
        try { ws.resume?.(); } catch { /* Transport closure is handled separately. */ }
      };
      const finishClose = (): void => {
        if (finalized) return;
        finalized = true;
        cleanup(true);
        notify(() => options.callbacks.onClose());
      };
      const discardDeliveries = (preserveRecognition = false): void => {
        deliveryEpoch++;
        // An interruption invalidates agent output, not speech already recognized
        // from the user. Keep only final ASR markers behind a slow write.
        // Local cancellation/revocation always discards every delivery instead.
        const recognition = preserveRecognition
          ? deliveries.filter(item => item.kind === 'user_transcript') : [];
        for (const item of deliveries) {
          if (item.kind === 'audio') item.pcm.fill(0);
          else if (item.kind === 'tool') item.cancel();
        }
        // In-flight PCM remains borrowed until the callback settles; cancellation
        // also revokes playback, whose pending write then rejects promptly.
        deliveries.length = 0;
        deliveries.push(...recognition);
        ingressBytes = 0;
        ingressTextBytes = recognition.reduce((total, item) =>
          total + (item.kind === 'user_transcript' && item.content ? Buffer.byteLength(item.content.text) : 0), 0);
        resumeIngress();
      };
      const end = (code?: string, drainAudio = false): void => {
        if (finalized) return;
        if (closed) {
          // Revocation can cancel a graceful transport drain that is still pending.
          if (!drainAudio) { draining = false; discardDeliveries(); finishClose(); }
          return;
        }
        closed = true;
        draining = drainAudio && negotiated;
        cleanup(!draining);
        if (code) notify(() => options.callbacks.onError(code));
        if (!negotiated) reject(new AgentError(code ?? 'agent_closed'));
        if (!draining) discardDeliveries();
        // terminate bounds shutdown even when the remote peer never acknowledges CLOSE.
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000);
          if (Number(ws.readyState) !== WebSocket.CLOSED) {
            closeTimer = setTimeout(() => ws.terminate(), 1000);
            closeTimer.unref();
          }
        } else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        if (!draining || (!pumping && deliveries.length === 0)) finishClose();
      };
      // A local close/revocation after negotiation is not a provider failure.
      const onAbort = (): void => end(negotiated ? undefined : 'agent_aborted');
      const dispatch = (callback: () => void): void => {
        try { callback(); }
        catch { end('agent_callback_error'); }
      };
      const updateToolActivity = (id: string, pending: boolean): void => {
        if (pending) {
          if (pendingToolIds.size >= 128 && !pendingToolIds.has(id)) throw new AgentError('agent_tool_limit');
          pendingToolIds.add(id);
        } else pendingToolIds.delete(id);
        dispatch(() => options.callbacks.onToolActivity?.(pendingToolIds.size));
      };
      const pump = (): void => {
        if (pumping || finalized || (closed && !draining)) return;
        pumping = true;
        const epoch = deliveryEpoch;
        while (deliveries.length > 0 && epoch === deliveryEpoch && !finalized) {
          const item = deliveries.shift()!;
          try {
            if ('content' in item && item.content) ingressTextBytes -= Buffer.byteLength(item.content.text);
            if (item.kind === 'user_transcript') {
              // Preserve wire order with PCM so greeting audio queued before ASR
              // cannot be reclassified as an answer when a slow write resumes.
              options.callbacks.onUserTranscript?.(item.identity);
              if (item.content && !finalized && epoch === deliveryEpoch) options.callbacks.onConversationText?.(item.content);
              continue;
            }
            if (item.kind === 'text') {
              options.callbacks.onTextResponse?.(item.identity);
              if (item.content && !finalized && epoch === deliveryEpoch) options.callbacks.onConversationText?.(item.content);
              continue;
            }
            if (item.kind === 'correction') {
              options.callbacks.onConversationText?.(item.content);
              continue;
            }
            if (item.kind === 'tool') {
              // A client tool must observe earlier ASR markers, but its network
              // request must never hold subsequent audio or protocol progress.
              item.start();
              continue;
            }
            if (item.kind === 'complete') {
              // A completion waits for prior writes to be accepted, not for playback
              // to finish. Its own callback cannot block later protocol progress.
              const result = options.callbacks.onResponseComplete(item.eventId);
              if (result) void Promise.resolve(result).catch(() => {
                if (epoch === deliveryEpoch && !finalized) end('agent_callback_error');
              });
              continue;
            }
            inFlightPcm = item.pcm;
            const result = item.info
              ? options.callbacks.onAudio(item.pcm, item.eventId, item.info)
              : options.callbacks.onAudio(item.pcm, item.eventId);
            if (result) {
              void Promise.resolve(result).then(() => {
                item.pcm.fill(0);
                inFlightPcm = undefined;
                if (epoch === deliveryEpoch) ingressBytes -= item.pcm.length;
                resumeIngress();
                pumping = false;
                pump();
              }, () => {
                item.pcm.fill(0);
                inFlightPcm = undefined;
                pumping = false;
                if (epoch === deliveryEpoch && !finalized) end('agent_callback_error');
                else pump();
              });
              return;
            }
            item.pcm.fill(0);
            inFlightPcm = undefined;
            if (epoch === deliveryEpoch) ingressBytes -= item.pcm.length;
            resumeIngress();
          } catch {
            inFlightPcm?.fill(0);
            inFlightPcm = undefined;
            pumping = false;
            end('agent_callback_error');
            return;
          }
        }
        pumping = false;
        if (closed && draining && deliveries.length === 0) finishClose();
        else if (deliveries.length > 0 && !finalized) queueMicrotask(pump);
      };
      const enqueue = (item: Delivery): void => {
        const bytes = item.kind === 'audio' ? item.pcm.length : 0;
        const textBytes = 'content' in item && item.content ? Buffer.byteLength(item.content.text) : 0;
        if (deliveries.length >= MAX_INGRESS_EVENTS || ingressBytes + bytes > MAX_INGRESS_PCM_BYTES
          || ingressTextBytes + textBytes > MAX_INGRESS_TEXT_BYTES) {
          if (item.kind === 'audio') item.pcm.fill(0);
          throw new AgentError('agent_audio_backpressure');
        }
        deliveries.push(item);
        ingressBytes += bytes;
        ingressTextBytes += textBytes;
        if (!paused && ingressBytes >= PAUSE_INGRESS_PCM_BYTES && ws.pause) {
          paused = true;
          ws.pause();
        }
        pump();
      };
      const metadataTimer = setTimeout(() => end('agent_metadata_timeout'), METADATA_TIMEOUT_MS);
      const heartbeatTimer = setInterval(() => {
        if (!paused && Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT_MS) end('agent_heartbeat_timeout', true);
      }, 10_000);
      heartbeatTimer.unref();
      const send = (payload: unknown): void => {
        if (closed || ws.readyState !== WebSocket.OPEN) throw new AgentError('agent_closed');
        const data = JSON.stringify(payload);
        if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES || ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) {
          end('agent_backpressure');
          throw new AgentError('agent_backpressure');
        }
        try {
          ws.send(data, error => { if (error) end('agent_transport_error', true); });
        } catch { end('agent_transport_error', true); throw new AgentError('agent_transport_error'); }
      };
      const session: AgentSession = {
        get inputSampleRate() { return inputSampleRate; },
        get outputSampleRate() { return outputSampleRate; },
        sendText: text => send({ type: 'user_message', text: boundedString(text, 8192) }),
        sendContext: text => send({ type: 'contextual_update', text: boundedString(text, 4096) }),
        sendAudio: pcm => {
          if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > MAX_PCM_BYTES) {
            throw new AgentError('invalid_input_audio');
          }
          send({ user_audio_chunk: pcm.toString('base64') });
        },
        close: closeOptions => end(undefined, closeOptions?.drainAudio),
      };
      const queueTool = (call: Record<string, unknown>): void => {
        const name = boundedString(call.tool_name, 100);
        const id = boundedString(call.tool_call_id, 200);
        const started = performance.now();
        if (call.expects_response !== undefined && typeof call.expects_response !== 'boolean') {
          throw new AgentError('invalid_agent_event');
        }
        const encodedParameters = JSON.stringify(call.parameters ?? {});
        if (Buffer.byteLength(encodedParameters) > 4096) throw new AgentError('tool_parameters_too_large');
        // Retain only this bounded canonical payload, not unrelated fields from
        // a potentially 384 KiB provider event. At most 128 calls per session.
        let parameters: unknown = JSON.parse(encodedParameters) as unknown;
        const tool: AgentToolDiagnostic['tool'] = name === 'search_game_info' || name === 'get_voice_participants'
          ? name : 'unknown';
        const waitForResponse = call.expects_response !== false;
        const diagnostic = (stage: AgentToolDiagnostic['stage'], code?: AgentToolDiagnostic['code']): void => {
          notify(() => options.onToolEvent?.({ stage, tool, waitForResponse,
            ...(stage === 'completed' || stage === 'failed' ? { durationMs: Math.max(0, performance.now() - started) } : {}),
            ...(code ? { code } : {}) }));
        };
        diagnostic('received');
        if (closed) return;
        if (toolIds.has(id)) return;
        if (toolIds.size >= 128) throw new AgentError('agent_tool_limit');
        toolIds.add(id);
        updateToolActivity(id, true);
        if (closed) return;
        const toolAbort = new AbortController();
        let settled = false;
        let active = false;
        const failureResult = 'A ferramenta não concluiu a consulta. Não há resultado verificado.';
        const finish = (result: string, code?: AgentToolDiagnostic['code'], reply = true): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelTools.delete(cancel);
          parameters = undefined;
          toolAbort.abort();
          if (active) { toolsActive--; active = false; }
          diagnostic(code ? 'failed' : 'completed', code);
          if (closed) return;
          if (reply && waitForResponse) {
            try { send({ type: 'client_tool_result', tool_call_id: id, result, is_error: Boolean(code) }); }
            catch { end('agent_tool_error'); }
          }
          if (!closed) updateToolActivity(id, false);
        };
        const cancel = (): void => finish(failureResult, 'TOOL_CANCELLED', false);
        const timer = setTimeout(() => finish(failureResult, 'TOOL_TIMEOUT'), 8000);
        timer.unref();
        cancelTools.add(cancel);
        enqueue({ kind: 'tool', cancel, start: () => {
          if (settled || closed) return;
          if (performance.now() - started >= 8000) { finish(failureResult, 'TOOL_TIMEOUT'); return; }
          if (toolsActive >= 2 || toolsUsed >= 64 || !options.tools || !negotiated) {
            finish('Ferramenta indisponível nesta sessão.', 'TOOL_UNAVAILABLE'); return;
          }
          toolsActive++;
          toolsUsed++;
          active = true;
          diagnostic('started');
          if (settled || closed) return;
          try {
            // Invocation stays synchronous with the ordered marker. Completion is
            // detached so pending tools cannot deadlock the audio delivery pump.
            const operation = options.tools(name, parameters, toolAbort.signal);
            void Promise.resolve(operation).then(value => {
              if (settled) return;
              try {
                const result = typeof value === 'string' ? value : JSON.stringify(value) ?? 'Sem resultado.';
                if (Buffer.byteLength(result) > 16 * 1024) throw new AgentError('tool_result_too_large');
                finish(result);
              } catch { finish(failureResult, 'TOOL_FAILED'); }
            }, () => finish(failureResult, 'TOOL_FAILED'));
          } catch { finish(failureResult, 'TOOL_FAILED'); }
        } });
      };
      ws.on('open', () => {
        if (closed) return;
        socketOpenedAt = performance.now();
        connectionStage('websocket_handshake', socketStarted);
        try { send(JSON.parse(initiation) as unknown); } catch { end('agent_transport_error'); }
      });
      ws.on('message', (raw: RawData, binary: boolean) => {
        if (closed) return;
        try {
          const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          if (binary || data.length > MAX_MESSAGE_BYTES) throw new AgentError('invalid_agent_event');
          const event = record(JSON.parse(data.toString('utf8')) as unknown);
          lastMessageAt = Date.now();
          switch (event.type) {
            case 'conversation_initiation_metadata': {
              if (negotiated) throw new AgentError('invalid_agent_event');
              const metadata = record(event.conversation_initiation_metadata_event);
              boundedString(metadata.conversation_id, 200);
              inputSampleRate = pcmRate(metadata.user_input_audio_format);
              outputSampleRate = pcmRate(metadata.agent_output_audio_format);
              negotiated = true;
              clearTimeout(metadataTimer);
              if (socketOpenedAt !== undefined) connectionStage('audio_negotiation', socketOpenedAt);
              resolve(session);
              break;
            }
            case 'audio': {
              dispatch(() => options.callbacks.onProtocolEvent?.('audio'));
              if (closed) return;
              if (!negotiated) throw new AgentError('audio_before_metadata');
              const audio = record(event.audio_event);
              const encoded = boundedString(audio.audio_base_64, Math.ceil(MAX_PCM_BYTES / 3) * 4);
              if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
                throw new AgentError('invalid_output_audio');
              }
              const pcm = Buffer.from(encoded, 'base64');
              if (pcm.length === 0 || pcm.length % 2 || pcm.length > MAX_PCM_BYTES) throw new AgentError('invalid_output_audio');
              const eventId = integer(audio.event_id);
              // The SDK uses event_id as an interruption boundary. Multiple PCM
              // chunks may share it; it is not a unique packet sequence number.
              if (eventId < lastInterruptId) break;
              const identity = responseIdentity(audio);
              enqueue({ kind: 'audio', pcm, eventId,
                ...(identity.responseId ? { info: { responseId: identity.responseId } } : {}) });
              break;
            }
            case 'ping':
              send({ type: 'pong', event_id: integer(record(event.ping_event).event_id) });
              break;
            case 'interruption':
              if (!negotiated) throw new AgentError('invalid_agent_event');
              if (event.interruption_event !== undefined) {
                const interruption = record(event.interruption_event);
                if (interruption.event_id !== undefined) lastInterruptId = Math.max(lastInterruptId, integer(interruption.event_id));
              }
              for (const cancel of cancelTools) cancel();
              discardDeliveries(true);
              dispatch(() => options.callbacks.onInterruption());
              pump();
              break;
            case 'agent_response_complete': {
              dispatch(() => options.callbacks.onProtocolEvent?.('agent_response_complete'));
              if (closed) return;
              if (!negotiated) throw new AgentError('invalid_agent_event');
              const eventId = integer(record(event.agent_response_complete_event).event_id);
              enqueue({ kind: 'complete', eventId });
              break;
            }
            case 'client_tool_call':
              if (!negotiated) throw new AgentError('invalid_agent_event');
              queueTool(record(event.client_tool_call));
              break;
            case 'agent_tool_request': {
              if (!negotiated) throw new AgentError('invalid_agent_event');
              updateToolActivity(boundedString(record(event.agent_tool_request).tool_call_id, 200), true);
              break;
            }
            case 'agent_tool_response':
            case 'agent_tool_response_full_payload': {
              if (!negotiated) throw new AgentError('invalid_agent_event');
              const result = record(event[event.type]);
              updateToolActivity(boundedString(result.tool_call_id, 200), false);
              break;
            }
            case 'mcp_tool_call': {
              if (!negotiated) throw new AgentError('invalid_agent_event');
              const call = record(event.mcp_tool_call);
              const pending = call.state === 'loading' || call.state === 'awaiting_approval';
              if (!pending && call.state !== 'success' && call.state !== 'failure') throw new AgentError('invalid_agent_event');
              updateToolActivity(boundedString(call.tool_call_id, 200), pending);
              break;
            }
            case 'client_error':
            case 'error': {
              dispatch(() => options.callbacks.onProtocolEvent?.('client_error'));
              if (closed) return;
              const error = record(event.error_event);
              const status = typeof error.code === 'number' ? error.code : 0;
              // The API has no documented, stable override-specific error code.
              // Identify rejected initiation without copying arbitrary provider text
              // or claiming that override permission is the proven cause.
              end(!negotiated && options.suppressFirstMessage && (status === 400 || status === 422)
                ? 'agent_initiation_rejected' : statusCode(status));
              break;
            }
            case 'queue_status':
              if (record(event.queue_status_event).status !== 'admitted') end('agent_concurrency_limit');
              break;
            case 'agent_response': {
              dispatch(() => options.callbacks.onProtocolEvent?.('agent_response'));
              if (closed) return;
              if (!negotiated) throw new AgentError('invalid_agent_event');
              const response = record(event.agent_response_event);
              if (typeof response.agent_response !== 'string') throw new AgentError('invalid_agent_event');
              if (response.agent_response.trim()) {
                const identity = responseIdentity(response);
                enqueue({ kind: 'text', identity, ...(options.callbacks.onConversationText
                  ? { content: conversationText('agent_final', response.agent_response, identity) } : {}) });
              }
              break;
            }
            case 'agent_chat_response_part': {
              const part = record(event.text_response_part);
              if (part.type === 'delta' && typeof part.text === 'string' && part.text.trim()) {
                enqueue({ kind: 'text', identity: responseIdentity(part) });
              }
              break;
            }
            case 'user_transcript': {
              if (!negotiated) throw new AgentError('invalid_agent_event');
              const transcript = record(event.user_transcription_event);
              if (typeof transcript.user_transcript !== 'string'
                || Buffer.byteLength(transcript.user_transcript) > MAX_MESSAGE_BYTES) {
                throw new AgentError('invalid_agent_event');
              }
              // user_transcript is the finalized utterance in the ElevenAgents
              // protocol; tentative events must never unlock response playback.
              if (transcript.user_transcript.trim()) {
                const identity = responseIdentity(transcript);
                enqueue({ kind: 'user_transcript', identity, ...(options.callbacks.onConversationText
                  ? { content: conversationText('user_final', transcript.user_transcript, identity) } : {}) });
              }
              break;
            }
            case 'agent_response_correction': {
              if (!options.callbacks.onConversationText) break;
              if (!negotiated) throw new AgentError('invalid_agent_event');
              const correction = record(event.agent_response_correction_event);
              if (typeof correction.corrected_agent_response !== 'string') throw new AgentError('invalid_agent_event');
              // An empty correction is meaningful: the previously represented
              // answer may have been fully interrupted. Never retain the original.
              enqueue({ kind: 'correction', content: conversationText('agent_correction',
                correction.corrected_agent_response, responseIdentity(correction)) });
              break;
            }
            // Tentative, incremental and internal reasoning text never enters RAM history.
            case 'tentative_user_transcript':
            case 'agent_reasoning_response_part':
            case 'vad_score':
              break;
            case 'guardrail_triggered': end('agent_guardrail'); break;
            default: break; // Forward-compatible metadata is ignored without logging payloads.
          }
        } catch (error) {
          end(error instanceof AgentError ? error.code : 'invalid_agent_event');
        }
      });
      ws.on('error', () => end('agent_transport_error', true));
      ws.on('unexpected-response', (_request, response) => {
        response.resume();
        end(statusCode(response.statusCode ?? 0));
      });
      ws.on('close', (code?: number) => {
        clearTimeout(closeTimer);
        if (!closed) end(negotiated ? undefined
          : options.suppressFirstMessage && code === 1008 ? 'agent_initiation_rejected' : 'agent_closed_before_metadata', true);
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  };
}
