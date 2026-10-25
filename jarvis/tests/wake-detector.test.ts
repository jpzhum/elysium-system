import { expect, test, vi } from 'vitest';
import { ElevenWakeDetector, containsWakeWord, isExplicitStopCommand } from '../src/agents/wake-detector.js';

test.each(['Jarvis, ajude', 'Járvis!', 'Djárvis onde vou?', 'Oi JARVIS'])('accepts PT-BR spelling %s', (text) => {
  expect(containsWakeWord(text)).toBe(true);
});
test.each(['jardins bonitos', 'superjarvis', 'fale com ele', 'Jarvisson'])('does not match common speech/word fragments %s', (text) => {
  expect(containsWakeWord(text)).toBe(false);
});
test('external detector bounds audio, uses only official endpoint and limits cost', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Járvis, missão' }));
  const metric = vi.fn();
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, metric, request);
  expect(await detector.detect(Buffer.alloc(48_000 * 4 * 5))).toBe(true);
  await expect(detector.detect(Buffer.alloc(48_000 * 4))).rejects.toMatchObject({ code: 'wake_rate_limited' });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, options] = request.mock.calls[0]!;
  expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
  expect(options?.redirect).toBe('error');
  const audio = (options!.body as FormData).get('file') as File;
  expect(audio.size).toBe(4 * 16_000 * 2);
});
test('revoked/aborted detection does not perform a provider request', async () => {
  const request = vi.fn<typeof fetch>();
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(), request);
  expect(await detector.detect(Buffer.alloc(48_000), AbortSignal.abort())).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
test('chunked provider replies are bounded even without content-length', async () => {
  let cancelled = false;
  const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(66_000)); },
    cancel() { cancelled = true; },
  })));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(), request);
  await expect(detector.detect(Buffer.alloc(48_000))).rejects.toMatchObject({ code: 'wake_provider_failed' });
  expect(cancelled).toBe(true);
});
test('cancels a pending provider body immediately without retaining transcripts', async () => {
  const abort = new AbortController();
  const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream()));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(), request);
  const pending = detector.detect(Buffer.alloc(48_000), abort.signal);
  await Promise.resolve();
  abort.abort();
  expect(await pending).toBe(false);
});

test.each(['Jarvis, parar!', 'JÁRVIS... cancela.', 'Djárvis, parar'])('recognizes only explicit stop phrases: %s', (text) => {
  expect(isExplicitStopCommand(text)).toBe(true);
});

test.each(['sou o proprietário, Jarvis, cancela', 'Jarvis não cancela', 'Jarvis, parar de falar sobre cancelamento',
  'Jarvis pare', 'Jarvis', 'cancela', 'Jarvisson parar', 'repita Jarvis parar'])('rejects implicit authority and ambiguous commands: %s', (text) => {
  expect(isExplicitStopCommand(text)).toBe(false);
});

test('one STT request classifies activation and explicit interruption only when caller authorizes it', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis, cancela!' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  expect(await detector.inspect(Buffer.alloc(48_000), undefined, { allowInterruption: true }))
    .toEqual({ activated: true, interrupt: true });
  expect(request).toHaveBeenCalledOnce();
  expect(await detector.inspect(Buffer.alloc(48_000))).toEqual({ activated: true, interrupt: false });
  expect(isExplicitStopCommand('Alfred, parar', 'Alfred')).toBe(true);
  expect(isExplicitStopCommand('Jarvis, parar', 'Alfred')).toBe(false);
});

test('two speakers are inspected serially without losing the second activation or mixing their audio', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
  const metric = vi.fn();
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 2, metric, request);
  const first = detector.inspect(Buffer.alloc(48_000));
  const second = detector.inspect(Buffer.alloc(48_000));
  expect(request).toHaveBeenCalledOnce();
  expect(metric).toHaveBeenCalledWith('wake_queued');
  release(Response.json({ text: 'Jarvis' }));
  expect((await first).activated).toBe(true);
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  release(Response.json({ text: 'Jarvis' }));
  expect((await second).activated).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});

