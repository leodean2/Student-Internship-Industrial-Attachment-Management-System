import { Prisma, type UserRoleName } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditRepository } from "../../src/modules/audit/audit.repository";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { RegistrationReviewPolicy } from "../../src/modules/registration-reviewer/registration-review.policy";
import type {
  RegistrationReviewerRepository,
  ReviewerAssignment,
} from "../../src/modules/registration-reviewer/registration-reviewer.repository";
import { RegistrationReviewerService } from "../../src/modules/registration-reviewer/registration-reviewer.service";

const actorOf = (userId: string, ...roles: UserRoleName[]): ActorContext => ({
  userId,
  status: "ACTIVE",
  roles: new Set(roles),
  profileIds: { organizationSupervisor: [] },
});
const admin = actorOf("admin-1", "ADMIN");
const SUP = "7d2b8c1e-3f4a-4b5c-8d6e-9f0a1b2c3d4e";

function build(options: { failAudit?: boolean } = {}) {
  const world = {
    users: new Map<string, { status: string; roles: string[] }>([
      [SUP, { status: "ACTIVE", roles: ["UNIVERSITY_SUPERVISOR"] }],
    ]),
    assignments: [] as ReviewerAssignment[],
    audit: [] as AuditEvent[],
    listLimits: [] as number[],
  };
  const runTx: TxRunner = async (fn) => {
    const snapshot = structuredClone(world);
    try {
      return await fn(undefined as unknown as Tx);
    } catch (error) {
      world.assignments = snapshot.assignments;
      world.audit = snapshot.audit;
      throw error;
    }
  };
  const repo: RegistrationReviewerRepository = {
    findGrantTarget: async (_tx, userId) => world.users.get(userId) ?? null,
    insert: async (_tx, input) => {
      if (world.assignments.some((a) => a.userId === input.userId && a.departmentCode === input.departmentCode && !a.revokedAt)) {
        throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
      }
      const row: ReviewerAssignment = {
        ...input,
        grantedAt: new Date(),
        revokedAt: null,
        revokedByUserId: null,
      };
      world.assignments.push(row);
      return row;
    },
    findById: async (_tx, id) => world.assignments.find((assignment) => assignment.id === id) ?? null,
    revoke: async (_tx, id, revokedByUserId) => {
      const assignment = world.assignments.find((row) => row.id === id && !row.revokedAt);
      if (!assignment) return false;
      assignment.revokedAt = new Date();
      assignment.revokedByUserId = revokedByUserId;
      return true;
    },
    list: async (_tx, query) => {
      world.listLimits.push(query.limit);
      return world.assignments.filter(
        (assignment) =>
          (query.userId ? assignment.userId === query.userId : true) &&
          (query.departmentCode ? assignment.departmentCode === query.departmentCode : true) &&
          (query.active === undefined || (query.active ? !assignment.revokedAt : !!assignment.revokedAt)),
      ).slice(0, query.limit);
    },
    lockActiveDepartments: async (_tx, userId) =>
      world.assignments
        .filter((assignment) => assignment.userId === userId && !assignment.revokedAt)
        .map((assignment) => assignment.departmentCode),
  };
  const audit: Pick<AuditRepository, "record"> = {
    record: async (_tx, event) => {
      world.audit.push(event);
      if (options.failAudit) throw new Error("audit down");
    },
  };
  const service = new RegistrationReviewerService({ repo, audit, runTx });
  return { service, world, policy: new RegistrationReviewPolicy(repo) };
}

