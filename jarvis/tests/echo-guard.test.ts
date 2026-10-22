import { expect, test } from 'vitest';
import { PlaybackEchoGuard } from '../src/audio/echo-guard.js';

function frames(frequency: number, count = 10, gain = 1): Buffer[] {
  return Array.from({ length: count }, (_, index) => {
    const frame = Buffer.alloc(960 * 4);
    for (let sample = 0; sample < 960; sample += 1) {
      const value = Math.round(12_000 * gain * Math.sin(2 * Math.PI * frequency * (index * 960 + sample) / 48_000));
      frame.writeInt16LE(value, sample * 4);
      frame.writeInt16LE(value, sample * 4 + 2);
    }
    return frame;
  });
}

test('recognizes a coherent recent playback echo despite amplitude changes without altering caller PCM', () => {
  const guard = new PlaybackEchoGuard();
  const played = frames(437);
  for (const frame of played) guard.remember(frame);
  const captured = Buffer.concat(frames(437, 10, 0.3));
  const original = Buffer.from(captured);
  expect(guard.isLikelyEcho(captured)).toBe(true);
  expect(captured).toEqual(original);
  expect(Buffer.concat(played)).toEqual(Buffer.concat(frames(437)));
});

test('different speech spectra, silence and a brief isolated match are not identified as echo', () => {
  const guard = new PlaybackEchoGuard();
  for (const frame of frames(437)) guard.remember(frame);
  expect(guard.isLikelyEcho(Buffer.concat(frames(1_130)))).toBe(false);
  expect(guard.isLikelyEcho(Buffer.alloc(960 * 4 * 10))).toBe(false);
  expect(guard.isLikelyEcho(Buffer.concat([...frames(437, 3), ...frames(1_130, 7)]))).toBe(false);
  expect(guard.isLikelyEcho(Buffer.concat(frames(437, 4)))).toBe(false);
});

test('expiry and clear erase the echo reference; history is limited to three seconds', () => {
  let now = 0;
  const guard = new PlaybackEchoGuard(() => now);
  for (const frame of frames(437)) guard.remember(frame);
  expect(guard.isLikelyEcho(Buffer.concat(frames(437)))).toBe(true);
  now = 3_000;
  expect(guard.isLikelyEcho(Buffer.concat(frames(437)))).toBe(false);
  for (const frame of frames(437)) guard.remember(frame);
  guard.clear();
  expect(guard.isLikelyEcho(Buffer.concat(frames(437)))).toBe(false);
  for (const frame of [...frames(437), ...frames(1_130, 150)]) guard.remember(frame);
  expect(guard.isLikelyEcho(Buffer.concat(frames(437)))).toBe(false);
  expect(guard.isLikelyEcho(Buffer.concat(frames(1_130)))).toBe(true);
});

test('short and malformed references are ignored and a long input remains bounded', () => {
  const guard = new PlaybackEchoGuard();
  guard.remember(Buffer.alloc(1));
  expect(guard.isLikelyEcho(Buffer.alloc(1))).toBe(false);
  for (const frame of frames(437)) guard.remember(frame);
  const capture = Buffer.concat([...frames(437, 200), ...frames(1_130, 1_000)]);
  expect(guard.isLikelyEcho(capture)).toBe(false);
});
