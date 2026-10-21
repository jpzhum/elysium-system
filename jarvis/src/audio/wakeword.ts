/** Implementations must disclose any external transcription before activation. */
export interface WakeDetector {
  detect(pcm48kStereo: Buffer, signal?: AbortSignal): Promise<boolean>;
}

export function containsWakeWord(transcript: string, wakeWord = "Jarvis"): boolean {
  const normalize = (value: string): string => value.normalize("NFD")
    .replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
  const normalizedWord = normalize(wakeWord).trim();
  if (!normalizedWord) return false;
  const words = normalize(transcript).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((word) => word === normalizedWord ||
    (normalizedWord === "jarvis" && word === "djarvis"));
}

/** Text gate only; this class does not claim to detect wake words in local audio. */
export class TranscriptWakeGate {
  constructor(private readonly wakeWord = "Jarvis") {}

  containsWakeWord(transcript: string): boolean {
    return containsWakeWord(transcript, this.wakeWord);
  }
}
