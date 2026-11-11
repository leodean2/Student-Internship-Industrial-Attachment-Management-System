import type { Tx } from "../../infrastructure/transaction";
import { ACCOUNT_DEACTIVATED, buildAccountDeactivatedPayload } from "./account-deactivated.payload";
import type { OutboxEnqueuer } from "./outbox.repository";

export interface EnqueueAccountDeactivatedInput {
  toEmail: string;
  userId: string;
}

/** Must use the same transaction as the deactivation so the email is sent iff the change committed. */
export function enqueueAccountDeactivated(
  outbox: OutboxEnqueuer,
  tx: Tx,
  input: EnqueueAccountDeactivatedInput,
): Promise<{ created: boolean }> {
  return outbox.enqueue(tx, {
    toEmail: input.toEmail,
    relatedUserId: input.userId,
    templateType: ACCOUNT_DEACTIVATED,
    payload: buildAccountDeactivatedPayload(),
    // userId is unique per deactivation; a second attempt is a no-op (idempotent).
    idempotencyKey: `account-deactivated:${input.userId}`,
  });
}