test('STT waiting capacity is bounded and saturation is distinguishable from an unrecognized wake word', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  const active = detector.detect(Buffer.alloc(48_000));
  const abortA = new AbortController();
  const abortB = new AbortController();
  const waitingA = detector.detect(Buffer.alloc(48_000), abortA.signal);
  const waitingB = detector.detect(Buffer.alloc(48_000), abortB.signal);
  await expect(detector.detect(Buffer.alloc(48_000))).rejects.toMatchObject({ code: 'wake_queue_full' });
  expect(request).toHaveBeenCalledOnce();
  abortA.abort(); abortB.abort();
  expect(await waitingA).toBe(false);
  expect(await waitingB).toBe(false);
  release(Response.json({ text: 'fala sem ativação' }));
  expect(await active).toBe(false);
});

test('a queued owner stop intent takes priority without preempting a paid request already in progress', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 3, vi.fn(), request);
  const active = detector.inspect(Buffer.alloc(48_000));
  const guest = detector.inspect(Buffer.alloc(48_000));
  const owner = detector.inspect(Buffer.alloc(48_000), undefined, { allowInterruption: true });
  release(Response.json({ text: 'Jarvis' }));
  await active; await Promise.resolve();
  release(Response.json({ text: 'Jarvis, parar' }));
  expect(await owner).toEqual({ activated: true, interrupt: true });
  await Promise.resolve();
  release(Response.json({ text: 'Jarvis, outra pergunta' }));
  expect(await guest).toEqual({ activated: true, interrupt: false });
});

test('waiting STT expires after eight seconds without spending a request or silently reporting no wake', async () => {
  vi.useFakeTimers();
  try {
    let release!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
    // Leave one paid-call slot available: an exhausted quota is rejected before queue admission.
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 2, vi.fn(), request);
    const active = expect(detector.detect(Buffer.alloc(48_000))).rejects.toMatchObject({ code: 'wake_provider_failed' });
    const rejected = expect(detector.detect(Buffer.alloc(48_000))).rejects.toMatchObject({ code: 'wake_queue_timeout' });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(request).toHaveBeenCalledOnce();
    release(Response.json({ text: 'Jarvis' }));
    await active;
  } finally { vi.useRealTimers(); }
});

test('too-short or misaligned PCM is rejected before allocating a paid request', async () => {
  const request = vi.fn<typeof fetch>();
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(), request);
  expect(await detector.detect(Buffer.alloc(19_196))).toBe(false);
  expect(await detector.detect(Buffer.alloc(19_201))).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

test('revocation during STT rejects late recognized intent and releases the concurrency gate', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 2, vi.fn(), request);
  const abort = new AbortController();
  const pending = detector.inspect(Buffer.alloc(48_000), abort.signal, { allowInterruption: true });
  abort.abort();
  release(Response.json({ text: 'Jarvis, cancela' }));
  expect(await pending).toEqual({ activated: false, interrupt: false });
  const next = detector.detect(Buffer.alloc(48_000));
  release(Response.json({ text: 'Jarvis' }));
  expect(await next).toBe(true);
});

test('only content-free numeric timing and counters leave the detector', async () => {
  const metric = vi.fn();
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, metric,
    vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis, conteúdo privado' })));
  await detector.inspect(Buffer.alloc(48_000));
  expect(metric).toHaveBeenCalledWith('wake_recognition_ms', expect.any(Number));
  expect(JSON.stringify(metric.mock.calls)).not.toContain('conteúdo');
});

test.each([401, 429, 500])('HTTP %d is a sanitized provider failure distinct from no wake', async (status) => {
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(),
    vi.fn<typeof fetch>(async () => new Response('PRIVATE TOKEN AND TRANSCRIPT', { status })));
  await expect(detector.detect(Buffer.alloc(48_000))).rejects.toMatchObject({ code: 'wake_provider_failed',
    message: 'wake_provider_failed' });
});

test('invalid STT JSON and missing transcript fields are sanitized failures', async () => {
  for (const response of [new Response('PRIVATE-INVALID-JSON'), Response.json({ private: 'PRIVATE' })]) {
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(),
      vi.fn<typeof fetch>(async () => response));
    await expect(detector.detect(Buffer.alloc(48_000))).rejects.toMatchObject({ code: 'wake_provider_failed',
      message: 'wake_provider_failed' });
  }
});

