import type { Tx } from "../../infrastructure/transaction";
import { PASSWORD_CHANGED, buildPasswordChangedPayload } from "./password-changed.payload";
import type { OutboxEnqueuer } from "./outbox.repository";

export interface EnqueuePasswordChangedInput {
  toEmail: string;
  userId: string;
  /** The timestamp of the confirming token; makes the idempotency key unique per reset event. */
  resetEventKey: string;
}

/** Must use the same transaction as the password update. */
export function enqueuePasswordChanged(
  outbox: OutboxEnqueuer,
  tx: Tx,
  input: EnqueuePasswordChangedInput,
): Promise<{ created: boolean }> {
  return outbox.enqueue(tx, {
    toEmail: input.toEmail,
    relatedUserId: input.userId,
    templateType: PASSWORD_CHANGED,
    payload: buildPasswordChangedPayload(),
    idempotencyKey: `password-changed:${input.resetEventKey}`,
  });
}
