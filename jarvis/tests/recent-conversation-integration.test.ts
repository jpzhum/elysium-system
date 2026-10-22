import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAgentConnector, type AgentDependencies } from '../src/agents/elevenlabs-client.js';
import { RecentConversation } from '../src/agents/recent-conversation.js';
import { SessionManager, type DeliveredTurn, type Playback } from '../src/agents/session-manager.js';
import { ConsentStore } from '../src/policy/consent.js';
import { speakerContext, type SpeakerContext } from '../src/policy/identity.js';

// These tests exercise the real protocol adapter, scheduler, and RAM store.
// The remote transport and local player are controlled fixtures, never a live voice gate.
class WireSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
    this.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: {
      conversation_id: 'conv_ram_fixture', user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_24000',
    } });
  }
  message(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  close(): void { this.readyState = 3; this.emit('close', 1000); }
  terminate(): void { this.close(); }
}

interface PlayerObservation {
  readonly userId: string;
  readonly chunks: Buffer[];
  ended: boolean;
  drain(): void;
  cancel(): void;
}

const cleanups: (() => void)[] = [];
async function settle(): Promise<void> { for (let i = 0; i < 800; i++) await Promise.resolve(); }

function integration(ttlSeconds = 300) {
  const memory = new RecentConversation('guild', 'voice', ttlSeconds);
  const consent = new ConsentStore();
  const sockets: { speaker: SpeakerContext; socket: WireSocket }[] = [];
  const streams: PlayerObservation[] = [];
  const delivered: { speaker: SpeakerContext; turn: DeliveredTurn }[] = [];
  const metric = vi.fn();
  const prepare = vi.fn();
  const playback: Playback = {
    get isPlaying() { return streams.some(stream => !stream.ended); },
    startStream(userId, _sampleRate, _owner, options) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      let settled = false;
      let drained = false;
      let first = true;
      const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void done.catch(() => undefined);
      const finish = (): void => {
        if (!settled && stream.ended && drained) { settled = true; resolve(); }
      };
      const stream: PlayerObservation = { userId, chunks: [], ended: false,
        drain() {
          if (settled) return;
          drained = true;
          options?.onProgress?.('drained', 0);
          finish();
        },
        cancel() {
          if (settled) return;
          settled = true;
          reject(new Error('fixture_playback_cancelled'));
        },
      };
      streams.push(stream);
      return {
        done, cancel: () => stream.cancel(),
        end() { stream.ended = true; finish(); },
        async write(pcm: Buffer) {
          if (settled || options?.isAllowed?.() === false) throw new Error('fixture_playback_cancelled');
          if (drained) options?.onProgress?.('resumed', 0);
          drained = false;
          stream.chunks.push(Buffer.from(pcm));
          if (first) { first = false; options?.onProgress?.('first_packet', 0); }
        },
      };
    },
    stopUser(userId) { for (const stream of streams) if (stream.userId === userId) stream.cancel(); },
    stop() { for (const stream of streams) stream.cancel(); },
  };
  const manager = new SessionManager({
    connect: (speaker, callbacks, signal) => {
      const socket = new WireSocket();
      sockets.push({ speaker, socket });
      const connector = createAgentConnector({
        fetch: async () => new Response(JSON.stringify({ signed_url:
          'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_fixture&token=fixture_signature' })),
        createSocket: () => {
          queueMicrotask(() => socket.open());
          return socket as unknown as ReturnType<AgentDependencies['createSocket']>;
        },
        random: () => 0.5, sleep: async () => undefined,
      });
      return connector({ apiKey: 'fixture_key', agentId: 'agent_fixture', callbacks, signal,
        suppressFirstMessage: true, dynamicVariables: {
          speaker_name: speaker.displayName, speaker_is_creator: speaker.isOwner,
        } });
    },
    allowed: (speaker, audio) => consent.isCurrent(speaker.discordUserId, speaker.consentVersion, audio),
    detectWake: async () => true,
    playback, maxSessions: 3, maxTurnSeconds: 12, maxSessionSeconds: 300,
    idleSeconds: 45, followupSeconds: 18, maxTurnsPerHour: 100, metric,
    pace: async () => undefined,
    sessionContextExpiresAt: speaker => memory.deadline(speaker),
    prepareSession: (speaker, session, reused) => {
      prepare(speaker, reused);
      const context = memory.context(speaker);
      if (!reused && context.text) session.sendContext(context.text);
    },
    onTurnDelivered: (speaker, turn) => {
      delivered.push({ speaker, turn });
      memory.add(speaker, turn);
    },
  });
  cleanups.push(() => { manager.close(); memory.close(); for (const { socket } of sockets) socket.close(); });
  const speaker = (id = 'owner', displayName = 'Participante') => {
    const grant = consent.get(id) ?? consent.grant(id, true);
    return speakerContext({ discordUserId: id, displayName, consented: true,
      consentVersion: grant.version, guildId: 'guild', channelId: 'voice' }, 'owner');
  };
  const ask = async (who: SpeakerContext, text: string) => {
    const receipt = await manager.ask(who, text);
    await settle();
    return receipt;
  };
  const latest = () => sockets.at(-1)!.socket;
  const contextMessages = (socket = latest()) => socket.sent.filter(event => event.type === 'contextual_update');
  let responseId = 10;
  const response = async (text: string, complete = true, socket = latest()) => {
    const id = ++responseId;
    socket.message({ type: 'agent_response', agent_response_event: {
      agent_response: text, event_id: id, response_id: `response_${id}`,
    } });
    socket.message({ type: 'audio', audio_event: {
      audio_base_64: Buffer.from([1, 0, 2, 0]).toString('base64'), event_id: id, response_id: `response_${id}`,
    } });
    if (complete) socket.message({ type: 'agent_response_complete', agent_response_complete_event: { event_id: id } });
    await settle();
    return streams.at(-1)!;
  };
  const finish = async (stream = streams.at(-1)!) => { stream.drain(); await settle(); };
  return { memory, manager, consent, sockets, streams, delivered, metric, prepare,
    speaker, ask, latest, contextMessages, response, finish };
}

afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

describe('short RAM context through actual adapter and session manager (controlled transport/player)', () => {
  test('restores an actual question and delivered answer after socket closure before a pronoun follow-up', async () => {
    const h = integration(); const owner = h.speaker();
    await h.ask(owner, 'Quero encontrar a espada Lâmina Lunar.');
    const first = h.latest();
    const stream = await h.response('A Lâmina Lunar está no Castelo Azul.');
    expect(h.memory.count(owner)).toBe(0);
    expect(h.delivered).toHaveLength(0);
    await h.finish(stream);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ speaker: { discordUserId: 'owner' }, turn: {
      question: 'Quero encontrar a espada Lâmina Lunar.', response: 'A Lâmina Lunar está no Castelo Azul.',
      generation: 'confirmed', inputKind: 'text',
    } });
    first.close(); await settle();
    await h.ask(owner, 'Onde encontro ela?');
    expect(h.sockets).toHaveLength(2);
    const context = h.contextMessages()[0];
    expect(context?.text).toContain('Quero encontrar a espada Lâmina Lunar.');
    expect(context?.text).toContain('A Lâmina Lunar está no Castelo Azul.');
    expect(context?.text).toContain('"generation":"confirmed"');
    expect(h.latest().sent.findIndex(event => event.type === 'contextual_update'))
      .toBeLessThan(h.latest().sent.findIndex(event => event.type === 'user_message'));
    expect(h.latest().sent.at(-1)).toEqual({ type: 'user_message', text: 'Onde encontro ela?' });
  });

  test('without completion restores observed text as a possible reference without claiming a completed answer', async () => {
    const h = integration(); const owner = h.speaker();
    await h.ask(owner, 'Qual é a melhor arma?');
    const first = h.latest();
    const observed = 'A melhor opção é a Lâmina Lunar, encontrada no Castelo Azul.';
    await h.response(observed, false);
    await h.finish();
    expect(h.memory.count(owner)).toBe(0);
    expect(h.streams[0]!.ended).toBe(false);
    await h.ask(owner, 'Onde encontro ela?');
    expect(first.readyState).toBe(3);
    expect(h.sockets).toHaveLength(2);
    expect(h.delivered[0]?.turn).toMatchObject({
      question: 'Qual é a melhor arma?', generation: 'unconfirmed', observedResponse: observed,
    });
    expect(h.delivered[0]?.turn).not.toHaveProperty('response');
    const context = String(h.contextMessages()[0]?.text);
    expect(context).toContain('Qual é a melhor arma?');
    expect(context).toContain('"generation":"unconfirmed"');
    expect(context).toContain(`"agent_text_observed":"${observed}"`);
    expect(context).not.toContain('"answer":');
    expect(context).not.toContain('"generation":"confirmed"');
    expect(h.metric).toHaveBeenCalledWith('agent_turns_recovered');
    expect(h.metric).not.toHaveBeenCalledWith('agent_turns_superseded');
  });

  test('uses final ASR under the same Discord ID for a voice follow-up and remembers no greeting or tentative text', async () => {
    const h = integration(); const owner = h.speaker('owner', 'Nome anterior');
    await h.ask(owner, 'Quero a Lâmina Lunar.');
    await h.response('Ela está no Castelo Azul.'); await h.finish();
    h.latest().close(); await settle();
    const renamed = h.speaker('owner', 'Nome atualizado');
    await h.manager.voiceTurn(renamed, Buffer.alloc(19_200, 1), {
      captureId: 'capture-real-asr', captureMs: 100, endDetectionMs: 600,
      captureStartedAtMs: performance.now(), captureEndedAtMs: performance.now() + 100,
    });
    await settle();
    const socket = h.latest();
    expect(h.sockets.at(-1)?.speaker.discordUserId).toBe('owner');
    expect(socket.sent[0]?.dynamic_variables).toMatchObject({ speaker_name: 'Nome atualizado', speaker_is_creator: true });
    expect(h.contextMessages()[0]?.text).toContain('Quero a Lâmina Lunar.');
    expect(socket.sent.some(event => typeof event.user_audio_chunk === 'string')).toBe(true);
    socket.message({ type: 'agent_response', agent_response_event: { agent_response: 'Saudação inicial descartada.', event_id: 1 } });
    socket.message({ type: 'tentative_user_transcript', user_transcription_event: { user_transcript: 'Não guardar tentativa.' } });
    socket.message({ type: 'user_transcript', user_transcription_event: {
      user_transcript: 'Jarvis, onde encontro ela?', event_id: 2,
    } });
    await h.response('No Castelo Azul, senhor.'); await h.finish();
    expect(h.delivered[1]).toMatchObject({ speaker: { discordUserId: 'owner' }, turn: {
      question: 'Jarvis, onde encontro ela?', response: 'No Castelo Azul, senhor.', inputKind: 'voice', generation: 'confirmed',
    } });
    const recalled = h.memory.context(renamed).text;
    expect(recalled).not.toContain('Saudação inicial');
    expect(recalled).not.toContain('Não guardar tentativa');
    expect(recalled).toContain('Jarvis, onde encontro ela?');
  });

  test('keeps actual questions and answers isolated between participants sharing the same display name', async () => {
    const h = integration(); const owner = h.speaker('owner', 'Mesmo nome'); const guest = h.speaker('guest', 'Mesmo nome');
    await h.ask(owner, 'Minha arma é a Lâmina Lunar.');
    await h.response('Sua arma fica no Castelo Azul.'); await h.finish();
    h.latest().close(); await settle();
    await h.ask(guest, 'Qual é a minha arma?');
    expect(h.contextMessages()).toEqual([]);
    await h.response('Você ainda não informou sua arma.'); await h.finish();
    expect(h.memory.context(guest).text).not.toContain('Lâmina Lunar');
    expect(h.memory.context(owner).text).not.toContain('Qual é a minha arma?');
    expect(h.sockets.at(-1)?.speaker).toMatchObject({ discordUserId: 'guest', isOwner: false });
    expect(h.memory.context({ ...guest, consentVersion: guest.consentVersion + 1 }).text).toBe('');
  });

  test('does not store a provider failure even if already accepted audio subsequently drains', async () => {
    const h = integration(); const owner = h.speaker();
    await h.ask(owner, 'Pergunta cuja resposta falhou.');
    await h.response('Texto antes da falha.', false);
    h.latest().emit('error', new Error('fixture_transport_failure'));
    await settle(); await h.finish();
    expect(h.memory.count(owner)).toBe(0);
    expect(h.delivered).toHaveLength(0);
    await h.ask(owner, 'O que você respondeu?');
    expect(h.contextMessages()).toEqual([]);
    expect(h.memory.context(owner).text).not.toContain('Texto antes da falha');
    expect(h.memory.context(owner).text).not.toContain('agent_text_observed');
  });

  test('expires RAM context and renews a socket that had received it before the next legitimate question', async () => {
    vi.useFakeTimers();
    const h = integration(2); const owner = h.speaker();
    await h.ask(owner, 'A arma antiga é a Lâmina Lunar.');
    await h.response('A arma antiga está no Castelo Azul.'); await h.finish();
    h.latest().close(); await settle();
    await h.ask(owner, 'Onde encontro ela?');
    const restored = h.latest();
    expect(h.contextMessages(restored)[0]?.text).toContain('Lâmina Lunar');
    await h.response('No Castelo Azul.'); await h.finish();
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.memory.count(owner)).toBe(0);
    await h.ask(owner, 'Qual é a minha arma?');
    expect(restored.readyState).toBe(3);
    expect(h.sockets).toHaveLength(3);
    expect(h.contextMessages()).toEqual([]);
    expect(h.latest().sent.some(event => JSON.stringify(event).includes('Lâmina Lunar'))).toBe(false);
    expect(h.metric).toHaveBeenCalledWith('agent_context_expired_sessions');
  });
});
