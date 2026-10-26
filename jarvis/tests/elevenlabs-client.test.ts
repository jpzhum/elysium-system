import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentError, createAgentConnector,
  type AgentCallbacks, type AgentDependencies, type ConnectAgentOptions,
} from '../src/agents/elevenlabs-client.js';
import { createGameSearch } from '../src/tools/game-search.js';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  terminated = false;
  paused = false;
  pause = vi.fn(() => { this.paused = true; });
  resume = vi.fn(() => { this.paused = false; });
  constructor() { super(); sockets.push(this); }
  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  }
  open(): void { this.readyState = 1; this.emit('open'); }
  message(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  close(): void { this.readyState = 3; this.emit('close'); }
  terminate(): void { this.terminated = true; this.close(); }
}

const metadata = {
  type: 'conversation_initiation_metadata',
  conversation_initiation_metadata_event: {
    conversation_id: 'conv_fixture', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000',
  },
};
const signedUrl = 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_fixture&conversation_signature=private-secret';

function harness(overrides: Partial<ConnectAgentOptions> = {}, automatic = true) {
  const socket = new FakeSocket();
  const callbacks: AgentCallbacks = {
    onAudio: vi.fn(), onResponseComplete: vi.fn(), onInterruption: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
  };
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ signed_url: signedUrl })));
  const createSocket = vi.fn(() => {
    if (automatic) queueMicrotask(() => { socket.open(); socket.message(metadata); });
    return socket as unknown as ReturnType<AgentDependencies['createSocket']>;
  });
  const sleep = vi.fn<AgentDependencies['sleep']>().mockResolvedValue(undefined);
  const connect = createAgentConnector({ fetch: request, createSocket, random: () => 0.5, sleep });
  const options: ConnectAgentOptions = {
    apiKey: 'api-secret', agentId: 'agent_fixture', dynamicVariables: { speaker_is_creator: false }, callbacks, ...overrides,
  };
  return { connect: () => connect(options), socket, callbacks, request, createSocket, sleep };
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ElevenAgents adapter (protocol fixtures, not live Gate C)', () => {
  it('failed close and terminate remain an explicit cleanup failure rather than a false released state', async () => {
    const h = harness(); const session = await h.connect();
    const close = vi.spyOn(h.socket, 'close').mockImplementation(() => { throw new Error('PRIVATE close'); });
    const terminate = vi.spyOn(h.socket, 'terminate').mockImplementation(() => { throw new Error('PRIVATE terminate'); });
    try {
      expect(() => session.close()).not.toThrow();
      expect(session.diagnosticState).toMatchObject({ cleanup_ok: false, websocket_state: 1 });
      expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    } finally { close.mockRestore(); terminate.mockRestore(); }
  });
  it('a close exception cannot orphan the socket or skip the close callback', async () => {
    const h = harness(); const diagnostic = vi.fn(); Object.assign(h.callbacks, { onDiagnostic: diagnostic });
    const session = await h.connect();
    vi.spyOn(h.socket, 'close').mockImplementationOnce(() => { throw Object.assign(new TypeError('PRIVATE close failure'), { code: 'ECONNRESET' }); });
    expect(() => session.close()).not.toThrow();
    expect(h.socket.terminated).toBe(true); expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ failure_scope: 'cleanup', cleanup_step: 'session_close',
      cleanup_ok: false, cause_name: 'TypeError', cause_code: 'ECONNRESET' }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('PRIVATE');
  });
  it('a late completion callback rejection cannot close a newer turn on a reused socket', async () => {
    const h = harness(); let turn = 'AAAABBBB'; let rejectComplete!: (error: Error) => void;
    const diagnostic = vi.fn();
    Object.assign(h.callbacks, { diagnosticContext: () => ({ turn_id: turn }), onDiagnostic: diagnostic });
    h.callbacks.onResponseComplete = () => new Promise<void>((_resolve, reject) => { rejectComplete = reject; });
    const session = await h.connect();
    h.socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 1 } });
    turn = 'CCCCDDDD'; session.sendText('PRIVATE next question');
    rejectComplete(new TypeError('PRIVATE previous callback'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    expect(h.callbacks.onClose).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ turn_id: 'AAAABBBB', cause_name: 'TypeError' }));
    expect(() => session.sendText('PRIVATE later question')).not.toThrow(); session.close();
  });
  it('a TCP resume exception is causal transport evidence rather than a later generic timeout', async () => {
    const h = harness();
    let accept!: () => void;
    const diagnostic = vi.fn(); Object.assign(h.callbacks, { onDiagnostic: diagnostic });
    let writes = 0;
    h.callbacks.onAudio = vi.fn(() => writes++ === 0 ? new Promise<void>(resolve => { accept = resolve; }) : undefined);
    await h.connect();
    h.socket.resume.mockImplementationOnce(() => { throw Object.assign(new TypeError('PRIVATE socket resume'), { code: 'ECONNRESET' }); });
    const pcm = Buffer.alloc(180_000, 1).toString('base64');
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: pcm, event_id: 1 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: pcm, event_id: 2 } });
    expect(h.socket.pause).toHaveBeenCalledOnce(); accept();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.callbacks.onError).toHaveBeenCalledWith('agent_transport_error');
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ cause_name: 'TypeError', cause_code: 'ECONNRESET' }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('PRIVATE');
    accept(); for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
  });
  it('separates signed URL, WebSocket and audio negotiation with monotonic content-free durations', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const onConnectionStage = vi.fn();
    const h = harness({ onConnectionStage }, false);
    h.request.mockImplementation(async () => {
      now = 1_200;
      return Response.json({ signed_url: signedUrl });
    });
    const pending = h.connect();
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
    now = 1_500;
    h.socket.open();
    now = 1_800;
    h.socket.message(metadata);
    await pending;
    expect(onConnectionStage.mock.calls.map(([event]) => event)).toEqual([
      { stage: 'signed_url', durationMs: 200 },
      { stage: 'websocket_handshake', durationMs: 300 },
      { stage: 'audio_negotiation', durationMs: 300 },
    ]);
    expect(JSON.stringify(onConnectionStage.mock.calls)).not.toContain('private-secret');
    expect(JSON.stringify(onConnectionStage.mock.calls)).not.toContain('conv_fixture');
    expect(JSON.stringify(onConnectionStage.mock.calls)).not.toContain('api-secret');
  });

  it('does not lose connectivity when a connection diagnostic consumer fails', async () => {
    const h = harness({ onConnectionStage: () => { throw new Error('private diagnostic failure'); } });
    const session = await h.connect();
    session.sendText('Pergunta de teste');
    expect(h.socket.sent.at(-1)).toEqual({ type: 'user_message', text: 'Pergunta de teste' });
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('keeps tool elapsed time correct when the system wall clock changes', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const onToolEvent = vi.fn();
    const h = harness({ onToolEvent, tools: async () => {
      now = 1_450;
      wall.mockReturnValue(9_000_000_000);
      return 'Resultado sintético';
    } });
    await h.connect();
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'search_game_info', tool_call_id: 'synthetic', parameters: {},
    } });
    await Promise.resolve();
    expect(onToolEvent).toHaveBeenLastCalledWith({ stage: 'completed', tool: 'search_game_info',
      waitForResponse: true, durationMs: 450 });
  });

  it('uses a fresh signed URL per session and sends trusted variables without API-key WS headers', async () => {
    const h = harness();
    const session = await h.connect();
    expect(session.inputSampleRate).toBe(16000);
    expect(session.outputSampleRate).toBe(24000);
    expect(String(h.request.mock.calls[0]?.[0])).toBe(
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_fixture',
    );
    expect(h.request.mock.calls[0]?.[1]).toMatchObject({ headers: { 'xi-api-key': 'api-secret' }, redirect: 'error' });
    expect(h.createSocket).toHaveBeenCalledWith(signedUrl);
    expect(h.socket.sent[0]).toMatchObject({
      type: 'conversation_initiation_client_data', dynamic_variables: { speaker_is_creator: false },
    });
    expect(h.socket.sent[0]).not.toHaveProperty('conversation_config_override');
    session.close();
    h.request.mockResolvedValueOnce(new Response(JSON.stringify({ signed_url: signedUrl })));
    await h.connect();
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('only requests a silent first message when explicitly enabled, without broad overrides', async () => {
    const h = harness({ suppressFirstMessage: true });
    await h.connect();
    expect(h.socket.sent[0]?.conversation_config_override).toEqual({ agent: { first_message: '' } });
    const disabled = harness({ suppressFirstMessage: false });
    await disabled.connect();
    expect(disabled.socket.sent[0]).not.toHaveProperty('conversation_config_override');
  });

  it.each(['client_error', 'error'])('sanitizes %s initiation rejection and never retries without the requested override', async type => {
    const h = harness({ suppressFirstMessage: true }, false);
    const pending = h.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_initiation_rejected' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalled());
    h.socket.open();
    h.socket.message({ type, error_event: {
      code: 422, error_type: 'private override details',
      message: 'private transcript; api-secret; first_message override not allowed',
    } });
    await rejected;
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_initiation_rejected');
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.createSocket).toHaveBeenCalledOnce();
    expect(h.socket.sent).toHaveLength(1);
    expect(h.socket.sent[0]?.conversation_config_override).toEqual({ agent: { first_message: '' } });
  });

  it('sanitizes a policy close before silent-session negotiation without reading its reason', async () => {
    const h = harness({ suppressFirstMessage: true }, false);
    const pending = h.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_initiation_rejected' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalled());
    h.socket.open();
    h.socket.readyState = 3;
    h.socket.emit('close', 1008, Buffer.from('private credential and transcript'));
    await rejected;
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_initiation_rejected');
    expect(h.request).toHaveBeenCalledOnce();
  });

  it('preserves authentication classification when silent-session initiation is denied with 403', async () => {
    const h = harness({ suppressFirstMessage: true }, false);
    const pending = h.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_authentication_failed' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalled());
    h.socket.open();
    h.socket.message({ type: 'client_error', error_event: { code: 403, message: 'private policy reason' } });
    await rejected;
  });

  it('waits for negotiated metadata and rejects unsupported formats before accepting audio', async () => {
    const h = harness({}, false);
    const pending = h.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'unsupported_audio_format' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalled());
    h.socket.open();
    h.socket.message({
      ...metadata,
      conversation_initiation_metadata_event: { ...metadata.conversation_initiation_metadata_event, agent_output_audio_format: 'ulaw_8000' },
    });
    await rejected;
    expect(h.callbacks.onAudio).not.toHaveBeenCalled();
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('sends documented PCM, text and context payloads and answers ping immediately', async () => {
    const h = harness();
    const session = await h.connect();
    const pcm = Buffer.from([1, 0, 2, 0]);
    session.sendAudio(pcm);
    session.sendText('Jarvis, ajuda.');
    session.sendContext('Jogo atual informado pelo usuário.');
    h.socket.message({ type: 'ping', ping_event: { event_id: 9 } });
    expect(h.socket.sent.slice(1)).toEqual([
      { user_audio_chunk: pcm.toString('base64') },
      { type: 'user_message', text: 'Jarvis, ajuda.' },
      { type: 'contextual_update', text: 'Jogo atual informado pelo usuário.' },
      { type: 'pong', event_id: 9 },
    ]);
    expect(() => session.sendAudio(Buffer.from([1]))).toThrow(AgentError);
  });

  it('forwards PCM, interruption and true completion without exposing transcript content', async () => {
    const h = harness();
    const received: Buffer[] = [];
    h.callbacks.onAudio = vi.fn(pcm => { received.push(Buffer.from(pcm)); });
    await h.connect();
    const pcm = Buffer.from([1, 0, 2, 0]);
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: pcm.toString('base64'), event_id: 2 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech' } });
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private answer' } });
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
    h.socket.message({ type: 'interruption', interruption_event: { reason: 'user' } });
    h.socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 2 } });
    expect(received).toEqual([pcm]);
    expect(h.callbacks.onAudio).toHaveBeenCalledWith(Buffer.alloc(pcm.length), 2);
    expect(h.callbacks.onInterruption).toHaveBeenCalledOnce();
    expect(h.callbacks.onResponseComplete).toHaveBeenCalledOnce();
  });

  it('signals finalized nonempty ASR utterances using only optional protocol identity', async () => {
    const h = harness();
    h.callbacks.onUserTranscript = vi.fn();
    await h.connect();
    h.socket.message({ type: 'user_transcript', user_transcription_event: {
      user_transcript: 'Jarvis, private speech never forwarded', event_id: 17, response_id: 'response_fixture',
      secret_metadata: 'not forwarded',
    } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'another private utterance' } });
    expect(h.callbacks.onUserTranscript).toHaveBeenNthCalledWith(1, { eventId: 17, responseId: 'response_fixture' });
    expect(h.callbacks.onUserTranscript).toHaveBeenNthCalledWith(2, {});
    expect(JSON.stringify(vi.mocked(h.callbacks.onUserTranscript).mock.calls)).not.toContain('private');
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('does not recognize an empty or tentative transcript as a user turn', async () => {
    const h = harness();
    h.callbacks.onUserTranscript = vi.fn();
    await h.connect();
    for (const user_transcript of ['', ' \n\t ']) {
      h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript } });
    }
    h.socket.message({ type: 'tentative_user_transcript', user_transcription_event: { user_transcript: 'private tentative speech' } });
    expect(h.callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('opts in to private final text in wire order without treating text as completed audio', async () => {
    const h = harness();
    const order: string[] = [];
    h.callbacks.onUserTranscript = vi.fn(() => { order.push('recognized'); });
    h.callbacks.onTextResponse = vi.fn(() => { order.push('response-marker'); });
    h.callbacks.onConversationText = vi.fn(event => { order.push(event.kind); });
    await h.connect();
    h.socket.message({ type: 'user_transcript', user_transcription_event: {
      user_transcript: 'Onde encontro a arma?', event_id: 8, response_id: 'user_8', secret_metadata: 'discard',
    } });
    h.socket.message({ type: 'agent_response', agent_response_event: {
      agent_response: 'Ela fica no castelo.', event_id: 9, response_id: 'answer_9', unrelated: 'discard',
    } });
    expect(order).toEqual(['recognized', 'user_final', 'response-marker', 'agent_final']);
    expect(h.callbacks.onConversationText).toHaveBeenNthCalledWith(1, {
      kind: 'user_final', text: 'Onde encontro a arma?', truncated: false, eventId: 8, responseId: 'user_8',
    });
    expect(h.callbacks.onConversationText).toHaveBeenNthCalledWith(2, {
      kind: 'agent_final', text: 'Ela fica no castelo.', truncated: false, eventId: 9, responseId: 'answer_9',
    });
    expect(h.callbacks.onUserTranscript).toHaveBeenCalledExactlyOnceWith({ eventId: 8, responseId: 'user_8' });
    expect(h.callbacks.onTextResponse).toHaveBeenCalledExactlyOnceWith({ eventId: 9, responseId: 'answer_9' });
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(h.callbacks.onConversationText).mock.calls)).not.toContain('discard');
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('keeps streaming, tentative and correction text distinct from final messages', async () => {
    const h = harness();
    h.callbacks.onConversationText = vi.fn();
    h.callbacks.onTextResponse = vi.fn();
    h.callbacks.onUserTranscript = vi.fn();
    await h.connect();
    h.socket.message({ type: 'tentative_user_transcript', user_transcription_event: { user_transcript: 'in progress' } });
    h.socket.message({ type: 'agent_chat_response_part', text_response_part: { type: 'delta', text: 'partial' } });
    h.socket.message({ type: 'agent_reasoning_response_part', text_response_part: { type: 'delta', text: 'internal' } });
    expect(h.callbacks.onConversationText).not.toHaveBeenCalled();
    expect(h.callbacks.onUserTranscript).not.toHaveBeenCalled();
    h.socket.message({ type: 'agent_response_correction', agent_response_correction_event: {
      original_agent_response: 'Never retain this original', corrected_agent_response: 'What was actually said.', event_id: 4,
    } });
    h.socket.message({ type: 'agent_response_correction', agent_response_correction_event: {
      original_agent_response: 'Interrupted entirely', corrected_agent_response: '', event_id: 5,
    } });
    expect(h.callbacks.onConversationText).toHaveBeenNthCalledWith(1, {
      kind: 'agent_correction', text: 'What was actually said.', truncated: false, eventId: 4,
    });
    expect(h.callbacks.onConversationText).toHaveBeenNthCalledWith(2, {
      kind: 'agent_correction', text: '', truncated: false, eventId: 5,
    });
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
    expect(h.callbacks.onTextResponse).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(h.callbacks.onConversationText).mock.calls)).not.toContain('original');
  });

  it.each(['user_transcript', 'agent_response', 'agent_response_correction'])(
    'bounds opted-in %s text by UTF-8 bytes without broken Unicode', async type => {
      const h = harness();
      h.callbacks.onConversationText = vi.fn();
      await h.connect();
      const text = 'a'.repeat(4094) + '🦾中文'.repeat(1000);
      const envelopes = {
        user_transcript: { user_transcription_event: { user_transcript: text } },
        agent_response: { agent_response_event: { agent_response: text } },
        agent_response_correction: { agent_response_correction_event: { corrected_agent_response: text } },
      };
      h.socket.message({ type, ...envelopes[type as keyof typeof envelopes] });
      const event = vi.mocked(h.callbacks.onConversationText).mock.calls[0]?.[0];
      expect(event).toMatchObject({ text: 'a'.repeat(4094), truncated: true });
      expect(Buffer.byteLength(event!.text)).toBeLessThanOrEqual(4096);
      expect(event!.text).not.toContain('�');
      expect(h.callbacks.onError).not.toHaveBeenCalled();
    },
  );

  it('bounds retained private text behind slow PCM and discards all text on backpressure', async () => {
    let accept: (() => void) | undefined;
    const h = harness();
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
    h.callbacks.onConversationText = vi.fn();
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AQA=', event_id: 1 } });
    for (let i = 0; i < 17; i++) {
      h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'x'.repeat(4096), event_id: 2 } });
    }
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_audio_backpressure');
    accept?.();
    await Promise.resolve();
    expect(h.callbacks.onConversationText).not.toHaveBeenCalled();
  });

  it('delivers private text only after prior PCM, with ping still immediate', async () => {
    let accept: (() => void) | undefined;
    const order: string[] = [];
    const h = harness();
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
    h.callbacks.onUserTranscript = vi.fn(() => { order.push('recognized'); });
    h.callbacks.onTextResponse = vi.fn(() => { order.push('text'); });
    h.callbacks.onConversationText = vi.fn(event => { order.push(event.kind); });
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AQA=', event_id: 1 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private question' } });
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private answer' } });
    h.socket.message({ type: 'ping', ping_event: { event_id: 2 } });
    expect(order).toEqual([]);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'pong', event_id: 2 });
    accept?.();
    await vi.waitFor(() => expect(order).toEqual(['recognized', 'user_final', 'text', 'agent_final']));
  });

  it('does not deliver private content when the recognition marker revokes consent', async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    h.callbacks.onUserTranscript = vi.fn(() => { controller.abort(); });
    h.callbacks.onConversationText = vi.fn();
    await h.connect();
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech' } });
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'late private answer' } });
    expect(h.callbacks.onUserTranscript).toHaveBeenCalledOnce();
    expect(h.callbacks.onConversationText).not.toHaveBeenCalled();
  });

  it('sanitizes private-text callback failures and malformed correction envelopes', async () => {
    const h = harness();
    h.callbacks.onConversationText = vi.fn(() => { throw new Error('private question and answer'); });
    await h.connect();
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private answer' } });
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_callback_error');
    const bad = harness();
    bad.callbacks.onConversationText = vi.fn();
    await bad.connect();
    bad.socket.message({ type: 'agent_response_correction', agent_response_correction_event: {
      corrected_agent_response: { message: 'private answer' },
    } });
    expect(bad.callbacks.onConversationText).not.toHaveBeenCalled();
    expect(bad.callbacks.onError).toHaveBeenCalledExactlyOnceWith('invalid_agent_event');
  });

  it.each([
    { type: 'user_transcript' },
    { type: 'user_transcript', user_transcription_event: [] },
    { type: 'user_transcript', user_transcription_event: { user_transcript: 1 } },
    { type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech', event_id: -1 } },
  ])('rejects malformed final ASR envelopes without forwarding content', async event => {
    const h = harness();
    h.callbacks.onUserTranscript = vi.fn();
    await h.connect();
    h.socket.message(event);
    expect(h.callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('invalid_agent_event');
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('preserves greeting, recognized user turn and answer wire order during async acceptance', async () => {
    let accept: (() => void) | undefined;
    const order: string[] = [];
    const h = harness();
    h.callbacks.onAudio = vi.fn(pcm => {
      order.push(`audio_${pcm[0]}`);
      if (pcm[0] === 1) return new Promise<void>(resolve => { accept = resolve; });
    });
    h.callbacks.onUserTranscript = vi.fn(() => { order.push('recognized'); });
    h.callbacks.onTextResponse = vi.fn(identity => { order.push(`text_${identity?.eventId}`); });
    await h.connect();
    for (const byte of [1, 2]) {
      h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([byte, 0]).toString('base64'), event_id: 5 } });
    }
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private greeting', event_id: 5 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech', event_id: 6 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([3, 0]).toString('base64'), event_id: 7 } });
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private answer', event_id: 7 } });
    h.socket.message({ type: 'agent_chat_response_part', text_response_part: { type: 'delta', text: 'private continued answer', event_id: 8 } });
    expect(order).toEqual(['audio_1']);
    accept?.();
    await vi.waitFor(() => expect(order).toEqual(['audio_1', 'audio_2', 'text_5', 'recognized', 'audio_3', 'text_7', 'text_8']));
  });

  it('ignores late final ASR after revocation and sanitizes recognition callback failures', async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    h.callbacks.onUserTranscript = vi.fn();
    await h.connect();
    controller.abort();
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech' } });
    expect(h.callbacks.onUserTranscript).not.toHaveBeenCalled();
    const broken = harness();
    broken.callbacks.onUserTranscript = vi.fn(() => { throw new Error('private callback speech'); });
    await broken.connect();
    broken.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech' } });
    expect(broken.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_callback_error');
  });

  it.each([401, 402, 403])('does not retry HTTP %s and sanitizes the upstream body', async status => {
    const h = harness();
    h.request.mockResolvedValueOnce(new Response('api-secret and private speech', { status }));
    await expect(h.connect()).rejects.toSatisfy((error: unknown) =>
      error instanceof AgentError && !error.message.includes('secret') && !error.message.includes('speech'));
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it('retries transient HTTP failures with bounded delays and at most three requests', async () => {
    const h = harness();
    h.request.mockReset().mockImplementation(async () => new Response('private', { status: 429, headers: { 'retry-after': '2' } }));
    await expect(h.connect()).rejects.toMatchObject({ code: 'agent_rate_limited' });
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.map(call => call[0])).toEqual([2000, 2000]);
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it.each([429, 503])('does not shorten a long Retry-After or retry HTTP %s before the requested time', async status => {
    const h = harness();
    h.request.mockResolvedValueOnce(new Response('private', { status, headers: { 'retry-after': '99999' } }));
    await expect(h.connect()).rejects.toMatchObject({ code: status === 429 ? 'agent_rate_limited' : 'agent_unavailable' });
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it.each([1, 60])('honors an HTTP-date Retry-After %s seconds ahead without extending the delay ceiling', async seconds => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1));
    const h = harness();
    h.request.mockResolvedValueOnce(new Response('private', { status: 429, headers: {
      'retry-after': new Date(Date.now() + seconds * 1000).toUTCString(),
    } }));
    if (seconds <= 2) {
      await h.connect();
      expect(h.sleep).toHaveBeenCalledExactlyOnceWith(seconds * 1000, undefined);
      expect(h.request).toHaveBeenCalledTimes(2);
    } else {
      await expect(h.connect()).rejects.toMatchObject({ code: 'agent_rate_limited' });
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.sleep).not.toHaveBeenCalled();
    }
  });

  it.each([
    'wss://api.elevenlabs.io.attacker.invalid/v1/convai/conversation?agent_id=agent_fixture&token=secret',
    'ws://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_fixture&token=secret',
    'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=someone_else&token=secret',
    'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_fixture',
  ])('rejects unsigned, mismatched or unsafe signed URLs', async url => {
    const h = harness();
    h.request.mockResolvedValueOnce(new Response(JSON.stringify({ signed_url: url })));
    await expect(h.connect()).rejects.toMatchObject({ code: 'invalid_signed_url' });
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it('sanitizes tool failures, deduplicates calls and passes parameters only to the trusted tool closure', async () => {
    const tool = vi.fn(async (_name: string, _parameters: unknown) => { throw new Error('credential-secret'); });
    const h = harness({ tools: tool });
    await h.connect();
    const call = {
      type: 'client_tool_call',
      client_tool_call: { tool_name: 'search_game_info', tool_call_id: 'call_1', parameters: { user_id: 'forged' }, expects_response: true },
    };
    h.socket.message(call);
    h.socket.message(call);
    await vi.waitFor(() => expect(h.socket.sent.at(-1)).toMatchObject({
      type: 'client_tool_result', tool_call_id: 'call_1', is_error: true,
    }));
    expect(tool).toHaveBeenCalledExactlyOnceWith('search_game_info', { user_id: 'forged' }, expect.any(AbortSignal));
    expect(JSON.stringify(h.socket.sent)).not.toContain('credential-secret');
  });

  it('returns a serialized real tool result', async () => {
    const h = harness({ tools: async () => ({ sources: [], uncertainty: 'Sem chave.' }) });
    await h.connect();
    h.socket.message({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_game_info', tool_call_id: 'read_1', parameters: {} } });
    await vi.waitFor(() => expect(h.socket.sent.at(-1)).toMatchObject({
      type: 'client_tool_result', tool_call_id: 'read_1', is_error: false,
      result: JSON.stringify({ sources: [], uncertainty: 'Sem chave.' }),
    }));
  });

  it('executes the real search backend from client_tool_call and returns attributed sources over the protocol', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ web: { results: [
      { title: 'Guide', url: 'https://example.com/guide', description: 'An attributed source excerpt.' },
    ] } })));
    vi.stubGlobal('fetch', request);
    const search = createGameSearch({ apiKey: 'search-key-secret' });
    const h = harness({ tools: async (name, parameters, signal) => {
      if (name !== 'search_game_info') throw new Error('denied');
      const args = parameters as { game: string; query: string };
      return search(args.game, args.query, signal);
    } });
    await h.connect();
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'search_game_info', tool_call_id: 'search_fixture',
      parameters: { game: 'Game', query: 'Quest location' }, expects_response: true,
    } });
    await vi.waitFor(() => expect(h.socket.sent).toHaveLength(2));
    const result = h.socket.sent[1];
    expect(result).toMatchObject({ type: 'client_tool_result', tool_call_id: 'search_fixture', is_error: false });
    expect(JSON.parse(String(result?.result))).toMatchObject({ status: 'success', sources: [
      { title: 'Guide', url: 'https://example.com/guide', snippet: 'An attributed source excerpt.' },
    ] });
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toContain('https://api.search.brave.com/res/v1/web/search?');
    expect(JSON.stringify(h.socket.sent)).not.toContain('search-key-secret');
  });

  it('reports sanitized client-tool stages without copying untrusted names, parameters or results', async () => {
    const diagnostics = vi.fn();
    const h = harness({ onToolEvent: diagnostics, tools: async () => ({ answer: 'private-result' }) });
    await h.connect();
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'search_game_info', tool_call_id: 'private-call-id',
      parameters: { game: 'private-game', query: 'private-query' }, expects_response: true,
    } });
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(3));
    expect(diagnostics.mock.calls.map(([value]) => value)).toEqual([
      { stage: 'received', tool: 'search_game_info', waitForResponse: true },
      { stage: 'started', tool: 'search_game_info', waitForResponse: true },
      { stage: 'completed', tool: 'search_game_info', waitForResponse: true, durationMs: expect.any(Number) },
    ]);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private');
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'private-secret-name', tool_call_id: 'next', parameters: {}, expects_response: false,
    } });
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(6));
    expect(diagnostics.mock.calls[3]?.[0]).toEqual({ stage: 'received', tool: 'unknown', waitForResponse: false });
    expect(h.socket.sent).toHaveLength(2); // No result packet when Wait for response is false.
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private');
  });

  it('aborts an individual tool on timeout and never forwards its late result', async () => {
    const diagnostics = vi.fn();
    let signal: AbortSignal | undefined;
    let finish: ((value: unknown) => void) | undefined;
    const h = harness({ onToolEvent: diagnostics, tools: (_name, _parameters, toolSignal) => {
      signal = toolSignal;
      return new Promise<unknown>(resolve => { finish = resolve; });
    } });
    await h.connect();
    vi.useFakeTimers();
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'search_game_info', tool_call_id: 'timeout', parameters: {}, expects_response: true,
    } });
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(signal?.aborted).toBe(true);
    expect(diagnostics).toHaveBeenLastCalledWith({ stage: 'failed', tool: 'search_game_info',
      waitForResponse: true, durationMs: 8000, code: 'TOOL_TIMEOUT' });
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'client_tool_result', is_error: true });
    finish?.('private late result');
    await Promise.resolve();
    expect(h.socket.sent).toHaveLength(2);
    expect(JSON.stringify(h.socket.sent)).not.toContain('private late result');
  });

  it('aborts backend tool requests on session close and sanitizes cancellation diagnostics', async () => {
    let signal: AbortSignal | undefined;
    const diagnostics = vi.fn();
    const h = harness({ onToolEvent: diagnostics, tools: (_name, _parameters, toolSignal) => {
      signal = toolSignal;
      return new Promise<never>(() => { /* The backend request is pending until cancellation. */ });
    } });
    const session = await h.connect();
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'get_voice_participants', tool_call_id: 'cancelled', parameters: {},
    } });
    session.close();
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(3));
    expect(signal?.aborted).toBe(true);
    expect(diagnostics).toHaveBeenLastCalledWith({ stage: 'failed', tool: 'get_voice_participants',
      waitForResponse: true, durationMs: expect.any(Number), code: 'TOOL_CANCELLED' });
    expect(h.socket.sent).toHaveLength(1);
  });

  it('orders a voice client tool after final ASR behind a pending greeting write without blocking later audio', async () => {
    let releaseGreeting: (() => void) | undefined;
    let finishTool: ((result: unknown) => void) | undefined;
    let recognized = false;
    const tool = vi.fn((_name: string, _parameters: unknown, _signal: AbortSignal) => {
      if (!recognized) throw new Error('voice_turn_not_recognized');
      return new Promise<unknown>(resolve => { finishTool = resolve; });
    });
    const h = harness({ tools: tool });
    h.callbacks.onAudio = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { releaseGreeting = resolve; }));
    h.callbacks.onUserTranscript = vi.fn(() => { recognized = true; });
    h.callbacks.onToolActivity = vi.fn();
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(320).toString('base64'), event_id: 1 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private question', event_id: 2 } });
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'get_voice_participants', tool_call_id: 'ordered', parameters: {}, expects_response: true,
    } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(320).toString('base64'), event_id: 3 } });
    expect(h.callbacks.onToolActivity).toHaveBeenLastCalledWith(1); // Recovery sees the queued tool immediately.
    expect(recognized).toBe(false);
    expect(tool).not.toHaveBeenCalled();
    releaseGreeting?.();
    await vi.waitFor(() => expect(tool).toHaveBeenCalledOnce());
    expect(recognized).toBe(true);
    expect(h.callbacks.onAudio).toHaveBeenCalledTimes(2); // No wait for the tool's network operation.
    finishTool?.({ available: true, participants: [] });
    await vi.waitFor(() => expect(h.socket.sent.at(-1)).toMatchObject({
      type: 'client_tool_result', tool_call_id: 'ordered', is_error: false,
    }));
    expect(h.callbacks.onToolActivity).toHaveBeenLastCalledWith(0);
  });

  it('does not execute a queued voice search after revocation while its ASR marker is waiting', async () => {
    let release: (() => void) | undefined;
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', request);
    const search = createGameSearch({ apiKey: 'search-key-secret' });
    const tools = vi.fn((_name: string, _parameters: unknown, signal: AbortSignal) => search('Game', 'Quest', signal));
    const abort = new AbortController();
    const h = harness({ signal: abort.signal, tools });
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    h.callbacks.onUserTranscript = vi.fn();
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(320).toString('base64'), event_id: 1 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private question' } });
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'search_game_info', tool_call_id: 'cancelled_before_start', parameters: { game: 'Game', query: 'Quest' },
    } });
    abort.abort();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(h.socket.sent).toHaveLength(1);
  });

  it('starts the tool deadline at wire reception and never executes an expired queued marker', async () => {
    let release: (() => void) | undefined;
    const tool = vi.fn(async () => 'late result');
    const diagnostics = vi.fn();
    const h = harness({ tools: tool, onToolEvent: diagnostics });
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    h.callbacks.onToolActivity = vi.fn();
    await h.connect();
    vi.useFakeTimers();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(320).toString('base64'), event_id: 1 } });
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'search_game_info', tool_call_id: 'queued_timeout', parameters: {},
    } });
    await vi.advanceTimersByTimeAsync(8000);
    expect(tool).not.toHaveBeenCalled();
    expect(h.callbacks.onToolActivity).toHaveBeenLastCalledWith(0);
    expect(diagnostics).toHaveBeenLastCalledWith({ stage: 'failed', tool: 'search_game_info',
      waitForResponse: true, code: 'TOOL_TIMEOUT', durationMs: 8000 });
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'client_tool_result', is_error: true });
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(tool).not.toHaveBeenCalled();
    expect(h.socket.sent).toHaveLength(2);
  });

  it('bounds tool parameters and validates the wait flag before retaining an ordered marker', async () => {
    for (const invalid of [{ parameters: { query: 'x'.repeat(4097) } }, { expects_response: 'yes' }]) {
      const tool = vi.fn(async () => 'unused');
      const h = harness({ tools: tool });
      await h.connect();
      h.socket.message({ type: 'client_tool_call', client_tool_call: {
        tool_name: 'search_game_info', tool_call_id: 'invalid', ...invalid,
      } });
      expect(tool).not.toHaveBeenCalled();
      expect(h.callbacks.onError).toHaveBeenCalledOnce();
      expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    }
  });

  it('cancels an interrupted queued tool while preserving finalized ASR and handling ping independently', async () => {
    let release: (() => void) | undefined;
    const tools = vi.fn(async () => 'must not run');
    const h = harness({ tools });
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    h.callbacks.onUserTranscript = vi.fn();
    h.callbacks.onToolActivity = vi.fn();
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(320).toString('base64'), event_id: 1 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private question' } });
    h.socket.message({ type: 'client_tool_call', client_tool_call: {
      tool_name: 'get_voice_participants', tool_call_id: 'interrupted', parameters: {},
    } });
    h.socket.message({ type: 'ping', ping_event: { event_id: 7 } });
    expect(h.socket.sent.at(-1)).toEqual({ type: 'pong', event_id: 7 });
    h.socket.message({ type: 'interruption', interruption_event: { event_id: 8 } });
    expect(h.callbacks.onInterruption).toHaveBeenCalledOnce();
    expect(h.callbacks.onToolActivity).toHaveBeenLastCalledWith(0);
    release?.();
    await vi.waitFor(() => expect(h.callbacks.onUserTranscript).toHaveBeenCalledOnce());
    expect(tools).not.toHaveBeenCalled();
    expect(h.socket.sent).toHaveLength(2);
  });

  it('fails closed on malformed output and backpressure', async () => {
    const h = harness();
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'not base64!', event_id: 1 } });
    expect(h.callbacks.onError).toHaveBeenCalledWith('invalid_output_audio');
    const busy = harness();
    const session = await busy.connect();
    busy.socket.bufferedAmount = 512 * 1024;
    expect(() => session.sendText('pergunta')).toThrowError('agent_backpressure');
    expect(busy.callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('aborts promptly without leaking close reasons and rejects events after close', async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const session = await h.connect();
    controller.abort();
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    expect(() => session.sendText('pergunta')).toThrowError('agent_closed');
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAAA', event_id: 4 } });
    expect(h.callbacks.onAudio).not.toHaveBeenCalled();
  });

  it('ignores remote client-error text', async () => {
    const h = harness({}, false);
    const pending = h.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_credit_limit' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalled());
    h.socket.open();
    h.socket.message({ type: 'client_error', error_event: { code: 402, error_name: 'private', message: 'api-secret' } });
    await rejected;
    expect(h.callbacks.onError).toHaveBeenCalledWith('agent_credit_limit');
  });

  it('times out missing metadata and rejects an unnegotiated session', async () => {
    vi.useFakeTimers();
    const h = harness({}, false);
    const pending = h.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_metadata_timeout' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalled());
    h.socket.open();
    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('limits tool concurrency and cleans pending calls when the session closes', async () => {
    const tool = vi.fn(() => new Promise<never>(() => { /* Intentionally pending tool. */ }));
    const h = harness({ tools: tool });
    const session = await h.connect();
    for (const id of ['one', 'two', 'three']) {
      h.socket.message({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_game_info', tool_call_id: id, parameters: {} } });
    }
    expect(tool).toHaveBeenCalledTimes(2);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'client_tool_result', tool_call_id: 'three', is_error: true });
    session.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.socket.sent).toHaveLength(2);
  });

  it('cancels a signed-URL body that stalls after headers when consent is revoked', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn(() => new Promise<void>(() => { /* Uncooperative upstream cancellation. */ }));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    const h = harness({ signal: controller.signal });
    h.request.mockResolvedValueOnce(response);
    const pending = h.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_aborted' });
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    controller.abort();
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it('enforces a streamed byte limit without trusting content-length', async () => {
    const cancelled = vi.fn();
    const h = harness();
    h.request.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(10_000));
        stream.enqueue(new Uint8Array(10_000));
      },
      cancel: cancelled,
    })));
    await expect(h.connect()).rejects.toMatchObject({ code: 'invalid_agent_reply' });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it('never forwards a pending tool result after abort, even when it later completes', async () => {
    let finish: ((value: string) => void) | undefined;
    const controller = new AbortController();
    const h = harness({ signal: controller.signal, tools: () => new Promise<string>(resolve => { finish = resolve; }) });
    await h.connect();
    h.socket.message({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_game_info', tool_call_id: 'pending', parameters: {} } });
    expect(finish).toBeTypeOf('function');
    controller.abort();
    finish?.('private answer that must be discarded');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.socket.sent).toHaveLength(1);
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('sanitizes callback exceptions and repeated remote client errors without any logging', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const h = harness();
    h.callbacks.onAudio = vi.fn(() => { throw new AgentError('api-secret callback text'); });
    h.callbacks.onClose = vi.fn(() => { throw new Error('private close error'); });
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 1 } });
    for (let index = 0; index < 10; index++) {
      h.socket.message({ type: 'client_error', error_event: { code: 401, message: 'private upstream secret' } });
    }
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_callback_error');
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('rejects incomplete metadata and unsolicited audio before negotiation', async () => {
    for (const event of [
      { ...metadata, conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000' } },
      { type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 1 } },
    ]) {
      const h = harness({}, false);
      const pending = h.connect();
      const rejected = expect(pending).rejects.toBeInstanceOf(AgentError);
      await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalled());
      h.socket.open();
      h.socket.message(event);
      await rejected;
      expect(h.callbacks.onAudio).not.toHaveBeenCalled();
    }
  });

  it('bounds repeated tool requests before they can cause an unbounded loop', async () => {
    const tool = vi.fn(() => new Promise<never>(() => { /* Keep both allowed calls busy. */ }));
    const h = harness({ tools: tool });
    await h.connect();
    for (let index = 0; index < 150; index++) {
      h.socket.message({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_game_info', tool_call_id: `call_${index}`, parameters: {} } });
    }
    expect(tool).toHaveBeenCalledTimes(2);
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_tool_limit');
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.socket.sent.length).toBeLessThanOrEqual(129);
  });

  it('handles a synchronous tool that revokes its session and throws without orphaned rejections', async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal, tools: () => {
      controller.abort();
      throw new Error('private synchronous failure');
    } });
    await h.connect();
    h.socket.message({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_game_info', tool_call_id: 'sync', parameters: {} } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.socket.sent).toHaveLength(1);
  });

  it('accepts every audio chunk with the same event ID before any completion event', async () => {
    const h = harness();
    const received: Buffer[] = [];
    h.callbacks.onAudio = vi.fn(pcm => { received.push(Buffer.from(pcm)); });
    await h.connect();
    for (let index = 0; index < 30; index++) {
      h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([index, 0]).toString('base64'), event_id: 5 } });
    }
    expect(h.callbacks.onAudio).toHaveBeenCalledTimes(30);
    expect(received).toEqual(Array.from({ length: 30 }, (_, index) => Buffer.from([index, 0])));
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
  });

  it('serializes async audio acceptance, delays completion behind received audio and still answers ping', async () => {
    let accept: (() => void) | undefined;
    const order: string[] = [];
    const h = harness();
    h.callbacks.onAudio = vi.fn(pcm => {
      order.push(`audio_${pcm[0]}`);
      if (pcm[0] === 1) return new Promise<void>(resolve => { accept = resolve; });
    });
    h.callbacks.onResponseComplete = vi.fn(() => { order.push('complete'); });
    await h.connect();
    for (const byte of [1, 2]) {
      h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([byte, 0]).toString('base64'), event_id: 5 } });
    }
    h.socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 5 } });
    h.socket.message({ type: 'ping', ping_event: { event_id: 99 } });
    expect(order).toEqual(['audio_1']);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'pong', event_id: 99 });
    accept?.();
    await vi.waitFor(() => expect(order).toEqual(['audio_1', 'audio_2', 'complete']));
  });

  it('does not make completion callback promises block a later message', async () => {
    const h = harness();
    h.callbacks.onResponseComplete = vi.fn(() => new Promise<void>(() => { /* Turn bookkeeping can wait independently. */ }));
    await h.connect();
    h.socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 5 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 6 } });
    expect(h.callbacks.onAudio).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(2), 6);
  });

  it('pauses ingress at its high water mark and resumes after bounded writes are accepted', async () => {
    let accept: (() => void) | undefined;
    const h = harness();
    h.callbacks.onAudio = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
    await h.connect();
    const encoded = Buffer.alloc(192_000).toString('base64');
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: encoded, event_id: 5 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: encoded, event_id: 5 } });
    expect(h.socket.pause).toHaveBeenCalledOnce();
    expect(h.socket.paused).toBe(true);
    expect(h.callbacks.onAudio).toHaveBeenCalledOnce();
    accept?.();
    await vi.waitFor(() => expect(h.socket.resume).toHaveBeenCalledOnce());
    expect(h.callbacks.onAudio).toHaveBeenCalledTimes(2);
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('fails closed when a peer exceeds the hard ingress byte bound despite pausing', async () => {
    const h = harness();
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(() => { /* Slow consumer. */ }));
    await h.connect();
    const encoded = Buffer.alloc(192_000).toString('base64');
    for (let index = 0; index < 3; index++) h.socket.message({ type: 'audio', audio_event: { audio_base_64: encoded, event_id: 5 } });
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_audio_backpressure');
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.callbacks.onAudio).toHaveBeenCalledOnce();
  });

  it('bounds queued event objects as well as PCM bytes', async () => {
    const h = harness();
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(() => { /* Slow consumer. */ }));
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 5 } });
    for (let index = 0; index < 1_025; index++) {
      h.socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 5 } });
    }
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_audio_backpressure');
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
  });

  it('does not mistake locally paused ingress for a dead provider and restarts heartbeat after resume', async () => {
    vi.useFakeTimers();
    let accept: (() => void) | undefined;
    const h = harness();
    h.callbacks.onAudio = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
    await h.connect();
    const encoded = Buffer.alloc(192_000).toString('base64');
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: encoded, event_id: 5 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: encoded, event_id: 5 } });
    expect(h.socket.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    expect(h.callbacks.onClose).not.toHaveBeenCalled();
    accept?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.socket.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_heartbeat_timeout');
  });

  it('drains previously received valid PCM on heartbeat failure without confirming generation', async () => {
    vi.useFakeTimers();
    let accept: (() => void) | undefined;
    const received: Buffer[] = [];
    const h = harness();
    h.callbacks.onAudio = vi.fn(pcm => {
      received.push(Buffer.from(pcm));
      if (received.length === 1) return new Promise<void>(resolve => { accept = resolve; });
    });
    await h.connect();
    for (const value of [1, 2]) {
      h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([value, 0]).toString('base64'), event_id: 5 } });
    }
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_heartbeat_timeout');
    expect(h.callbacks.onClose).not.toHaveBeenCalled();
    accept?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([Buffer.from([1, 0]), Buffer.from([2, 0])]);
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
  });

  it.each(['remote_close', 'local_drain', 'transport_error'] as const)('drains valid received audio on %s without inventing completion', async kind => {
    let accept: (() => void) | undefined;
    const h = harness();
    const received: Buffer[] = [];
    h.callbacks.onAudio = vi.fn(pcm => {
      received.push(Buffer.from(pcm));
      if (received.length === 1) return new Promise<void>(resolve => { accept = resolve; });
    });
    const session = await h.connect();
    for (const byte of [1, 2]) h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([byte, 0]).toString('base64'), event_id: 7 } });
    if (kind === 'remote_close') h.socket.close();
    else if (kind === 'local_drain') session.close({ drainAudio: true });
    else h.socket.emit('error', new Error('credential-secret'));
    expect(h.callbacks.onClose).not.toHaveBeenCalled();
    expect(h.callbacks.onError).toHaveBeenCalledTimes(kind === 'transport_error' ? 1 : 0);
    accept?.();
    await vi.waitFor(() => expect(h.callbacks.onClose).toHaveBeenCalledOnce());
    expect(received).toEqual([Buffer.from([1, 0]), Buffer.from([2, 0])]);
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
  });

  it('revocation cancels queued PCM and suppresses a secondary rejected write while transport is draining', async () => {
    let rejectWrite: ((reason: unknown) => void) | undefined;
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    h.callbacks.onAudio = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject; }));
    const session = await h.connect();
    for (let index = 0; index < 2; index++) h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 7 } });
    session.close({ drainAudio: true });
    controller.abort();
    rejectWrite?.(new Error('private cancelled write'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.callbacks.onAudio).toHaveBeenCalledOnce();
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('cancels queued audio on interruption and filters stale event IDs using the SDK interruption boundary', async () => {
    let accept: (() => void) | undefined;
    const h = harness();
    h.callbacks.onAudio = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
    await h.connect();
    for (const byte of [1, 2]) h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([byte, 0]).toString('base64'), event_id: 5 } });
    h.socket.message({ type: 'interruption', interruption_event: { event_id: 6 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 5 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 6 } });
    accept?.();
    await vi.waitFor(() => expect(h.callbacks.onAudio).toHaveBeenCalledTimes(2));
    expect(h.callbacks.onAudio).toHaveBeenLastCalledWith(Buffer.alloc(2), 6);
    expect(h.callbacks.onInterruption).toHaveBeenCalledOnce();
  });

  it('preserves final user recognition when an interruption discards queued greeting output', async () => {
    let accept: (() => void) | undefined;
    let borrowed: Buffer | undefined;
    const order: string[] = [];
    const h = harness();
    h.callbacks.onAudio = vi.fn(pcm => {
      order.push(`audio_${pcm[0]}`);
      if (pcm[0] === 1) {
        borrowed = pcm;
        return new Promise<void>(resolve => { accept = resolve; });
      }
    });
    h.callbacks.onUserTranscript = vi.fn(identity => { order.push(`recognized_${identity?.eventId}`); });
    h.callbacks.onInterruption = vi.fn(() => { order.push('interruption'); });
    h.callbacks.onTextResponse = vi.fn();
    await h.connect();
    for (const byte of [1, 2]) {
      h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([byte, 0]).toString('base64'), event_id: 5 } });
    }
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech', event_id: 6 } });
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private greeting', event_id: 5 } });
    h.socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 5 } });
    h.socket.message({ type: 'interruption', interruption_event: { event_id: 6 } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: Buffer.from([3, 0]).toString('base64'), event_id: 7 } });
    expect(order).toEqual(['audio_1', 'interruption']);
    expect(borrowed).toEqual(Buffer.from([1, 0]));
    accept?.();
    await vi.waitFor(() => expect(order).toEqual(['audio_1', 'interruption', 'recognized_6', 'audio_3']));
    expect(borrowed).toEqual(Buffer.alloc(2));
    expect(h.callbacks.onTextResponse).not.toHaveBeenCalled();
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('discards preserved ASR markers when the interruption callback revokes the session', async () => {
    let accept: (() => void) | undefined;
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    h.callbacks.onAudio = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
    h.callbacks.onUserTranscript = vi.fn();
    h.callbacks.onInterruption = vi.fn(() => { controller.abort(); });
    await h.connect();
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AQA=', event_id: 5 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech', event_id: 6 } });
    h.socket.message({ type: 'interruption', interruption_event: { event_id: 6 } });
    accept?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.callbacks.onInterruption).toHaveBeenCalledOnce();
    expect(h.callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(h.callbacks.onClose).toHaveBeenCalledOnce();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it('forwards content-free message identities and documented tool activity without sensitive payloads', async () => {
    const h = harness();
    h.callbacks.onTextResponse = vi.fn();
    h.callbacks.onToolActivity = vi.fn();
    await h.connect();
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private text', event_id: 5, response_id: 'message_1' } });
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 5, response_id: 'message_1' } });
    h.socket.message({ type: 'agent_tool_request', agent_tool_request: { tool_call_id: 'tool_1', parameters: { private: 'secret' } } });
    h.socket.message({ type: 'mcp_tool_call', mcp_tool_call: { tool_call_id: 'tool_2', state: 'awaiting_approval' } });
    h.socket.message({ type: 'agent_tool_response_full_payload', agent_tool_response_full_payload: { tool_call_id: 'tool_1', full_tool_result: 'private result' } });
    h.socket.message({ type: 'mcp_tool_call', mcp_tool_call: { tool_call_id: 'tool_2', state: 'success', result: ['private result'] } });
    expect(h.callbacks.onTextResponse).toHaveBeenCalledExactlyOnceWith({ eventId: 5, responseId: 'message_1' });
    expect(h.callbacks.onAudio).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(2), 5, { responseId: 'message_1' });
    expect(vi.mocked(h.callbacks.onToolActivity).mock.calls).toEqual([[1], [2], [1], [0]]);
    expect(JSON.stringify(vi.mocked(h.callbacks.onTextResponse).mock.calls)).not.toContain('private');
  });

  it('sanitizes asynchronous audio and completion callback rejections', async () => {
    for (const kind of ['audio', 'complete']) {
      const h = harness();
      if (kind === 'audio') h.callbacks.onAudio = vi.fn(async () => { throw new Error('private audio secret'); });
      else h.callbacks.onResponseComplete = vi.fn(async () => { throw new Error('private completion secret'); });
      await h.connect();
      h.socket.message(kind === 'audio'
        ? { type: 'audio', audio_event: { audio_base_64: 'AAA=', event_id: 5 } }
        : { type: 'agent_response_complete', agent_response_complete_event: { event_id: 5 } });
      await vi.waitFor(() => expect(h.callbacks.onError).toHaveBeenCalledExactlyOnceWith('agent_callback_error'));
    }
  });
});
