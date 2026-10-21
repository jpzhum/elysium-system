export interface SpeakerContext {
  readonly discordUserId: string;
  readonly displayName: string;
  readonly isOwner: boolean;
  readonly guildId: string;
  readonly channelId: string;
  readonly consented: boolean;
  readonly consentVersion: number;
}

export function sanitizeContext(value: string, max = 80): string {
  return value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}<>{}@`]/gu, '').replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Call only with IDs from Discord gateway/interaction objects, never tool parameters. */
export function speakerContext(input: Omit<SpeakerContext, 'isOwner'>, ownerId: string): SpeakerContext {
  return Object.freeze({ ...input, displayName: sanitizeContext(input.displayName) || 'Participante',
    isOwner: input.discordUserId === ownerId });
}
