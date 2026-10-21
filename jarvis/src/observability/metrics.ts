import { randomBytes } from 'node:crypto';

export class Metrics {
  private readonly counters = new Map<string, number>();
  add = (name: string, value = 1): void => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !Number.isFinite(value)) return;
    if (!this.counters.has(name) && this.counters.size >= 64) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  };
  snapshot(): Record<string, number> { return Object.fromEntries(this.counters); }
}

export type LogLevel = 'info' | 'warn' | 'error';
export class Logger {
  constructor(private readonly minimum: LogLevel = 'info') {}
  event(name: string, level: LogLevel = 'info'): string {
    const incident = randomBytes(4).toString('hex').toUpperCase();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) return incident;
    if (['info', 'warn', 'error'].indexOf(level) >= ['info', 'warn', 'error'].indexOf(this.minimum)) {
      // Deliberately no Error objects, payloads, user IDs, URLs, transcripts or environment.
      process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, event: name, incident })}\n`);
    }
    return incident;
  }
}
