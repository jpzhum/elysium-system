/** Technical notices only. No audio, question text, transcript or display name. */
export type VoiceNoticeCategory = 'wake_global' | 'wake_individual' | 'wake_share' | 'voice_queue' | 'capture_limit' | 'voice_rejected';
interface EditableNotice { edit(payload: { content: string; allowedMentions: { parse: [] } }): Promise<unknown> }
interface Delivery {
  valid(): boolean;
  privateSend(payload: { content: string; allowedMentions: { parse: [] } }): Promise<EditableNotice>;
  publicSummary(): Promise<unknown>;
}
interface TurnNotice {
  userId: string;
  terminal: boolean;
  expires: number;
  pending: Promise<EditableNotice | undefined>;
}

/** Room-scoped, bounded dedupe and cooldowns; does not admit or cancel questions. */
export class VoiceFeedback {
  private readonly cooldowns = new Map<string, Map<VoiceNoticeCategory, number>>();
  private readonly turns = new Map<string, TurnNotice>();
  private publicAfter = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}

  private prune(): void {
    const now = this.now();
    for (const [id, categories] of this.cooldowns) {
      for (const [category, until] of categories) if (until <= now) categories.delete(category);
      if (!categories.size) this.cooldowns.delete(id);
    }
    for (const [id, turn] of this.turns) if (turn.expires <= now) this.turns.delete(id);
  }

  async rejected(userId: string, category: VoiceNoticeCategory, content: string,
    delivery: Delivery, retryAfterMs = 60_000): Promise<void> {
    if (!delivery.valid()) return;
    this.prune();
    let categories = this.cooldowns.get(userId);
    if ((categories?.get(category) ?? 0) > this.now()) return;
    if (!categories) {
      if (this.cooldowns.size >= 16) { await this.summary(delivery); return; }
      categories = new Map(); this.cooldowns.set(userId, categories);
    }
    const boundedDelay = Number.isFinite(retryAfterMs) ? Math.max(1000, Math.min(60_000, retryAfterMs)) : 60_000;
    categories.set(category, this.now() + boundedDelay);
    await this.send(content, delivery);
  }

  async turn(userId: string, turnId: string, kind: 'queued' | 'failed' | 'cancelled',
    content: string, delivery: Delivery): Promise<void> {
    if (!delivery.valid() || !/^[A-F0-9]{8}$/.test(turnId)) return;
    this.prune();
    const previous = this.turns.get(turnId);
    if (previous && (previous.userId !== userId || previous.terminal || kind === 'queued')) return;
    // Mark synchronously: simultaneous callbacks cannot publish duplicate notices.
    const notice: TurnNotice = { userId, terminal: kind !== 'queued', expires: this.now() + 1_200_000,
      pending: Promise.resolve(undefined) };
    if (!previous && this.turns.size >= 64) this.turns.delete(this.turns.keys().next().value!);
    this.turns.set(turnId, notice);
    notice.pending = (async () => {
      const message = await previous?.pending;
      if (!delivery.valid() || this.turns.get(turnId) !== notice) return undefined;
      if (message) {
        try { await message.edit({ content, allowedMentions: { parse: [] } }); return message; }
        catch { /* A deleted notice can be replaced once with the terminal result. */ }
      }
      return this.send(content, delivery);
    })();
    await notice.pending;
  }

  private async send(content: string, delivery: Delivery): Promise<EditableNotice | undefined> {
    if (!delivery.valid()) return undefined;
    try { return await delivery.privateSend({ content, allowedMentions: { parse: [] } }); }
    catch {
      await this.summary(delivery);
      return undefined;
    }
  }

  private async summary(delivery: Delivery): Promise<void> {
    if (!delivery.valid() || this.publicAfter > this.now()) return;
    this.publicAfter = this.now() + 60_000;
    // One anonymous summary even when DMs or notice-state capacity are exhausted.
    try { await delivery.publicSummary(); } catch { /* Status remains available. */ }
  }

  forget(userId: string): void {
    this.cooldowns.delete(userId);
    for (const [id, turn] of this.turns) if (turn.userId === userId) this.turns.delete(id);
  }
  clear(): void { this.cooldowns.clear(); this.turns.clear(); this.publicAfter = 0; }
}
