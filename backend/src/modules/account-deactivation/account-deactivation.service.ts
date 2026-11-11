import type { TxRunner } from "../../infrastructure/transaction";
import type { ActorContext } from "../auth/actor-context";
import { hasRole } from "../auth/actor-context";
import type { AuditRepository } from "../audit/audit.repository";
import type { OutboxEnqueuer } from "../email-outbox/outbox.repository";
import { enqueueAccountDeactivated } from "../email-outbox/account-deactivated.producer";
import { Errors } from "../../shared/errors";
import { SYSTEM_USER_ID } from "../../shared/system-user";
import type { AccountDeactivationRepository } from "./account-deactivation.repository";

export interface AccountDeactivationServiceDeps {
  repo: AccountDeactivationRepository;
  audit: AuditRepository;
  outbox: OutboxEnqueuer;
  runTx: TxRunner;
}

export class AccountDeactivationService {
  constructor(private readonly deps: AccountDeactivationServiceDeps) {}

  async deactivate(actor: ActorContext, targetUserId: string): Promise<void> {
    // Authorization: only ADMIN may deactivate (C3 §1).
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();

    // Self-deactivation forbidden (C3 §1).
    if (actor.userId === targetUserId) {
      throw Errors.forbidden("An administrator cannot deactivate their own account.");
    }

    const { repo, audit, outbox, runTx } = this.deps;

    await runTx(async (tx) => {
      // Lock the target row for the duration of the transaction (C3 §9).
      const target = await repo.findAndLockTarget(tx, targetUserId);
      if (!target) throw Errors.notFound("User not found.");

      if (target.userId === SYSTEM_USER_ID) {
        throw Errors.forbidden("The SYSTEM account cannot be deactivated.");
      }

      if (target.status === "PENDING_VERIFICATION") {
        throw Errors.forbidden("Accounts pending verification cannot be deactivated.");
      }

      // ADMIN-on-ADMIN deactivation forbidden (C3 §1).
      if (target.roles.includes("ADMIN")) {
        throw Errors.forbidden("An administrator cannot deactivate another administrator account.");
      }

      // Already deactivated → 409 (C3 §3).
      if (target.status === "DEACTIVATED") {
        throw Errors.conflict("This account is already deactivated.");
      }

      // Conditional write — prevents duplicate successful operations (C3 §9).
      const changed = await repo.deactivate(tx, targetUserId, target.status);
      if (!changed) {
        // Another concurrent request won the race; treat as already-deactivated.
        throw Errors.conflict("This account is already deactivated.");
      }

      // Revoke all refresh sessions (C3 §7).
      await tx.$executeRaw`
        UPDATE refresh_tokens
        SET "revokedAt" = clock_timestamp()
        WHERE "userId" = ${targetUserId} AND "revokedAt" IS NULL`;

      // Revoke active reviewer assignments if the target is a University Supervisor (C3 §4).
      let revokedAssignments = 0;
      if (target.roles.includes("UNIVERSITY_SUPERVISOR")) {
        revokedAssignments = await repo.revokeReviewerAssignments(tx, targetUserId, actor.userId);
      }

      // Audit event (C3 §9).
      await audit.record(tx, {
        actorUserId: actor.userId,
        action: "ACCOUNT_DEACTIVATED",
        targetType: "User",
        targetId: targetUserId,
        metadata: {
          targetEmail: target.email,
          revokedReviewerAssignments: revokedAssignments,
        },
      });

      // ACCOUNT_DEACTIVATED notification — must be in the same transaction (C3 §6, §9).
      // If this insertion fails, the whole transaction rolls back.
      await enqueueAccountDeactivated(outbox, tx, {
        toEmail: target.email,
        userId: targetUserId,
      });
    });
  }
}
