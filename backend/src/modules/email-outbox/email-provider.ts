/** JSON-compatible value (structurally the same as Prisma's `JsonValue`, without importing Prisma here). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** What the worker hands a provider: exactly the columns the claim selects (Decision #54 §8.1). */
export interface EmailMessage {
  readonly id: string;
  readonly toEmail: string;
  readonly templateType: string;
  readonly payload: JsonValue;
  /** 1-based attempt number for this delivery (the claim has already incremented it). */
  readonly attempt: number;
}

/**
 * The worker depends on this interface only (Decision #54 §17). Provider credentials and configuration live in
 * the concrete adapter, never in worker orchestration.
 *
 * Contract:
 *  - Resolve only when the provider has ACCEPTED the message.
 *  - Throw `PermanentEmailError` for failures a retry cannot fix (invalid recipient, rejected template...).
 *  - Throw anything else for transient failures (network, 5xx, rate limit).
 *  - `signal` is best-effort cancellation. Aborting does not prove the provider did not deliver.
 */
export interface EmailProvider {
  send(message: EmailMessage, signal: AbortSignal): Promise<void>;
}

/** A failure that retrying cannot fix: the message goes straight to FAILED (Decision #54 §9). */
export class PermanentEmailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentEmailError";
  }
}

/** The worker-controlled provider timeout fired. Always a transient failure (Decision #54 §11). */
export class ProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Email provider call timed out after ${timeoutMs} ms`);
    this.name = "ProviderTimeoutError";
  }
}

/** The worker itself aborted the call (hard shutdown deadline, or ownership could not be confirmed). */
export class ProviderAbortedError extends Error {
  constructor() {
    super("Email provider call was aborted by the worker");
    this.name = "ProviderAbortedError";
  }
}

export type FailureKind = "permanent" | "transient";

/**
 * Unknown errors are TRANSIENT by default: the attempt cap (5) bounds the cost of being wrong, whereas wrongly
 * treating a recoverable error as permanent would silently drop an email.
 */
export function classifyProviderError(err: unknown): FailureKind {
  return err instanceof PermanentEmailError ? "permanent" : "transient";
}
