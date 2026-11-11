import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { RegistrationReviewPolicy } from "../../src/modules/registration-reviewer/registration-review.policy";
import { PrismaRegistrationReviewerRepository } from "../../src/modules/registration-reviewer/registration-reviewer.repository";
import { RegistrationReviewerService } from "../../src/modules/registration-reviewer/registration-reviewer.service";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `rev-it-${run}-`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "registration reviewer permission on PostgreSQL (C1-D1)",
  () => {
    let prisma: PrismaClient;
    let service: RegistrationReviewerService;
    let policy: RegistrationReviewPolicy;
    let adminId: string;
    let adminActor: ActorContext;
    const repo = new PrismaRegistrationReviewerRepository();
    const email = (label: string) => `${emailPrefix}${label}@example.test`;

    const makeUser = async (
      label: string,
      role: "ADMIN" | "UNIVERSITY_SUPERVISOR" | "STUDENT",
      status: "ACTIVE" | "PENDING_VERIFICATION" = "ACTIVE",
    ) => {
      const id = randomUUID();
      await prisma.user.create({
        data: { id, email: email(label), name: label, passwordHash: "x", status, roles: { create: [{ role }] } },
      });
      return id;
    };

    const buildService = (audit = new PrismaAuditRepository()) =>
      new RegistrationReviewerService({
        repo,
        audit,
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 }),
      });

    async function cleanup() {
      const users = await prisma.user.findMany({ where: { email: { startsWith: emailPrefix } }, select: { id: true } });
      const ids = users.map(({ id }) => id);
      if (ids.length === 0) return;
      await prisma.registrationReviewer.deleteMany({
        where: { OR: [{ userId: { in: ids } }, { grantedByUserId: { in: ids } }, { revokedByUserId: { in: ids } }] },
      });
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
      if (!connectionString) {
        throw new Error("TEST_DATABASE_URL is required for enabled registration reviewer integration tests.");
      }
      if (!enabled || !disposableConfirmed) {
        throw new Error(
          "Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true only for a disposable database.",
        );
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing registration reviewer integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run registration reviewer integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `registration-reviewer-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 6 }) });
      service = buildService();
      policy = new RegistrationReviewPolicy(repo);
    }, 60_000);

    beforeEach(async () => {
      await cleanup();
      adminId = await makeUser("admin", "ADMIN");
      adminActor = {
        userId: adminId,
        status: "ACTIVE",
        roles: new Set(["ADMIN"]),
        profileIds: { organizationSupervisor: [] },
      } as unknown as ActorContext;
    });

    afterAll(async () => {
      if (!prisma) return;
      await cleanup();
      await prisma.$disconnect();
    });

    it("grants, audits in the same transaction, and revokes with history kept", async () => {
      const supervisor = await makeUser("sup", "UNIVERSITY_SUPERVISOR");
      const assignment = await service.grant(adminActor, { userId: supervisor, departmentCode: "CIT" });
      expect(assignment).toMatchObject({ userId: supervisor, departmentCode: "CIT", revokedAt: null });
      expect(
        (await prisma.auditLog.findMany({ where: { targetId: assignment.id } })).map((entry) => [
          entry.action,
          entry.actorUserId,
        ]),
      ).toEqual([["REGISTRATION_REVIEWER_GRANTED", adminId]]);

      await service.revoke(adminActor, assignment.id);
      const row = await prisma.registrationReviewer.findUniqueOrThrow({ where: { id: assignment.id } });
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedByUserId).toBe(adminId);
      expect((await prisma.auditLog.findMany({ where: { targetId: assignment.id } })).map((entry) => entry.action).sort()).toEqual([
        "REGISTRATION_REVIEWER_GRANTED",
        "REGISTRATION_REVIEWER_REVOKED",
      ]);
    });

    it("rolls the assignment back when a later step fails", async () => {
      const supervisor = await makeUser("sup-rollback", "UNIVERSITY_SUPERVISOR");
      const real = new PrismaAuditRepository();
      const failing = buildService({
        record: async (tx, entry) => {
          await real.record(tx, entry);
          throw new Error("simulated crash after the audit insert");
        },
      });
      await expect(failing.grant(adminActor, { userId: supervisor, departmentCode: "CIT" })).rejects.toThrow(
        "simulated crash",
      );
      expect(await prisma.registrationReviewer.count({ where: { userId: supervisor } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { actorUserId: adminId, action: "REGISTRATION_REVIEWER_GRANTED" } })).toBe(
        0,
      );
    });

    it("enforces one active assignment per user and department and allows re-grant after revoke", async () => {
      const supervisor = await makeUser("sup-unique", "UNIVERSITY_SUPERVISOR");
      const first = await service.grant(adminActor, { userId: supervisor, departmentCode: "CIT" });
      await expect(service.grant(adminActor, { userId: supervisor, departmentCode: "CIT" })).rejects.toThrow(/already holds/);
      await expect(
        prisma.registrationReviewer.create({
          data: { userId: supervisor, departmentCode: "CIT", grantedByUserId: adminId },
        }),
      ).rejects.toThrow();
      await service.grant(adminActor, { userId: supervisor, departmentCode: "BUS" });
      await service.revoke(adminActor, first.id);
      await expect(service.grant(adminActor, { userId: supervisor, departmentCode: "CIT" })).resolves.toMatchObject({
        revokedAt: null,
      });
    });

    it("rejects ineligible targets and self-grants", async () => {
      const student = await makeUser("student", "STUDENT");
      const pending = await makeUser("pending-sup", "UNIVERSITY_SUPERVISOR", "PENDING_VERIFICATION");
      for (const userId of [student, pending, adminId]) {
        await expect(service.grant(adminActor, { userId, departmentCode: "CIT" })).rejects.toThrow();
      }
      expect(await prisma.registrationReviewer.count({ where: { userId: { in: [student, pending, adminId] } } })).toBe(0);
    });

    it("enforces department-code and revocation-consistency constraints", async () => {
      const supervisor = await makeUser("sup-checks", "UNIVERSITY_SUPERVISOR");
      for (const departmentCode of ["cit", "C", "TOOLONGCODE1", "CI T"]) {
        await expect(
          prisma.registrationReviewer.create({
            data: { userId: supervisor, departmentCode, grantedByUserId: adminId },
          }),
        ).rejects.toThrow();
      }
      await expect(
        prisma.registrationReviewer.create({
          data: {
            userId: supervisor,
            departmentCode: "CIT",
            grantedByUserId: adminId,
            revokedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it("denies missing assignments, conceals other departments, and closes access on revoke", async () => {
      const supervisor = await makeUser("sup-policy", "UNIVERSITY_SUPERVISOR");
      const check = (userId: string, department: string) =>
        prisma.$transaction((tx) => policy.assertCanReview(tx, userId, department));

      await expect(check(adminId, "CIT")).rejects.toThrow();
      await expect(check(supervisor, "CIT")).rejects.toThrow();

      const assignment = await service.grant(adminActor, { userId: supervisor, departmentCode: "CIT" });
      await expect(check(supervisor, "CIT")).resolves.toBeUndefined();
      await expect(check(supervisor, "BUS")).rejects.toThrow(/not found/i);

      await service.revoke(adminActor, assignment.id);
      await expect(check(supervisor, "CIT")).rejects.toThrow();
    });

    it("holds off concurrent revocation until the decision transaction finishes", async () => {
      const supervisor = await makeUser("sup-race", "UNIVERSITY_SUPERVISOR");
      const assignment = await service.grant(adminActor, { userId: supervisor, departmentCode: "CIT" });

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => (locked = resolve));
      const decision = prisma.$transaction(
        async (tx) => {
          await policy.assertCanReview(tx, supervisor, "CIT");
          locked();
          await held;
        },
        { timeout: 30_000 },
      );
      await ready;

      let revokeSettled = false;
      const revoke = service.revoke(adminActor, assignment.id).then(() => {
        revokeSettled = true;
      });
      await sleep(1500);
      expect(revokeSettled).toBe(false);

      release();
      await decision;
      await revoke;
      expect((await prisma.registrationReviewer.findUniqueOrThrow({ where: { id: assignment.id } })).revokedAt).not.toBeNull();
      await expect(
        prisma.$transaction((tx) => policy.assertCanReview(tx, supervisor, "CIT")),
      ).rejects.toThrow();
    });

    it("lists assignments with filters", async () => {
      const supervisor = await makeUser("sup-list", "UNIVERSITY_SUPERVISOR");
      const first = await service.grant(adminActor, { userId: supervisor, departmentCode: "CIT" });
      await service.grant(adminActor, { userId: supervisor, departmentCode: "BUS" });
      await service.revoke(adminActor, first.id);
      expect(await service.list(adminActor, { userId: supervisor, limit: 50 })).toHaveLength(2);
      expect(await service.list(adminActor, { userId: supervisor, active: true, limit: 50 })).toHaveLength(1);
      expect(
        await service.list(adminActor, {
          userId: supervisor,
          departmentCode: "CIT",
          active: false,
          limit: 50,
        }),
      ).toHaveLength(1);
    });
  },
);