test('in-flight revocation settles immediately even if the transport has not returned a response', async () => {
  const request = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(), request);
  const abort = new AbortController();
  const caller = Buffer.alloc(48_000, 1);
  const pending = detector.detect(caller, abort.signal);
  abort.abort();
  expect(await pending).toBe(false);
  expect(caller.every((value) => value === 1)).toBe(true);
});

test('six background transcripts spend the shared budget, reject the next wake explicitly, and recover on expiry', async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'fala de fundo sem ativação' }));
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
    const pcm = Buffer.alloc(48_000, 1);
    for (let turn = 0; turn < 6; turn++) expect(await detector.detect(pcm)).toBe(false);
    expect(detector.operationalState).toEqual({ remaining: 0, queued: 0, active: false, retryAfterMs: 60_000 });
    await expect(detector.detect(pcm)).rejects.toMatchObject({ code: 'wake_rate_limited', retryAfterMs: 60_000 });
    expect(request).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(60_000);
    request.mockImplementationOnce(async () => Response.json({ text: 'Jarvis, agora sim' }));
    expect(await detector.detect(pcm)).toBe(true);
    expect(request).toHaveBeenCalledTimes(7);
    expect(detector.operationalState).toEqual({ remaining: 5, queued: 0, active: false, retryAfterMs: 0 });
  } finally { vi.useRealTimers(); }
});

test('a rolling minute prevents twelve paid wake checks around a fixed-window boundary', async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' }));
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
    const pcm = Buffer.alloc(48_000, 1);
    await vi.advanceTimersByTimeAsync(59_000);
    for (let check = 0; check < 6; check++) expect(await detector.detect(pcm)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(detector.detect(pcm)).rejects.toMatchObject({ code: 'wake_rate_limited', retryAfterMs: 58_999 });
    expect(request).toHaveBeenCalledTimes(6);
  } finally { vi.useRealTimers(); }
});

test('spent quota rejects before a new capture is copied or queued behind active STT', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
  const metric = vi.fn();
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, metric, request);
  const pcm = Buffer.alloc(48_000, 1);
  const active = detector.detect(pcm);
  const copy = vi.spyOn(Buffer, 'from');
  const rejected = detector.detect(pcm);
  const copies = copy.mock.calls.length;
  copy.mockRestore();
  expect(copies).toBe(0);
  expect(metric).not.toHaveBeenCalledWith('wake_queued');
  await expect(rejected).rejects.toMatchObject({ code: 'wake_rate_limited' });
  expect(detector.operationalState).toMatchObject({ remaining: 0, queued: 0, active: true });
  release(Response.json({ text: 'Jarvis' }));
  expect(await active).toBe(true);
});

const ambientSpeaker = { discordUserId: 'guest', consentVersion: 1, channelId: 'voice' };
const creator = { discordUserId: 'owner', consentVersion: 1, channelId: 'voice' };

test('a registered pair has separate paid-call shares even when one speaker always activates wake', async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' }));
    const metric = vi.fn();
    const observed = vi.fn();
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, metric, request);
    detector.setParticipants([creator, ambientSpeaker]);
    detector.setObserver(observed);
    const pcm = Buffer.alloc(48_000, 1);
    for (let call = 0; call < 3; call++) expect(await detector.detect(pcm, undefined, creator)).toBe(true);
    await expect(detector.detect(pcm, undefined, creator)).rejects.toMatchObject({
      code: 'wake_rate_limited', rateLimitSource: 'speaker_budget', retryAfterMs: 60_000,
    });
    expect(detector.operationalState.remaining).toBe(3);
    expect(detector.fairnessState).toEqual({ participants: 2, perSpeaker: 3 });
    for (let call = 0; call < 3; call++) expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(true);
    await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({ rateLimitSource: 'global_budget' });
    expect(request).toHaveBeenCalledTimes(6);
    expect(metric).toHaveBeenCalledWith('wake_speaker_rate_limited');
    expect(JSON.stringify(metric.mock.calls)).not.toMatch(/owner|guest/);
    expect(observed.mock.calls.filter(([, event]) => event === 'wake_accepted')).toHaveLength(6);
    expect(observed.mock.calls.filter(([, event]) => event === 'wake_requested')).toHaveLength(8);
    expect(observed.mock.calls.filter(([, event]) => event === 'wake_valid')).toHaveLength(6);
    expect(observed).toHaveBeenCalledWith(creator, 'wake_fair_share_rejected');
    expect(observed).toHaveBeenCalledWith(ambientSpeaker, 'wake_global_rejected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await detector.detect(pcm, undefined, creator)).toBe(true);
  } finally { vi.useRealTimers(); }
});

