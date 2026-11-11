import {
  ProviderAbortedError,
  ProviderTimeoutError,
  type EmailMessage,
  type EmailProvider,
} from "./email-provider";

/**
 * One provider call with a worker-controlled timeout (Decision #54 §11).
 *
 *  - One timer and one AbortController per call.
 *  - `provider.send` runs inside `Promise.resolve().then(...)`, so a SYNCHRONOUS throw becomes a rejection.
 *  - A rejection handler is attached to the provider promise, so a failure that arrives AFTER the timeout (or
 *    after an abort) can never surface as an unhandled rejection.
 *  - The timer and the external-abort listener are always cleaned up in `finally`.
 *
 * Settles with:
 *  - resolves                   -> the provider accepted the message
 *  - ProviderTimeoutError       -> timeout fired (transient); the provider signal was aborted
 *  - ProviderAbortedError       -> `externalSignal` aborted (hard shutdown / uncertain ownership); the provider
 *                                signal was aborted. The worker must NOT treat this as a delivery outcome.
 *  - whatever the provider threw
 *
 * Aborting is best-effort: the provider may still have delivered the email (at-least-once, never exactly-once).
 */
export async function sendWithTimeout(
  provider: EmailProvider,
  message: EmailMessage,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<void> {
  // Already told to stop: do not even start the call.
  if (externalSignal?.aborted) throw new ProviderAbortedError();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;

  const providerPromise = Promise.resolve().then(() => provider.send(message, controller.signal));
  providerPromise.catch(() => undefined); // late rejections are deliberately swallowed here

  const interruption = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(timeoutMs));
    }, timeoutMs);

    if (externalSignal) {
      onExternalAbort = () => {
        controller.abort();
        reject(new ProviderAbortedError());
      };
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  });

  try {
    await Promise.race([providerPromise, interruption]);
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}
