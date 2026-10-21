export interface Consent { readonly version: number; readonly audio: boolean }

/** In-memory, channel session scoped. Restart/leave requires renewed consent. */
export class ConsentStore {
  private readonly users = new Map<string, Consent>();
  private version = 0;
  grant(userId: string, audio: boolean): Consent {
    const consent = Object.freeze({ version: ++this.version, audio });
    this.users.set(userId, consent);
    return consent;
  }
  get(userId: string): Consent | undefined { return this.users.get(userId); }
  isCurrent(userId: string, version: number, audio = false): boolean {
    const consent = this.users.get(userId);
    return consent?.version === version && (!audio || consent.audio);
  }
  revoke(userId: string): void { this.users.delete(userId); }
  clear(): void { this.users.clear(); }
}