test('a lone consenting speaker retains the complete existing wake budget', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  detector.setParticipants([creator]);
  const pcm = Buffer.alloc(48_000, 1);
  for (let call = 0; call < 6; call++) expect(await detector.detect(pcm, undefined, creator)).toBe(true);
  await expect(detector.detect(pcm, undefined, creator)).rejects.toMatchObject({ rateLimitSource: 'global_budget' });
  expect(detector.fairnessState).toEqual({ participants: 1, perSpeaker: 6 });
  expect(request).toHaveBeenCalledTimes(6);
});

test('registered membership is not capped by the sixteen concurrent capture/history slots', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  const participants = Array.from({ length: 20 }, (_, index) => ({ ...creator, discordUserId: `member-${index}` }));
  detector.setParticipants(participants);
  expect(detector.fairnessState).toEqual({ participants: 20, perSpeaker: 1 });
  expect(await detector.detect(Buffer.alloc(48_000, 1), undefined, participants[19]!)).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});

test('fair-share cost survives consent refresh, room cleanup and roster updates', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  detector.setParticipants([creator, ambientSpeaker]);
  const pcm = Buffer.alloc(48_000, 1);
  for (let call = 0; call < 3; call++) await detector.detect(pcm, undefined, creator);
  detector.forget(creator.discordUserId);
  const renewed = { ...creator, consentVersion: 2 };
  detector.setParticipants([renewed, ambientSpeaker]);
  await expect(detector.detect(pcm, undefined, renewed)).rejects.toMatchObject({ rateLimitSource: 'speaker_budget' });
  detector.clearAdmission();
  const nextRoom = { ...renewed, channelId: 'other' };
  detector.setParticipants([nextRoom, { ...ambientSpeaker, channelId: 'other' }]);
  await expect(detector.detect(pcm, undefined, nextRoom)).rejects.toMatchObject({ rateLimitSource: 'speaker_budget' });
  expect(request).toHaveBeenCalledTimes(3);
});

test('speaker reservation rejects an extra inspection while two speakers keep paid calls serialized', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 2, vi.fn(), request);
  detector.setParticipants([creator, ambientSpeaker]);
  const pcm = Buffer.alloc(48_000, 1);
  const first = detector.detect(pcm, undefined, creator);
  const same = expect(detector.detect(pcm, undefined, creator)).rejects.toMatchObject({ rateLimitSource: 'speaker_budget' });
  const second = detector.detect(pcm, undefined, ambientSpeaker);
  expect(request).toHaveBeenCalledOnce();
  release(Response.json({ text: 'Jarvis' }));
  expect(await first).toBe(true);
  await same;
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  detector.setParticipants([creator]);
  release(Response.json({ text: 'Jarvis, resultado revogado' }));
  expect(await second).toBe(false);
  expect(detector.operationalState).toMatchObject({ remaining: 0, queued: 0, active: false });
});

test('a waiting inspection rechecks its smaller share when another participant joins', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  detector.setParticipants([creator]);
  const pcm = Buffer.alloc(48_000, 1);
  for (let call = 0; call < 3; call++) await detector.detect(pcm, undefined, creator);
  request.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
  const active = detector.detect(pcm, undefined, creator);
  const queued = expect(detector.detect(pcm, undefined, creator)).rejects.toMatchObject({ rateLimitSource: 'speaker_budget' });
  expect(detector.operationalState.queued).toBe(1);
  detector.setParticipants([creator, ambientSpeaker]);
  release(Response.json({ text: 'Jarvis' }));
  expect(await active).toBe(true);
  await queued;
  expect(request).toHaveBeenCalledTimes(4);
  expect(detector.operationalState).toMatchObject({ remaining: 2, active: false, queued: 0 });
});

