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
    const detector = new ElevenWakeDetector('fictional-key', 'Jarvis', 1, vi.fn(), request);
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
