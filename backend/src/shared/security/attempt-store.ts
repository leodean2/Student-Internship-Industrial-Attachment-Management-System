/**
 * Sliding-window attempt storage, shared by every throttle (login, invitation acceptance, later verification
 * and password reset). In memory in V1: counters reset on restart and are not shared between API instances.
 * A shared store (e.g. PostgreSQL) can implement AttemptStore without touching callers.
 */
export interface AttemptStore {
  /**
   * Atomic (the call is synchronous). If fewer than `limit` attempts are recorded for `key` inside the
   * window, records one at `now` and returns 0. Otherwise records nothing and returns the whole seconds
   * until a slot frees (>= 1).
   */
  tryRecord(key: string, limit: number, windowMs: number, now: number): number;
  /** Removes one record made at exactly `at`. */
  remove(key: string, at: number): void;
  clear(key: string): void;
}

const SWEEP_EVERY_MS = 60_000;

/** An attempt counts while `now - at < windowMs`: it expires at exactly `at + windowMs`. */
export class InMemoryAttemptStore implements AttemptStore {
  private readonly entries = new Map<string, number[]>();
  private readonly maxKeys: number;
  private lastSweep = 0;

  constructor(maxKeys = 50_000) {
    this.maxKeys = maxKeys;
  }

  get size(): number {
    return this.entries.size;
  }

  tryRecord(key: string, limit: number, windowMs: number, now: number): number {
    this.sweep(windowMs, now);
    const live = (this.entries.get(key) ?? []).filter((at) => now - at < windowMs);
    if (live.length >= limit) {
      this.entries.set(key, live);
      return Math.max(1, Math.ceil((live[0]! + windowMs - now) / 1000));
    }
    live.push(now);
    this.entries.set(key, live);
    this.evictOverflow();
    return 0;
  }

  remove(key: string, at: number): void {
    const records = this.entries.get(key);
    if (!records) return;
    const i = records.indexOf(at);
    if (i >= 0) records.splice(i, 1);
    if (records.length === 0) this.entries.delete(key);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  /** Drops expired records so memory does not grow with every address ever seen. */
  private sweep(windowMs: number, now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, records] of this.entries) {
      const live = records.filter((at) => now - at < windowMs);
      if (live.length === 0) this.entries.delete(key);
      else if (live.length !== records.length) this.entries.set(key, live);
    }
  }

  /** Safety valve: past maxKeys the oldest-inserted keys are forgotten (fails open, bounded memory). */
  private evictOverflow(): void {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
