import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { convertPcm } from '../dist/audio/pcm-conversion.js';
import { StreamingPcm } from '../dist/audio/streaming-pcm.js';
import { summarize } from './benchmark-summary.mjs';
import { runPipelineBenchmark } from './benchmark-pipeline.mjs';

const samples = 25;
const warmups = 5;

/** Deterministic, generated audio; never reads microphone, configuration, or network. */
function fixture(rate, channels, seconds) {
  const pcm = Buffer.alloc(Math.round(rate * seconds) * channels * 2);
  for (let frame = 0; frame < pcm.length / (channels * 2); frame++) {
    const value = Math.round(8_000 * Math.sin(2 * Math.PI * 440 * frame / rate)
      + 2_000 * Math.sin(2 * Math.PI * 3_700 * frame / rate));
    for (let channel = 0; channel < channels; channel++) pcm.writeInt16LE(value, (frame * channels + channel) * 2);
  }
  return pcm;
}

async function measure(run) {
  for (let index = 0; index < warmups; index++) await run();
  const durations = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
  }
  return summarize(durations);
}

const cpu = {};
for (const [name, fromRate, fromChannels, toRate, toChannels, seconds] of [
  ['capture_48k_stereo_to_16k_mono_1s', 48_000, 2, 16_000, 1, 1],
  ['capture_48k_stereo_to_16k_mono_3s', 48_000, 2, 16_000, 1, 3],
  ['playback_16k_mono_to_48k_stereo_20ms', 16_000, 1, 48_000, 2, 0.02],
  ['playback_24k_mono_to_48k_stereo_20ms', 24_000, 1, 48_000, 2, 0.02],
]) {
  const pcm = fixture(fromRate, fromChannels, seconds);
  cpu[name] = await measure(() => {
    const converted = convertPcm(pcm, fromRate, fromChannels, toRate, toChannels);
    if (converted.length !== Math.floor(pcm.length / (fromChannels * 2) * toRate / fromRate) * toChannels * 2) {
      throw new Error('Unexpected PCM frame count.');
    }
  });
}

const streamFixture = fixture(24_000, 1, 1);
async function streaming(firstOnly) {
  const stream = new StreamingPcm(24_000, { maxBufferBytes: 128_000, maxSeconds: 5 });
  await stream.write(streamFixture, () => true);
  if (!firstOnly) stream.end();
  const frames = stream.frames();
  try {
    if (firstOnly) {
      const result = await frames.next();
      if (result.done || result.value.length !== 3_840) throw new Error('Missing initial 20 ms frame.');
    } else {
      let count = 0;
      for await (const frame of frames) {
        if (frame.length !== 3_840) throw new Error('Unexpected playback frame size.');
        count++;
      }
      if (count !== 50) throw new Error('Incomplete progressive PCM output.');
    }
  } finally { stream.cancel(); await frames.return(); }
}
cpu.streaming_24k_first_20ms = await measure(() => streaming(true));
cpu.streaming_24k_full_1s = await measure(() => streaming(false));
const pipeline = await runPipelineBenchmark();

process.stdout.write(`${JSON.stringify({
  schema: 1,
  kind: 'synthetic_audio_local_cpu',
  description: 'Measured wall-clock CPU fixture execution, including allocation. No real voice, network, recognition, or audibility measurements.',
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown' },
  clock: 'performance.now monotonic milliseconds',
  samples_per_case: samples,
  warmups_per_case: warmups,
  cpu,
  pipeline,
}, null, 2)}\n`);
