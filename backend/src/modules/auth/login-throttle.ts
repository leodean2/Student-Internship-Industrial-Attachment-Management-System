/**
 * Login throttling (login-slice decisions 1 and 2).
 *
 * Two limits, both over the same sliding window:
 *   - per IP + normalized email : 10 failed attempts   (stops guessing one account from one place)
 *   - per IP                    : 50 failed attempts   (stops one place trying many accounts)
 * The per-email key includes the IP on purpose: an attacker elsewhere cannot lock the real user out.
 *
 * "Failed" is enforced without a race: an attempt RESERVES a slot on both keys before the password is
 * checked, and the slot is given back if the attempt turns out not to be a failure. So N simultaneous
 * wrong guesses can never get more than `limit` bcrypt comparisons through.
 *
 * Storage is in memory behind AttemptStore (V1): counters reset on restart and are not shared between
 * API instances. A shared store (e.g. PostgreSQL) can replace it without touching callers.
 */

export interface LoginThrottleConfig {
  perEmailLimit: number;
  perIpLimit: number;
  windowMs: number;
}

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleConfig = {
  perEmailLimit: 10,
  perIpLimit: 50,
  windowMs: 15 * 60 * 1000,
};

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

export interface LoginPermit {
  /** The password was correct: give the slot back on both keys and forget this IP+email's failures. The IP-wide count is NOT reset. */
  succeeded(): void;
  /** The attempt ended without a verdict on the password (error, inactive account): give the slot back only. */
  refund(): void;
}

export type LoginAcquisition =
  | { allowed: true; permit: LoginPermit }
  | { allowed: false; retryAfterSeconds: number };

export class LoginThrottle {
  private readonly store: AttemptStore;
  private readonly config: LoginThrottleConfig;
  private readonly now: () => number;

  constructor(options: { store?: AttemptStore; config?: LoginThrottleConfig; now?: () => number } = {}) {
    this.store = options.store ?? new InMemoryAttemptStore();
    this.config = options.config ?? DEFAULT_LOGIN_THROTTLE;
    this.now = options.now ?? Date.now;
  }

  /** Synchronous on purpose: no other request can interleave between the check and the reservation. */
  acquire(ip: string, email: string): LoginAcquisition {
    const { perIpLimit, perEmailLimit, windowMs } = this.config;
    const at = this.now();
    const ipKey = `ip:${ip}`;
    const pairKey = `pair:${ip}|${email}`;

    const ipWait = this.store.tryRecord(ipKey, perIpLimit, windowMs, at);
    if (ipWait > 0) return { allowed: false, retryAfterSeconds: ipWait };

    const pairWait = this.store.tryRecord(pairKey, perEmailLimit, windowMs, at);
    if (pairWait > 0) {
      this.store.remove(ipKey, at); // a refused attempt must not use up the IP-wide budget
      return { allowed: false, retryAfterSeconds: pairWait };
    }

    let settled = false;
    return {
      allowed: true,
      permit: {
        succeeded: () => {
          if (settled) return;
          settled = true;
          this.store.remove(ipKey, at);
          this.store.clear(pairKey);
        },
        refund: () => {
          if (settled) return;
          settled = true;
          this.store.remove(ipKey, at);
          this.store.remove(pairKey, at);
        },
      },
    };
  }
}