describe("RegistrationReviewerService.grant", () => {
  it("grants to an active university supervisor and audits the assignment", async () => {
    const { service, world } = build();
    const assignment = await service.grant(admin, { userId: SUP, departmentCode: "CIT" });
    expect(assignment).toMatchObject({
      userId: SUP,
      departmentCode: "CIT",
      grantedByUserId: "admin-1",
      revokedAt: null,
    });
    expect(world.audit).toEqual([
      {
        actorUserId: "admin-1",
        action: "REGISTRATION_REVIEWER_GRANTED",
        targetType: "RegistrationReviewer",
        targetId: assignment.id,
        metadata: { targetUserId: SUP, departmentCode: "CIT" },
      },
    ]);
  });

  it("is ADMIN-only", async () => {
    const { service, world } = build();
    await expect(
      service.grant(actorOf("u", "UNIVERSITY_SUPERVISOR"), { userId: SUP, departmentCode: "CIT" }),
    ).rejects.toThrow();
    expect(world.assignments).toHaveLength(0);
  });

  it("refuses self-grants and ineligible targets", async () => {
    const { service, world } = build();
    world.users.set("admin-1", { status: "ACTIVE", roles: ["ADMIN", "UNIVERSITY_SUPERVISOR"] });
    world.users.set("pending", { status: "PENDING_VERIFICATION", roles: ["UNIVERSITY_SUPERVISOR"] });
    world.users.set("deactivated", { status: "DEACTIVATED", roles: ["UNIVERSITY_SUPERVISOR"] });
    world.users.set("student", { status: "ACTIVE", roles: ["STUDENT"] });
    for (const userId of ["admin-1", "pending", "deactivated", "student", "missing"]) {
      await expect(service.grant(admin, { userId, departmentCode: "CIT" })).rejects.toThrow();
    }
    expect(world.assignments).toHaveLength(0);
  });

  it("rejects duplicate active assignments and permits a re-grant after revocation", async () => {
    const { service } = build();
    const first = await service.grant(admin, { userId: SUP, departmentCode: "CIT" });
    await expect(service.grant(admin, { userId: SUP, departmentCode: "CIT" })).rejects.toThrow(/already holds/);
    await service.grant(admin, { userId: SUP, departmentCode: "BUS" });
    await service.revoke(admin, first.id);
    await expect(service.grant(admin, { userId: SUP, departmentCode: "CIT" })).resolves.toMatchObject({
      revokedAt: null,
    });
  });

  it("rolls back the assignment when the audit write fails", async () => {
    const { service, world } = build({ failAudit: true });
    await expect(service.grant(admin, { userId: SUP, departmentCode: "CIT" })).rejects.toThrow("audit down");
    expect(world.assignments).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
  });
});

describe("RegistrationReviewerService.revoke", () => {
  it("revokes once, audits once, and is idempotent", async () => {
    const { service, world } = build();
    const { id } = await service.grant(admin, { userId: SUP, departmentCode: "CIT" });
    await service.revoke(admin, id);
    await service.revoke(admin, id);
    expect(world.assignments[0]).toMatchObject({ revokedByUserId: "admin-1" });
    expect(world.assignments[0]!.revokedAt).not.toBeNull();
    expect(world.audit.filter((event) => event.action === "REGISTRATION_REVIEWER_REVOKED")).toHaveLength(1);
  });

  it("returns not found for unknown assignments and forbids non-admins", async () => {
    const { service } = build();
    await expect(service.revoke(admin, "00000000-0000-4000-8000-000000000000")).rejects.toThrow();
    await expect(service.revoke(actorOf("u", "STUDENT"), "x")).rejects.toThrow();
  });
});

describe("RegistrationReviewerService.list", () => {
  it("filters by active state and is ADMIN-only", async () => {
    const { service, world } = build();
    const first = await service.grant(admin, { userId: SUP, departmentCode: "CIT" });
    await service.grant(admin, { userId: SUP, departmentCode: "BUS" });
    await service.revoke(admin, first.id);
    expect(await service.list(admin, { limit: 50, active: true })).toHaveLength(1);
    expect(await service.list(admin, { limit: 50, active: false })).toHaveLength(1);
    expect(world.listLimits).toEqual([51, 51]);
    await expect(service.list(actorOf("u", "STUDENT"), { limit: 50 })).rejects.toThrow();
  });
});

describe("RegistrationReviewPolicy", () => {
  it("denies users without an assignment, including admins", async () => {
    const { policy } = build();
    const tx = undefined as unknown as Tx;
    await expect(policy.departmentsFor(tx, "admin-1")).rejects.toThrow();
    await expect(policy.assertCanReview(tx, "admin-1", "CIT")).rejects.toThrow();
  });

  it("allows assigned departments, hides others, and stops after revocation", async () => {
    const { service, policy } = build();
    const tx = undefined as unknown as Tx;
    const { id } = await service.grant(admin, { userId: SUP, departmentCode: "CIT" });
    await expect(policy.assertCanReview(tx, SUP, "CIT")).resolves.toBeUndefined();
    await expect(policy.assertCanReview(tx, SUP, "BUS")).rejects.toThrow(/not found/i);
    expect(await policy.departmentsFor(tx, SUP)).toEqual(["CIT"]);
    await service.revoke(admin, id);
    await expect(policy.assertCanReview(tx, SUP, "CIT")).rejects.toThrow();
  });
});
