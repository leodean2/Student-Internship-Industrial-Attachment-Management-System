import type { Tx } from "../../infrastructure/transaction";
import { buildPasswordResetRequestedPayload, PASSWORD_RESET_REQUESTED } from "./password-reset-requested.payload";
import type { OutboxEnqueuer } from "./outbox.repository";

export interface EnqueuePasswordResetInput {
  toEmail: string;
  userId: string;
  /** Raw token: used only to build the link. Never persisted outside the outbox payload, never logged. */
  rawToken: string;
  /** Hash stored on the token row; makes the idempotency key unique per issued token. */
  tokenHash: string;
  expiresAt: Date;
  appBaseUrl: string;
}

/** Must use the same transaction as the token insert. */
export function enqueuePasswordResetRequested(
  outbox: OutboxEnqueuer,
  tx: Tx,
  input: EnqueuePasswordResetInput,
): Promise<{ created: boolean }> {
  const payload = buildPasswordResetRequestedPayload({
    appBaseUrl: input.appBaseUrl,
    rawToken: input.rawToken,
    expiresAt: input.expiresAt,
  });
  return outbox.enqueue(tx, {
    toEmail: input.toEmail,
    relatedUserId: input.userId,
    templateType: PASSWORD_RESET_REQUESTED,
    payload,
    idempotencyKey: `password-reset:${input.tokenHash}`,
  });
}
