import { createHmac, randomBytes } from "node:crypto";

export interface ThrottleKeyer {
  key(scope: string, value: string): string;
}

/**
 * Builds rate-limit bucket keys as keyed HMAC-SHA256 hashes, so the raw identifier (email, phone, etc.)
 * never appears in a limiter key or log. With an in-process store, the per-process random secret is correct:
 * the counters don't outlive the process either. Provide a stable secret when a shared store is added.
 */
export function createThrottleKeyer(secret: Buffer | string = randomBytes(32)): ThrottleKeyer {
  return {
    key: (scope, value) =>
      `${scope}:${createHmac("sha256", secret).update(value).digest("hex")}`,
  };
}
