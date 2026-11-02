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

import { InMemoryAttemptStore, type AttemptStore } from "../../shared/security/attempt-store";

export { InMemoryAttemptStore };
export type { AttemptStore };

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