test('roster changes fence queued and late results without refunding spent capacity', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  detector.setParticipants([creator, ambientSpeaker]);
  const pcm = Buffer.alloc(48_000, 1);
  const first = detector.detect(pcm, undefined, creator);
  const queued = detector.detect(pcm, undefined, ambientSpeaker);
  detector.setParticipants([{ ...creator, consentVersion: 2 }]);
  release(Response.json({ text: 'Jarvis' }));
  expect(await first).toBe(false);
  expect(await queued).toBe(false);
  expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
  expect(request).toHaveBeenCalledOnce();
  expect(detector.operationalState.remaining).toBe(5);
});

test('fair share expiry waits until enough older calls expire when another participant joins late', async () => {
  vi.useFakeTimers();
  try {
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(),
      vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' })));
    detector.setParticipants([creator]);
    const pcm = Buffer.alloc(48_000, 1);
    for (let call = 0; call < 4; call++) {
      await detector.detect(pcm, undefined, creator);
      await vi.advanceTimersByTimeAsync(1000);
    }
    detector.setParticipants([creator, ambientSpeaker]);
    await expect(detector.detect(pcm, undefined, creator)).rejects.toMatchObject({
      rateLimitSource: 'speaker_budget', retryAfterMs: 57_000,
    });
    await vi.advanceTimersByTimeAsync(56_000);
    await expect(detector.detect(pcm, undefined, creator)).rejects.toMatchObject({ rateLimitSource: 'speaker_budget', retryAfterMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await detector.detect(pcm, undefined, creator)).toBe(true);
  } finally { vi.useRealTimers(); }
});

test('observer failures cannot block or duplicate a paid inspection', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'Jarvis' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  detector.setParticipants([creator]);
  detector.setObserver(() => { throw new Error('fixture_diagnostic_failed'); });
  expect(await detector.detect(Buffer.alloc(48_000, 1), undefined, creator)).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});

test('two negative wakes back off only that speaker and leave shared capacity for the creator', async () => {
  vi.useFakeTimers();
  try {
    const metric = vi.fn();
    const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'conversa ambiente' }));
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, metric, request);
    const pcm = Buffer.alloc(48_000, 1);
    expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
    expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
    await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({
      code: 'wake_rate_limited', rateLimitSource: 'speaker_backoff', retryAfterMs: 10_000,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(metric).toHaveBeenCalledWith('wake_speaker_backoff');
    request.mockImplementationOnce(async () => Response.json({ text: 'Jarvis, responda' }));
    expect(await detector.detect(pcm, undefined, { ...ambientSpeaker, discordUserId: 'owner' })).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
    await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({
      rateLimitSource: 'speaker_backoff', retryAfterMs: 20_000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
    await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({
      rateLimitSource: 'speaker_backoff', retryAfterMs: 40_000,
    });
    expect(request).toHaveBeenCalledTimes(5); // Four ambient calls and one legitimate activation.
    expect(detector.operationalState.remaining).toBe(1);
    expect(JSON.stringify(metric.mock.calls)).not.toContain('guest');
  } finally { vi.useRealTimers(); }
});

test('activation resets negative-wake history without increasing the shared paid-call budget', async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'fala ambiente' }));
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
    const pcm = Buffer.alloc(48_000, 1);
    await detector.detect(pcm, undefined, ambientSpeaker);
    request.mockImplementationOnce(async () => Response.json({ text: 'Jarvis' }));
    expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(true);
    expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
    expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
    await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({
      rateLimitSource: 'speaker_backoff', retryAfterMs: 10_000,
    });
    expect(detector.operationalState.remaining).toBe(2);
  } finally { vi.useRealTimers(); }
});

test('negative-wake backoff is scoped to verified ID, consent version and channel', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'fala ambiente' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  const pcm = Buffer.alloc(48_000, 1);
  await detector.detect(pcm, undefined, ambientSpeaker);
  await detector.detect(pcm, undefined, ambientSpeaker);
  await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({ rateLimitSource: 'speaker_backoff' });
  expect(await detector.detect(pcm, undefined, { ...ambientSpeaker, consentVersion: 2 })).toBe(false);
  expect(await detector.detect(pcm, undefined, { ...ambientSpeaker, channelId: 'other' })).toBe(false);
  expect(await detector.detect(pcm, undefined, { ...ambientSpeaker, discordUserId: 'other' })).toBe(false);
  expect(request).toHaveBeenCalledTimes(5);
});

