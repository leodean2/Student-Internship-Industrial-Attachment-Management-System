import type { Tx } from "../../infrastructure/transaction";
import { REGISTRATION_CONFIRMED, buildRegistrationConfirmedPayload } from "./registration-confirmed.payload";
import { REGISTRATION_REJECTED, buildRegistrationRejectedPayload } from "./registration-rejected.payload";
import type { OutboxEnqueuer } from "./outbox.repository";

/** Call with the decision's own `tx`: the email exists if and only if the decision committed. */
export function enqueueRegistrationConfirmed(
  outbox: OutboxEnqueuer,
  tx: Tx,
  input: { toEmail: string; userId: string; profileId: string; appBaseUrl: string },
): Promise<{ created: boolean }> {
  return outbox.enqueue(tx, {
    toEmail: input.toEmail,
    relatedUserId: input.userId,
    templateType: REGISTRATION_CONFIRMED,
    payload: buildRegistrationConfirmedPayload({ appBaseUrl: input.appBaseUrl }),
    idempotencyKey: `registration-confirmed:${input.profileId}`,
  });
}

export function enqueueRegistrationRejected(
  outbox: OutboxEnqueuer,
  tx: Tx,
  input: { toEmail: string; userId: string; profileId: string; decidedAt: Date },
): Promise<{ created: boolean }> {
  return outbox.enqueue(tx, {
    toEmail: input.toEmail,
    relatedUserId: input.userId,
    templateType: REGISTRATION_REJECTED,
    payload: buildRegistrationRejectedPayload(),
    idempotencyKey: `registration-rejected:${input.profileId}:${input.decidedAt.getTime()}`,
  });
}
