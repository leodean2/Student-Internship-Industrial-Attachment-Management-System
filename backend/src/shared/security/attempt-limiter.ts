import { InMemoryAttemptStore, type AttemptStore } from "./attempt-store";

export interface LimiterPermit {
  /** Give this attempt's slot back (idempotent). Used when the attempt turns out not to be a failed guess. */
  refund(): void;
}

export type LimiterAcquisition =
  | { allowed: true; permit: LimiterPermit }
  | { allowed: false; retryAfterSeconds: number };

/**
 * A single-key reserve-and-refund limiter (e.g. invitation acceptance: N failed attempts per window per IP).
 * An attempt RESERVES a slot synchronously before any work is done, so simultaneous attempts can never exceed
 * the limit; the caller refunds the slot if the attempt was not a failure. Refused attempts are not recorded,
 * so hammering a limited key cannot extend its lock.
 *
 * Each limiter owns its store by default, so different features never share counters.
 */
export class AttemptLimiter {
  private readonly store: AttemptStore;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { limit: number; windowMs: number; store?: AttemptStore; now?: () => number }) {
    if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("limit must be a positive integer");
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) throw new Error("windowMs must be positive");
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.store = options.store ?? new InMemoryAttemptStore();
    this.now = options.now ?? Date.now;
  }

  acquire(key: string): LimiterAcquisition {
    const at = this.now();
    const wait = this.store.tryRecord(key, this.limit, this.windowMs, at);
    if (wait > 0) return { allowed: false, retryAfterSeconds: wait };
    let settled = false;
    return {
      allowed: true,
      permit: {
        refund: () => {
          if (settled) return;
          settled = true;
          this.store.remove(key, at);
        },
      },
    };
  }
}