test('a queued inspection rechecks per-speaker backoff before spending another paid call', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  const pcm = Buffer.alloc(48_000, 1);
  const first = detector.detect(pcm, undefined, ambientSpeaker);
  const second = detector.detect(pcm, undefined, ambientSpeaker);
  const third = expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({ rateLimitSource: 'speaker_backoff' });
  release(Response.json({ text: 'sem ativação' }));
  expect(await first).toBe(false);
  await Promise.resolve();
  release(Response.json({ text: 'ainda sem ativação' }));
  expect(await second).toBe(false);
  await third;
  expect(request).toHaveBeenCalledTimes(2);
  expect(detector.operationalState).toMatchObject({ remaining: 4, active: false, queued: 0 });
});

test('negative-wake state is bounded and expires without retaining timers', async () => {
  vi.useFakeTimers();
  try {
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 30, vi.fn(),
      vi.fn<typeof fetch>(async () => Response.json({ text: 'sem ativação' })));
    const pcm = Buffer.alloc(48_000, 1);
    for (let index = 0; index < 20; index++) {
      await detector.detect(pcm, undefined, { ...ambientSpeaker, discordUserId: `speaker-${index}` });
    }
    expect(detector.admissionState).toEqual({ tracked: 16, backingOff: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(detector.admissionState).toEqual({ tracked: 0, backingOff: 0 });
    expect(detector.operationalState.remaining).toBe(30);
  } finally { vi.useRealTimers(); }
});

test('revocation and room teardown clear speaker backoff while preserving the worker cost ceiling', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'sem ativação' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 4, vi.fn(), request);
  const pcm = Buffer.alloc(48_000, 1);
  await detector.detect(pcm, undefined, ambientSpeaker);
  await detector.detect(pcm, undefined, ambientSpeaker);
  detector.forget(ambientSpeaker.discordUserId);
  expect(detector.admissionState.tracked).toBe(0);
  expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
  detector.clearAdmission();
  expect(detector.admissionState.tracked).toBe(0);
  expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
  detector.clearAdmission();
  await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({ rateLimitSource: 'global_budget' });
  expect(request).toHaveBeenCalledTimes(4);
});

test('forget fences late recognition from a revoked admission record without repopulating it', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  const pcm = Buffer.alloc(48_000, 1);
  const pending = detector.detect(pcm, undefined, ambientSpeaker);
  detector.forget(ambientSpeaker.discordUserId);
  release(Response.json({ text: 'Jarvis, conteúdo antigo' }));
  expect(await pending).toBe(false);
  expect(detector.admissionState).toEqual({ tracked: 0, backingOff: 0 });
  expect(detector.operationalState.remaining).toBe(5);
  const next = detector.detect(pcm, undefined, { ...ambientSpeaker, consentVersion: 2 });
  release(Response.json({ text: 'fala sem ativação' }));
  expect(await next).toBe(false);
  expect(detector.admissionState).toEqual({ tracked: 1, backingOff: 0 });
});

test('cancelled and failed recognition do not count as negative wakes for speaker admission', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ text: 'fala ambiente' }));
  const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 6, vi.fn(), request);
  const pcm = Buffer.alloc(48_000, 1);
  expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
  request.mockImplementationOnce(async (_url, options) => {
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return Response.json({ text: 'Jarvis, resultado cancelado' });
  });
  const abort = new AbortController();
  const cancelled = detector.detect(pcm, abort.signal, ambientSpeaker);
  abort.abort();
  expect(await cancelled).toBe(false);
  request.mockImplementationOnce(async () => new Response('PRIVATE', { status: 429 }));
  await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({ code: 'wake_provider_failed' });
  expect(detector.admissionState.backingOff).toBe(0);
  expect(await detector.detect(pcm, undefined, ambientSpeaker)).toBe(false);
  await expect(detector.detect(pcm, undefined, ambientSpeaker)).rejects.toMatchObject({ rateLimitSource: 'speaker_backoff' });
  expect(request).toHaveBeenCalledTimes(4);
});
