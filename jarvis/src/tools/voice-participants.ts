import { sanitizeContext, type SpeakerContext } from '../policy/identity.js';

export const VOICE_PARTICIPANTS_TOOL = 'get_voice_participants';
export const VOICE_PARTICIPANTS_PARAMETERS = Object.freeze({ type: 'object', properties: {}, required: [], additionalProperties: false });
const MAX_RESULT_BYTES = 14 * 1024; // Leave headroom below the adapter's 16 KiB client-tool result limit.

export interface VoiceRoomSnapshot {
  readonly guildId: string;
  readonly channelId: string;
  readonly botPresent: boolean;
  readonly members: readonly {
    readonly discordUserId: string;
    readonly displayName: string;
    readonly bot?: boolean;
  }[];
}

interface PublicParticipant {
  readonly display_name: string;
  readonly is_creator: boolean;
  readonly present: boolean;
  readonly is_bot: boolean;
}

export interface VoiceParticipantsResult {
  readonly available: boolean;
  readonly complete: boolean;
  readonly participants: readonly PublicParticipant[];
  readonly current_speaker?: PublicParticipant;
}

export interface VoiceParticipantsOptions {
  readonly speaker: SpeakerContext;
  readonly ownerId: string;
  /** Read current Discord channel.members, never fetch profiles or query privileged member/presence intents. */
  readonly snapshot: () => VoiceRoomSnapshot | undefined;
  /** Must verify this same room, current consent version and current channel membership. */
  readonly isAllowed: () => boolean;
  readonly signal?: AbortSignal;
}

/** IDs and authority come exclusively from the trusted closure; no model-provided selectors are accepted. */
export function createVoiceParticipantsTool(options: VoiceParticipantsOptions):
  (parameters: unknown) => Promise<VoiceParticipantsResult> {
  const unavailable = (): VoiceParticipantsResult => ({ available: false, complete: false, participants: [] });
  return async (parameters) => {
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)
      || Object.keys(parameters).length !== 0) return unavailable();
    try {
      if (options.signal?.aborted || !options.isAllowed()) return unavailable();
      const room = options.snapshot();
      if (!room || !room.botPresent || room.guildId !== options.speaker.guildId
        || room.channelId !== options.speaker.channelId || !options.isAllowed() || options.signal?.aborted) {
        return unavailable();
      }
      // The origin must still be present: stale speaker/session closures cannot query a different room.
      const current = room.members.find((member) => member.discordUserId === options.speaker.discordUserId && !member.bot);
      if (!current) return unavailable();
      const publicParticipant = (member: typeof current): PublicParticipant => ({
        display_name: sanitizeContext(member.displayName) || 'Participante',
        is_creator: member.discordUserId === options.ownerId,
        present: true,
        is_bot: member.bot === true,
      });
      const unique = new Map<string, typeof current>();
      for (const member of room.members) {
        if (!unique.has(member.discordUserId)) unique.set(member.discordUserId, member);
        if (unique.size > 100) break;
      }
      const result = {
        available: true,
        complete: unique.size <= 100,
        participants: [] as PublicParticipant[],
        current_speaker: publicParticipant(current),
      };
      for (const member of [...unique.values()].slice(0, 100)) {
        result.participants.push(publicParticipant(member));
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) {
          result.participants.pop();
          result.complete = false;
          break;
        }
      }
      return result;
    } catch { return unavailable(); }
  };
}
