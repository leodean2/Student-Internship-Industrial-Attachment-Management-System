import type { Tx } from "../../infrastructure/transaction";
import {
  EMAIL_VERIFICATION_REQUESTED,
  buildEmailVerificationRequestedPayload,
} from "./email-verification-requested.payload";
import type { OutboxEnqueuer } from "./outbox.repository";

export interface EnqueueEmailVerificationInput {
  toEmail: string;
  /** The user row created in the same transaction (PENDING_VERIFICATION). */
  userId: string;
  /** Raw token: used only to build the link. Never persisted outside the outbox payload, never logged. */
  rawToken: string;
  /** Hash stored on the token row; makes the idempotency key unique per issued token. */
  tokenHash: string;
  expiresAt: Date;
  appBaseUrl: string;
}

/** Must use the same transaction as the user and token inserts. */
export function enqueueEmailVerificationRequested(
  outbox: OutboxEnqueuer,
  tx: Tx,
  input: EnqueueEmailVerificationInput,
): Promise<{ created: boolean }> {
  const payload = buildEmailVerificationRequestedPayload({
    appBaseUrl: input.appBaseUrl,
    rawToken: input.rawToken,
    expiresAt: input.expiresAt,
  });
  return outbox.enqueue(tx, {
    toEmail: input.toEmail,
    relatedUserId: input.userId,
    templateType: EMAIL_VERIFICATION_REQUESTED,
    payload,
    idempotencyKey: `email-verification:${input.tokenHash}`,
  });
}
