/** Maximum TOTAL attempts per message (Decision #54 §9). The claim increments `attempts`, so this is a ceiling on it. */
export const MAX_ATTEMPTS = 5;

const MINUTE_MS = 60_000;

/** Base delay after a transient failure on attempt N (index N-1). Attempt 5 has no retry. */
export const RETRY_DELAYS_MS: readonly number[] = [1, 5, 15, 30].map((m) => m * MINUTE_MS);

/** Random jitter of +/-10% on every retry delay (Decision #54 §9). */
export const JITTER_RATIO = 0.1;

export type TransientFailureDecision = { kind: "retry"; delayMs: number } | { kind: "fail" };

/** `random` must return a value in [0, 1). Injectable so tests are deterministic. */
export function applyJitter(baseMs: number, random: () => number = Math.random): number {
  const factor = 1 + (random() * 2 - 1) * JITTER_RATIO;
  return Math.round(baseMs * factor);
}

/**
 * What to do after a TRANSIENT failure, given the attempt count AFTER the claim incremented it.
 * Permanent failures never reach this function: they are terminal immediately.
 *
 * The result is a DELAY, not a timestamp: the repository adds it to the database clock (Decision #76's
 * one-clock principle), so API/worker hosts with skewed clocks cannot schedule retries inconsistently.
 */
export function decideAfterTransientFailure(
  attempts: number,
  random: () => number = Math.random,
): TransientFailureDecision {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts must be an integer >= 1 (received ${attempts})`);
  }
  if (attempts >= MAX_ATTEMPTS) return { kind: "fail" };
  return { kind: "retry", delayMs: applyJitter(RETRY_DELAYS_MS[attempts - 1]!, random) };
}
