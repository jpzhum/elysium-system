import { expect, test } from 'vitest';
import { CaptureWindows, type CaptureTiming } from '../src/audio/capture-window.js';

const timing = (id: string, start: number, end: number): CaptureTiming => ({
  captureId: id, captureStartedAtMs: start, captureEndedAtMs: end,
  captureMs: end - start, endDetectionMs: 600,
});

test('capture IDs and positive overlaps are replayed; adjacent and consecutive windows are new', () => {
  const captures = new CaptureWindows();
  const claim = (id: string, start: number, end: number) => captures.duplicate('one', 1, 'room', timing(id, start, end), 0);
  expect(claim('a', 0, 1000)).toBe(false);
  expect(claim('a', 2000, 3000)).toBe(true);
  expect(claim('b', 900, 1100)).toBe(true);
  expect(claim('c', 1000, 2000)).toBe(false);
  expect(claim('d', 2000, 3000)).toBe(false);
});

test('same windows remain independent across Discord IDs, consent versions, and channels', () => {
  const captures = new CaptureWindows(); const capture = timing('a', 0, 1000);
  expect(captures.duplicate('one', 1, 'room', capture, 0)).toBe(false);
  expect(captures.duplicate('two', 1, 'room', capture, 0)).toBe(false);
  expect(captures.duplicate('one', 2, 'room', capture, 0)).toBe(false);
  expect(captures.duplicate('one', 2, 'next', capture, 0)).toBe(false);
});

test('expiry and capacity bounds discard metadata without retaining audio or unbounded identities', () => {
  const captures = new CaptureWindows(100, 2, 2);
  const claim = (user: string, id: string, now = 0) => captures.duplicate(user, 1, 'room', timing(id, 0, 0), now);
  expect(claim('one', 'a')).toBe(false);
  expect(claim('one', 'b')).toBe(false);
  expect(claim('one', 'c')).toBe(false);
  expect(claim('one', 'a')).toBe(false); // Oldest of two retained windows was evicted.
  expect(claim('two', 'a')).toBe(false);
  expect(claim('three', 'a')).toBe(false);
  expect(claim('one', 'a')).toBe(false); // Oldest speaker was evicted.
  expect(claim('one', 'a', 100)).toBe(false);
  captures.forget('one'); expect(claim('one', 'a', 100)).toBe(false);
  captures.clear(); expect(claim('one', 'a', 100)).toBe(false);
});

test('legacy and malformed metadata do not suppress a legitimate new question', () => {
  const captures = new CaptureWindows();
  for (const input of [undefined, { captureMs: 20, endDetectionMs: 600 },
    timing('', 100, 0), timing('', Number.NaN, Number.POSITIVE_INFINITY)]) {
    expect(captures.duplicate('one', 1, 'room', input, 0)).toBe(false);
    expect(captures.duplicate('one', 1, 'room', input, 0)).toBe(false);
  }
});
