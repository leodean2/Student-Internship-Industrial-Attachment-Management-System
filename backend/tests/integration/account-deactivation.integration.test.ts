/**
 * C3 Account Deactivation — PostgreSQL integration tests.
 *
 * Guards: TEST_DATABASE_URL, RUN_ACCOUNT_DEACTIVATION_INTEGRATION=true,
 *         OUTBOX_TEST_DB_DISPOSABLE=true, NEON_BRANCH != production, DB = test_db.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/infrastructure/logger";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { SYSTEM_USER_ID } from "../../src/shared/system-user";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import { PrismaOutboxRepository } from "../../src/modules/email-outbox/outbox.repository";
import { ACCOUNT_DEACTIVATED } from "../../src/modules/email-outbox/account-deactivated.payload";
import { PrismaAccountDeactivationRepository } from "../../src/modules/account-deactivation/account-deactivation.repository";
import { AccountDeactivationService } from "../../src/modules/account-deactivation/account-deactivation.service";
import type { ActorContext } from "../../src/modules/auth/actor-context";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_ACCOUNT_DEACTIVATION_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `deact-it-${run}-`;
const userIds: string[] = [];

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "C3 account deactivation on PostgreSQL",
  () => {
    let prisma: PrismaClient;
    const logger = createLogger("silent");

    function makeService() {
      return new AccountDeactivationService({
        repo: new PrismaAccountDeactivationRepository(),
        audit: new PrismaAuditRepository(),
        outbox: new PrismaOutboxRepository(),
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 }),
      });
    }

    async function createUser(
      label: string,
      role: "STUDENT" | "UNIVERSITY_SUPERVISOR" | "ORGANIZATION_SUPERVISOR" | "ADMIN",
      status: "ACTIVE" | "PENDING_VERIFICATION" | "DEACTIVATED" = "ACTIVE",
    ): Promise<{ id: string; email: string; actor: ActorContext }> {
      const id = randomUUID();
      const email = `${emailPrefix}${label}@example.test`;
      userIds.push(id);
      await prisma.user.create({
        data: {
          id,
          email,
          passwordHash: "integration-hash",
          name: `Deact Test ${label}`,
          status,
          emailVerifiedAt: status === "ACTIVE" ? new Date() : null,
          roles: { create: [{ role }] },
        },
      });
      const actor: ActorContext = {
        userId: id,
        status: "ACTIVE",
        roles: new Set([role]),
        profileIds: { organizationSupervisor: [] },
      } as ActorContext;
      return { id, email, actor };
    }

    async function createAdmin(label: string) {
      return createUser(label, "ADMIN");
    }

    async function cleanupFixtures() {
      for (const id of userIds.splice(0)) {
        await prisma.$executeRaw`DELETE FROM notifications WHERE "recipientUserId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM audit_logs WHERE "actorUserId" = ${id} OR "targetId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM email_outbox WHERE "relatedUserId" = ${id}`;
        await prisma.$executeRaw`
          DELETE FROM registration_reviewers
          WHERE "userId" = ${id} OR "grantedByUserId" = ${id} OR "revokedByUserId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM refresh_tokens WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM user_roles WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM users WHERE id = ${id}`;
      }
    }

    beforeAll(async () => {
      if (!connectionString) return;
      if (!enabled || !disposableConfirmed) {
        throw new Error("Set RUN_ACCOUNT_DEACTIVATION_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true.");
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing account-deactivation integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run account-deactivation integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `account-deactivation-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 6 }) });
      await prisma.$connect();
    }, 60_000);

    beforeEach(cleanupFixtures);
    afterAll(async () => {
      if (!prisma) return;
      await cleanupFixtures();
      await prisma.$disconnect();
    });

    // ── Authorization ────────────────────────────────────────────────────────

    it("ADMIN can deactivate an eligible student account", async () => {
      const admin = await createAdmin("admin-student");
      const student = await createUser("student-target", "STUDENT");
      await makeService().deactivate(admin.actor, student.id);
      const user = await prisma.user.findUnique({ where: { id: student.id }, select: { status: true } });
      expect(user?.status).toBe("DEACTIVATED");
    });

    it("ADMIN can deactivate an eligible university supervisor", async () => {
      const admin = await createAdmin("admin-usup");
      const usup = await createUser("usup-target", "UNIVERSITY_SUPERVISOR");
      await makeService().deactivate(admin.actor, usup.id);
      const user = await prisma.user.findUnique({ where: { id: usup.id }, select: { status: true } });
      expect(user?.status).toBe("DEACTIVATED");
    });

    it("ADMIN can deactivate an eligible organization supervisor", async () => {
      const admin = await createAdmin("admin-osup");
      const osup = await createUser("osup-target", "ORGANIZATION_SUPERVISOR");
      await makeService().deactivate(admin.actor, osup.id);
      const user = await prisma.user.findUnique({ where: { id: osup.id }, select: { status: true } });
      expect(user?.status).toBe("DEACTIVATED");
    });

    it("refuses to deactivate a pending-verification account", async () => {
      const admin = await createAdmin("admin-pending");
      const pending = await createUser("pending-target", "STUDENT", "PENDING_VERIFICATION");
      await expect(makeService().deactivate(admin.actor, pending.id)).rejects.toMatchObject({ status: 403 });
      const user = await prisma.user.findUnique({ where: { id: pending.id }, select: { status: true } });
      expect(user?.status).toBe("PENDING_VERIFICATION");
    });

    it("refuses to deactivate the seeded SYSTEM user", async () => {
      const admin = await createAdmin("admin-system");
      const system = await prisma.user.findUnique({ where: { id: SYSTEM_USER_ID }, select: { status: true } });
      expect(system?.status).toBe("ACTIVE");

      await expect(makeService().deactivate(admin.actor, SYSTEM_USER_ID)).rejects.toMatchObject({ status: 403 });
      expect(await prisma.user.findUnique({ where: { id: SYSTEM_USER_ID }, select: { status: true } }))
        .toMatchObject({ status: "ACTIVE" });
    });

    it("non-ADMIN receives 403", async () => {
      const student = await createUser("non-admin-actor", "STUDENT");
      const target = await createUser("non-admin-target", "STUDENT");
      await expect(makeService().deactivate(student.actor, target.id)).rejects.toMatchObject({ status: 403 });
    });

    it("self-deactivation receives 403", async () => {
      const admin = await createAdmin("self-deact");
      await expect(makeService().deactivate(admin.actor, admin.id)).rejects.toMatchObject({ status: 403 });
    });

    it("ADMIN-on-ADMIN deactivation receives 403", async () => {
      const admin1 = await createAdmin("admin1");
      const admin2 = await createAdmin("admin2");
      await expect(makeService().deactivate(admin1.actor, admin2.id)).rejects.toMatchObject({ status: 403 });
    });

    // ── State handling ───────────────────────────────────────────────────────

    it("already-deactivated account returns 409", async () => {
      const admin = await createAdmin("admin-409");
      const target = await createUser("already-deact", "STUDENT", "DEACTIVATED");
      await expect(makeService().deactivate(admin.actor, target.id)).rejects.toMatchObject({ status: 409 });
    });

    it("repeated attempts do not create duplicate audit events or notifications", async () => {
      const admin = await createAdmin("admin-dup");
      const target = await createUser("dup-target", "STUDENT");
      const service = makeService();
      await service.deactivate(admin.actor, target.id);
      await service.deactivate(admin.actor, target.id).catch(() => undefined); // 409 expected

      const auditCount = await prisma.auditLog.count({
        where: { action: "ACCOUNT_DEACTIVATED", targetId: target.id },
      });
      const outboxCount = await prisma.emailOutbox.count({
        where: { relatedUserId: target.id, templateType: ACCOUNT_DEACTIVATED },
      });
      expect(auditCount).toBe(1);
      expect(outboxCount).toBe(1);
    });

    // ── Reviewer assignment revocation ───────────────────────────────────────

    it("deactivating a university supervisor revokes their active reviewer assignments", async () => {
      const admin = await createAdmin("admin-rev");
      const usup = await createUser("usup-rev", "UNIVERSITY_SUPERVISOR");
      // Grant a reviewer assignment.
      const assignmentId = randomUUID();
      await prisma.registrationReviewer.create({
        data: {
          id: assignmentId,
          userId: usup.id,
          departmentCode: "CIT",
          grantedByUserId: SYSTEM_USER_ID,
        },
      });

      await makeService().deactivate(admin.actor, usup.id);

      const assignment = await prisma.registrationReviewer.findUnique({ where: { id: assignmentId } });
      expect(assignment?.revokedAt).not.toBeNull();
      expect(assignment?.revokedByUserId).toBe(admin.id);
    });

    it("historical reviewer assignments remain after deactivation", async () => {
      const admin = await createAdmin("admin-hist");
      const usup = await createUser("usup-hist", "UNIVERSITY_SUPERVISOR");
      const alreadyRevokedId = randomUUID();
      await prisma.registrationReviewer.create({
        data: {
          id: alreadyRevokedId,
          userId: usup.id,
          departmentCode: "CIT",
          grantedByUserId: SYSTEM_USER_ID,
          revokedAt: new Date(),
          revokedByUserId: SYSTEM_USER_ID,
        },
      });

      await makeService().deactivate(admin.actor, usup.id);

      const assignment = await prisma.registrationReviewer.findUnique({ where: { id: alreadyRevokedId } });
      expect(assignment).not.toBeNull();
    });

    // ── Sessions ─────────────────────────────────────────────────────────────

    it("refresh sessions are revoked on deactivation", async () => {
      const admin = await createAdmin("admin-sess");
      const target = await createUser("sess-target", "STUDENT");
      await prisma.$executeRaw`
        INSERT INTO refresh_tokens (id, "userId", "tokenHash", "issuedAt", "expiresAt", "sessionExpiresAt")
        VALUES (${randomUUID()}, ${target.id}, ${"hash-" + target.id}, now(), now() + INTERVAL '7 days', now() + INTERVAL '30 days')`;

      await makeService().deactivate(admin.actor, target.id);

      const active = await prisma.refreshToken.count({ where: { userId: target.id, revokedAt: null } });
      expect(active).toBe(0);
    });

    // ── Notification ─────────────────────────────────────────────────────────

    it("ACCOUNT_DEACTIVATED email is enqueued", async () => {
      const admin = await createAdmin("admin-notif");
      const target = await createUser("notif-target", "STUDENT");
      await makeService().deactivate(admin.actor, target.id);
      const outbox = await prisma.emailOutbox.count({
        where: { relatedUserId: target.id, templateType: ACCOUNT_DEACTIVATED },
      });
      expect(outbox).toBe(1);
    });

    // ── Atomicity ─────────────────────────────────────────────────────────────

    it("concurrent deactivation attempts produce exactly one successful transition", async () => {
      const admin = await createAdmin("admin-conc");
      const target = await createUser("conc-target", "STUDENT");
      const service = makeService();
      const results = await Promise.allSettled([
        service.deactivate(admin.actor, target.id),
        service.deactivate(admin.actor, target.id),
      ]);
      const successes = results.filter((r) => r.status === "fulfilled");
      const failures = results.filter((r) => r.status === "rejected");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const user = await prisma.user.findUnique({ where: { id: target.id }, select: { status: true } });
      expect(user?.status).toBe("DEACTIVATED");

      const auditCount = await prisma.auditLog.count({
        where: { action: "ACCOUNT_DEACTIVATED", targetId: target.id },
      });
      expect(auditCount).toBe(1);
    });

    // ── Historical data preserved ─────────────────────────────────────────────

    it("deactivation does not delete the user record or profile", async () => {
      const admin = await createAdmin("admin-hist2");
      const target = await createUser("hist-target", "STUDENT");
      await makeService().deactivate(admin.actor, target.id);
      const user = await prisma.user.findUnique({ where: { id: target.id } });
      expect(user).not.toBeNull();
      expect(user?.status).toBe("DEACTIVATED");
    });
  },
);
