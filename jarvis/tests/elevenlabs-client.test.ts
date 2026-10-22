import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentError, createAgentConnector,
  type AgentCallbacks, type AgentDependencies, type ConnectAgentOptions,
} from '../src/agents/elevenlabs-client.js';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  terminated = false;
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
});

describe('ElevenAgents adapter (protocol fixtures, not live Gate C)', () => {
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

  it('only requests a silent first message when explicitly enabled', async () => {
    const h = harness({ suppressFirstMessage: true });
    await h.connect();
    expect(h.socket.sent[0]).toHaveProperty('conversation_config_override.agent.first_message', '');
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

  it('forwards PCM, interruption and true completion while ignoring text transcripts', async () => {
    const h = harness();
    await h.connect();
    const pcm = Buffer.from([1, 0, 2, 0]);
    h.socket.message({ type: 'audio', audio_event: { audio_base_64: pcm.toString('base64'), event_id: 2 } });
    h.socket.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'private speech' } });
    h.socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'private answer' } });
    expect(h.callbacks.onResponseComplete).not.toHaveBeenCalled();
    h.socket.message({ type: 'interruption', interruption_event: { reason: 'user' } });
    h.socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: 2 } });
    expect(h.callbacks.onAudio).toHaveBeenCalledWith(pcm, 2);
    expect(h.callbacks.onInterruption).toHaveBeenCalledOnce();
    expect(h.callbacks.onResponseComplete).toHaveBeenCalledOnce();
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
    h.request.mockReset().mockImplementation(async () => new Response('private', { status: 429, headers: { 'retry-after': '99999' } }));
    await expect(h.connect()).rejects.toMatchObject({ code: 'agent_rate_limited' });
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.map(call => call[0])).toEqual([2000, 2000]);
    expect(h.createSocket).not.toHaveBeenCalled();
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
    expect(tool).toHaveBeenCalledExactlyOnceWith('search_game_info', { user_id: 'forged' });
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
});
