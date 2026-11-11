import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ActorContext } from "../auth/actor-context";
import { hasRole } from "../auth/actor-context";
import type { AuditRepository } from "../audit/audit.repository";
import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { Errors } from "../../shared/errors";
import type { GrantReviewerInput, ListReviewersQuery } from "./registration-reviewer.validation";
import type { RegistrationReviewerRepository, ReviewerAssignment } from "./registration-reviewer.repository";

export interface RegistrationReviewerServiceDeps {
  repo: RegistrationReviewerRepository;
  audit: Pick<AuditRepository, "record">;
  runTx: TxRunner;
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

export class RegistrationReviewerService {
  constructor(private readonly deps: RegistrationReviewerServiceDeps) {}

  async grant(actor: ActorContext, input: GrantReviewerInput): Promise<ReviewerAssignment> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();
    if (input.userId === actor.userId) {
      throw Errors.validation([{ path: "userId", message: "You cannot grant review authority to yourself." }]);
    }

    const { repo, audit, runTx } = this.deps;
    try {
      return await runTx(async (tx: Tx) => {
        const target = await repo.findGrantTarget(tx, input.userId);
        if (!target) throw Errors.notFound("User not found.");
        if (target.status !== "ACTIVE" || !target.roles.includes("UNIVERSITY_SUPERVISOR")) {
          throw Errors.validation([
            { path: "userId", message: "Review authority can only be granted to an active university supervisor." },
          ]);
        }

        const id = randomUUID();
        const assignment = await repo.insert(tx, {
          id,
          userId: input.userId,
          departmentCode: input.departmentCode,
          grantedByUserId: actor.userId,
        });
        await audit.record(tx, {
          actorUserId: actor.userId,
          action: "REGISTRATION_REVIEWER_GRANTED",
          targetType: "RegistrationReviewer",
          targetId: id,
          metadata: { targetUserId: input.userId, departmentCode: input.departmentCode },
        });
        return assignment;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw Errors.conflict("This user already holds review authority for that department.");
      }
      throw error;
    }
  }

  async revoke(actor: ActorContext, id: string): Promise<void> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();
    const { repo, audit, runTx } = this.deps;
    await runTx(async (tx: Tx) => {
      const existing = await repo.findById(tx, id);
      if (!existing) throw Errors.notFound("Reviewer assignment not found.");
      if (existing.revokedAt) return;
      if (!(await repo.revoke(tx, id, actor.userId))) return;
      await audit.record(tx, {
        actorUserId: actor.userId,
        action: "REGISTRATION_REVIEWER_REVOKED",
        targetType: "RegistrationReviewer",
        targetId: id,
        metadata: { targetUserId: existing.userId, departmentCode: existing.departmentCode },
      });
    });
  }

  async list(actor: ActorContext, query: ListReviewersQuery): Promise<ReviewerAssignment[]> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();
    return this.deps.runTx((tx: Tx) => this.deps.repo.list(tx, { ...query, limit: query.limit + 1 }));
  }
}
