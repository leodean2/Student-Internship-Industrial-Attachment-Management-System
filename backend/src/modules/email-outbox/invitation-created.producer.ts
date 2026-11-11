import type { Tx } from "../../infrastructure/transaction";
import { INVITATION_CREATED, buildInvitationCreatedPayload } from "./invitation-created.payload";
import type { OutboxEnqueuer } from "./outbox.repository";

export interface EnqueueInvitationCreatedInput {
  toEmail: string;
  rawToken: string;
  tokenHash: string;
  role: string;
  expiresAt: Date;
  appBaseUrl: string;
}

/** Enqueues the invitation email in the same transaction that creates the invitation. */
export function enqueueInvitationCreated(
  outbox: OutboxEnqueuer,
  tx: Tx,
  input: EnqueueInvitationCreatedInput,
): Promise<{ created: boolean }> {
  const payload = buildInvitationCreatedPayload({
    appBaseUrl: input.appBaseUrl,
    rawToken: input.rawToken,
    role: input.role,
    expiresAt: input.expiresAt,
  });
  return outbox.enqueue(tx, {
    toEmail: input.toEmail,
    relatedUserId: null,
    templateType: INVITATION_CREATED,
    payload,
    idempotencyKey: `invitation-created:${input.tokenHash}`,
  });
}
