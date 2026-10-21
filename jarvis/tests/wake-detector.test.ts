import { expect, test, vi } from 'vitest';
import { ElevenWakeDetector, containsWakeWord } from '../src/agents/wake-detector.js';

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
  expect(await detector.detect(Buffer.alloc(48_000 * 4))).toBe(false);
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
  expect(await detector.detect(Buffer.alloc(48_000))).toBe(false);
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
