import assert from "node:assert/strict";
import { createHash } from 'node:crypto';
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

test('resampling preserves original PCM bytes for seeded signals and fractional phases', () => {
  // Recorded from the V5.4.1 implementation before optimization, with 4,001
  // frames of deterministic full-range PCM. These also cover edge clamping,
  // stereo downmix, alias filtering and the bounded-cache fallback at 22,050 Hz.
  const cases: [number, 1 | 2, number, 1 | 2, string][] = [
    [48_000, 2, 16_000, 1, '4946c16fa8a75deab6784dfcf50730ed295d269fdeaf08f7589f9ab66d9aa261'],
    [48_000, 2, 24_000, 1, 'e52ff227d548f5794b7ec6e76bf8fb64d08e89e329049a156b95c515a7d90955'],
    [16_000, 1, 48_000, 2, 'e1e6719c2782a47dd2894e64b14c8bcafaf5d18eb4df910b2ae672aec9aa08bf'],
    [22_050, 1, 48_000, 2, 'ee56770048f48889e23bcd660cca8e654234a4db8ef3eb1ab8b973bee5ad3fde'],
    [44_100, 1, 48_000, 2, '537c68a621e10d8053f77cdedae9dddd66c14dd4c160625e986dee2b182001a8'],
    [96_000, 1, 48_000, 2, '7ba5be426d7ea129a584b9401569f2707e8de08e944d149f3042087410783f50'],
    [192_000, 2, 8_000, 1, 'c7aeba4d2be0824feb36cd6ee9cef7f9f44aa6fce463cb01bd3f0a4e4563da8f'],
    [8_000, 1, 192_000, 2, '597546d623ea6c26669446fb27fb937191f21ed04bcb967a2d7f734a8ac3f7c2'],
    [48_000, 2, 44_100, 2, 'e698b7c49cef7d604f6a71b36cea869cfa8b8cb4cb386304a94a1ed1293796b8'],
  ];
  for (const [fromRate, fromChannels, toRate, toChannels, expected] of cases) {
    let seed = 0x41c6ce57;
    const pcm = Buffer.alloc(4_001 * fromChannels * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      pcm.writeInt16LE((seed >>> 16) - 32_768, offset);
    }
    const output = convertPcm(pcm, fromRate, fromChannels, toRate, toChannels);
    assert.equal(createHash('sha256').update(output).digest('hex'), expected,
      `${fromRate}/${fromChannels} -> ${toRate}/${toChannels}`);
  }
});
