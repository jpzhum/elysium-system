/** Root mean square of signed PCM16LE, normalized to 0..1. No audio is retained. */
export function rms(pcm: Buffer): number {
  if (pcm.length % 2 !== 0) throw new RangeError("Amostra PCM incompleta.");
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32_768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (pcm.length / 2));
}
