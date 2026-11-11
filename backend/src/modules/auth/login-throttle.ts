/**
 * Login throttling (login-slice decisions 1 and 2, plus the global per-email limit).
 *
 * Three limits, all over the same sliding window:
 *   - per IP + normalized email : 10 failed attempts   (stops guessing one account from one place)
 *   - per IP                    : 50 failed attempts   (stops one place trying many accounts)
 *   - per normalized email      : 30 failed attempts   (stops one account being guessed from many places)
 * The IP+email key includes the IP on purpose: an attacker elsewhere cannot lock the real user out at the low
 * threshold. The global per-email limit is the backstop for an attacker who rotates addresses.
 *
 * A per-email limit is temporary rather than a lockout: refused attempts record nothing, and a slot frees when its
 * original attempt expires. A successful login returns only its own IP and global-email reservations; previous
 * failures still count. Its IP+email pair is cleared, as that pair has proved it knows the password.
 *
 * "Failed" is enforced without a race: an attempt reserves a slot on every key before the password is checked,
 * and gives the slots back if the attempt is not a failure. A later key refusing also returns earlier reservations.
 *
 * Storage is in memory behind AttemptStore (V1): counters reset on restart and are not shared between API
 * instances. A shared store (e.g. PostgreSQL) can replace it without touching callers.
 */

import { InMemoryAttemptStore, type AttemptStore } from "../../shared/security/attempt-store";

export { InMemoryAttemptStore };
export type { AttemptStore };

export interface LoginThrottleConfig {
  perEmailLimit: number;
  perIpLimit: number;
  windowMs: number;
  perEmailGlobalLimit?: number;
}

export const DEFAULT_LOGIN_THROTTLE: Required<LoginThrottleConfig> = {
  perEmailLimit: 10,
  perIpLimit: 50,
  windowMs: 15 * 60 * 1000,
  perEmailGlobalLimit: 30,
};

export interface LoginPermit {
  /** Give this attempt's IP and global-email slots back, and clear the IP+email failures. */
  succeeded(): void;
  /** The attempt ended without a verdict on the password (error, inactive account): return every slot. */
  refund(): void;
}

export type LoginAcquisition =
  | { allowed: true; permit: LoginPermit }
  | { allowed: false; retryAfterSeconds: number };

export class LoginThrottle {
  private readonly store: AttemptStore;
  private readonly config: Required<LoginThrottleConfig>;
  private readonly now: () => number;

  constructor(options: { store?: AttemptStore; config?: LoginThrottleConfig; now?: () => number } = {}) {
    this.store = options.store ?? new InMemoryAttemptStore();
    this.config = { ...DEFAULT_LOGIN_THROTTLE, ...options.config };
    this.now = options.now ?? Date.now;
  }

  /** Synchronous on purpose: no other request can interleave between the check and the reservation. */
  acquire(ip: string, email: string): LoginAcquisition {
    const { perIpLimit, perEmailLimit, perEmailGlobalLimit, windowMs } = this.config;
    const at = this.now();
    const ipKey = `ip:${ip}`;
    const pairKey = `pair:${ip}|${email}`;
    const emailKey = `email:${email}`;

    const ipWait = this.store.tryRecord(ipKey, perIpLimit, windowMs, at);
    if (ipWait > 0) return { allowed: false, retryAfterSeconds: ipWait };

    const pairWait = this.store.tryRecord(pairKey, perEmailLimit, windowMs, at);
    if (pairWait > 0) {
      this.store.remove(ipKey, at); // a refused attempt must not use up the IP-wide budget
      return { allowed: false, retryAfterSeconds: pairWait };
    }

    const emailWait = this.store.tryRecord(emailKey, perEmailGlobalLimit, windowMs, at);
    if (emailWait > 0) {
      this.store.remove(ipKey, at);
      this.store.remove(pairKey, at);
      return { allowed: false, retryAfterSeconds: emailWait };
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
          this.store.remove(emailKey, at);
        },
        refund: () => {
          if (settled) return;
          settled = true;
          this.store.remove(ipKey, at);
          this.store.remove(pairKey, at);
          this.store.remove(emailKey, at);
        },
      },
    };
  }
}
