import assert from "node:assert/strict";
import { test } from "vitest";
import { convertPcm } from "../src/audio/pcm-conversion.js";
import { rms } from "../src/audio/voice-activity.js";

function tone(rate: number, frequency: number, seconds = 0.1): Buffer {
  const buffer = Buffer.alloc(Math.floor(rate * seconds) * 2);
  for (let index = 0; index < buffer.length / 2; index += 1) {
    buffer.writeInt16LE(Math.round(20_000 * Math.sin(2 * Math.PI * frequency * index / rate)), index * 2);
  }
  return buffer;
}

test("PCM converts negotiated mono rates to Discord stereo and preserves duration/level", () => {
  const input = tone(16_000, 440);
  const result = convertPcm(input, 16_000, 1, 48_000, 2);
  assert.equal(result.length, 48_000 * 0.1 * 4);
  for (let offset = 0; offset < result.length; offset += 4) {
    assert.equal(result.readInt16LE(offset), result.readInt16LE(offset + 2));
  }
  assert.ok(Math.abs(rms(input) - rms(result)) < 0.01);
});

test("PCM downsampling attenuates content above the target Nyquist frequency", () => {
  const audible = convertPcm(tone(48_000, 1_000), 48_000, 1, 16_000, 1);
  const rejected = convertPcm(tone(48_000, 12_000), 48_000, 1, 16_000, 1);
  assert.ok(rms(audible) > 0.4);
  assert.ok(rms(rejected) < 0.02);
});

test("stereo downmix cancels opposite signals without clipping or sharing source memory", () => {
  const stereo = Buffer.alloc(40);
  for (let offset = 0; offset < stereo.length; offset += 4) {
    stereo.writeInt16LE(30_000, offset);
    stereo.writeInt16LE(-30_000, offset + 2);
  }
  assert.equal(rms(convertPcm(stereo, 48_000, 2, 48_000, 1)), 0);
  const copy = convertPcm(stereo, 48_000, 2, 48_000, 2);
  copy.fill(0);
  assert.notEqual(rms(stereo), 0);
});

test("invalid PCM alignment, channels, rates and partial samples fail closed", () => {
  assert.throws(() => convertPcm(Buffer.alloc(3), 48_000, 2, 16_000, 1));
  assert.throws(() => convertPcm(Buffer.alloc(4), 0, 1, 16_000, 1));
  assert.throws(() => convertPcm(Buffer.alloc(4), 48_000, 1, Number.NaN, 1));
  assert.throws(() => rms(Buffer.alloc(1)));
  assert.equal(rms(Buffer.alloc(0)), 0);
  assert.equal(convertPcm(Buffer.alloc(0), 48_000, 2, 16_000, 1).length, 0);
});
