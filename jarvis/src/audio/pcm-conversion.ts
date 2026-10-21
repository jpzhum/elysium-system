/** Signed 16-bit, little-endian PCM. Buffers never contain container headers. */
export function convertPcm(
  pcm: Buffer,
  fromRate: number,
  fromChannels: 1 | 2,
  toRate: number,
  toChannels: 1 | 2,
): Buffer {
  for (const rate of [fromRate, toRate]) {
    if (!Number.isInteger(rate) || rate < 8_000 || rate > 192_000) {
      throw new RangeError("Taxa de áudio PCM inválida.");
    }
  }
  if (![1, 2].includes(fromChannels) || ![1, 2].includes(toChannels)) {
    throw new RangeError("Quantidade de canais PCM inválida.");
  }
  if (pcm.length % (2 * fromChannels) !== 0) {
    throw new RangeError("Frame PCM incompleto.");
  }
  if (fromRate === toRate && fromChannels === toChannels) return Buffer.from(pcm);
  const inputFrames = pcm.length / (2 * fromChannels);
  const outputFrames = Math.floor(inputFrames * toRate / fromRate);
  const output = Buffer.alloc(outputFrames * toChannels * 2);
  const read = (frame: number, channel: number): number => {
    const index = Math.min(inputFrames - 1, Math.max(0, frame));
    const first = pcm.readInt16LE(index * fromChannels * 2);
    if (fromChannels === 1) return first;
    const second = pcm.readInt16LE((index * 2 + 1) * 2);
    return toChannels === 1 ? (first + second) / 2 : channel === 0 ? first : second;
  };
  // A finite windowed-sinc low-pass filter also limits aliasing when downsampling.
  const cutoff = Math.min(1, toRate / fromRate);
  const radius = Math.ceil(12 / cutoff);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const position = frame * fromRate / toRate;
    for (let channel = 0; channel < toChannels; channel += 1) {
      let value = 0;
      if (fromRate === toRate) {
        value = read(frame, channel);
      } else {
        let weightSum = 0;
        const center = Math.floor(position);
        for (let sample = center - radius + 1; sample <= center + radius; sample += 1) {
          const distance = position - sample;
          const scaled = Math.PI * distance * cutoff;
          const sinc = Math.abs(scaled) < 1e-10 ? 1 : Math.sin(scaled) / scaled;
          const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
          const weight = sinc * window * cutoff;
          value += read(sample, channel) * weight;
          weightSum += weight;
        }
        value /= weightSum;
      }
      output.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(value))),
        (frame * toChannels + channel) * 2);
    }
  }
  return output;
}
