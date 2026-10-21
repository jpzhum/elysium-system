import WebSocket, { type RawData } from 'ws';

export interface AgentSession {
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  sendText(text: string): void;
  /** Signed 16-bit little-endian, mono PCM at inputSampleRate. */
  sendAudio(pcm: Buffer): void;
  sendContext(text: string): void;
  close(): void;
}

export interface AgentCallbacks {
  onAudio(pcm: Buffer, eventId: number): void;
  onResponseComplete(): void;
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
  /** Requires the first-message override to be enabled in the agent dashboard. */
  suppressFirstMessage?: boolean;
  /** Identity and authorization must come from the caller's trusted closure. */
  tools?: (name: string, parameters: unknown) => Promise<unknown>;
}

export class AgentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentError';
  }
}

type AgentSocket = Pick<WebSocket,
  'on' | 'send' | 'close' | 'terminate' | 'readyState' | 'bufferedAmount'>;

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

function boundedString(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > bytes) {
    throw new AgentError('invalid_agent_event');
  }
  return value;
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
    const signedUrl = await getSignedUrl(options, deps);
    if (options.signal?.aborted) throw new AgentError('agent_aborted');
    let ws: AgentSocket;
    try { ws = deps.createSocket(signedUrl); }
    catch { throw new AgentError('agent_unavailable'); }

    return new Promise<AgentSession>((resolve, reject) => {
      let negotiated = false;
      let closed = false;
      let inputSampleRate = 0;
      let outputSampleRate = 0;
      let toolsActive = 0;
      let toolsUsed = 0;
      let lastMessageAt = Date.now();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const toolIds = new Set<string>();
      const cancelTools = new Set<() => void>();
      const notify = (callback: () => void): void => { try { callback(); } catch { /* Do not expose callback data. */ } };
      const cleanup = (): void => {
        clearTimeout(metadataTimer);
        clearInterval(heartbeatTimer);
        options.signal?.removeEventListener('abort', onAbort);
        for (const cancel of cancelTools) cancel();
        cancelTools.clear();
        toolIds.clear();
      };
      const end = (code?: string): void => {
        if (closed) return;
        closed = true;
        cleanup();
        if (code) notify(() => options.callbacks.onError(code));
        if (!negotiated) reject(new AgentError(code ?? 'agent_closed'));
        notify(() => options.callbacks.onClose());
        // terminate bounds shutdown even when the remote peer never acknowledges CLOSE.
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000);
          if (Number(ws.readyState) !== WebSocket.CLOSED) {
            closeTimer = setTimeout(() => ws.terminate(), 1000);
            closeTimer.unref();
          }
        } else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      };
      const onAbort = (): void => end('agent_aborted');
      const dispatch = (callback: () => void): void => {
        try { callback(); }
        catch { end('agent_callback_error'); }
      };
      const metadataTimer = setTimeout(() => end('agent_metadata_timeout'), METADATA_TIMEOUT_MS);
      const heartbeatTimer = setInterval(() => {
        if (Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT_MS) end('agent_heartbeat_timeout');
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
          ws.send(data, error => { if (error) end('agent_transport_error'); });
        } catch { end('agent_transport_error'); throw new AgentError('agent_transport_error'); }
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
        close: () => end(),
      };
      const runTool = async (call: Record<string, unknown>): Promise<void> => {
        const name = boundedString(call.tool_name, 100);
        const id = boundedString(call.tool_call_id, 200);
        if (toolIds.has(id)) return;
        toolIds.add(id);
        let result = 'Ferramenta indisponível nesta sessão.';
        let isError = true;
        if (toolsActive < 2 && toolsUsed < 64 && options.tools && negotiated) {
          toolsActive++;
          toolsUsed++;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let cancel: (() => void) | undefined;
          try {
            if (Buffer.byteLength(JSON.stringify(call.parameters ?? {})) > 4096) throw new AgentError('tool_parameters_too_large');
            const aborted = new Promise<never>((_resolve, rejectTool) => {
              cancel = () => rejectTool(new AgentError('agent_closed'));
              cancelTools.add(cancel);
              timer = setTimeout(() => rejectTool(new AgentError('tool_timeout')), 8000);
              timer.unref();
            });
            // A synchronous callback may revoke consent and then throw. Attach the
            // cancellation rejection to the race even in that reentrant case.
            let operation: Promise<unknown>;
            try { operation = options.tools(name, call.parameters ?? {}); }
            catch { operation = Promise.reject(new AgentError('tool_failed')); }
            const value = await Promise.race([operation, aborted]);
            result = typeof value === 'string' ? value : JSON.stringify(value) ?? 'Sem resultado.';
            if (Buffer.byteLength(result) > 16 * 1024) throw new AgentError('tool_result_too_large');
            isError = false;
          } catch {
            result = 'A ferramenta não concluiu a consulta. Não há resultado verificado.';
          } finally {
            clearTimeout(timer);
            if (cancel) cancelTools.delete(cancel);
            toolsActive--;
          }
        }
        if (toolIds.size > 128) { end('agent_tool_limit'); return; }
        if (!closed && call.expects_response !== false) {
          send({ type: 'client_tool_result', tool_call_id: id, result, is_error: isError });
        }
      };
      ws.on('open', () => {
        if (closed) return;
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
              resolve(session);
              break;
            }
            case 'audio': {
              if (!negotiated) throw new AgentError('audio_before_metadata');
              const audio = record(event.audio_event);
              const encoded = boundedString(audio.audio_base_64, Math.ceil(MAX_PCM_BYTES / 3) * 4);
              if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
                throw new AgentError('invalid_output_audio');
              }
              const pcm = Buffer.from(encoded, 'base64');
              if (pcm.length === 0 || pcm.length % 2 || pcm.length > MAX_PCM_BYTES) throw new AgentError('invalid_output_audio');
              const eventId = integer(audio.event_id);
              dispatch(() => options.callbacks.onAudio(pcm, eventId));
              break;
            }
            case 'ping':
              send({ type: 'pong', event_id: integer(record(event.ping_event).event_id) });
              break;
            case 'interruption':
              if (!negotiated) throw new AgentError('invalid_agent_event');
              dispatch(() => options.callbacks.onInterruption());
              break;
            case 'agent_response_complete':
              if (!negotiated) throw new AgentError('invalid_agent_event');
              integer(record(event.agent_response_complete_event).event_id);
              dispatch(() => options.callbacks.onResponseComplete());
              break;
            case 'client_tool_call':
              void runTool(record(event.client_tool_call)).catch(() => end('agent_tool_error'));
              break;
            case 'client_error': {
              const error = record(event.error_event);
              end(statusCode(typeof error.code === 'number' ? error.code : 0));
              break;
            }
            case 'queue_status':
              if (record(event.queue_status_event).status !== 'admitted') end('agent_concurrency_limit');
              break;
            // Text and transcripts are deliberately neither retained nor forwarded.
            case 'agent_response':
            case 'user_transcript':
            case 'tentative_user_transcript':
            case 'agent_response_correction':
            case 'agent_chat_response_part':
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
      ws.on('error', () => end('agent_transport_error'));
      ws.on('unexpected-response', (_request, response) => {
        response.resume();
        end(statusCode(response.statusCode ?? 0));
      });
      ws.on('close', () => {
        clearTimeout(closeTimer);
        end(negotiated ? undefined : 'agent_closed_before_metadata');
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  };
}
