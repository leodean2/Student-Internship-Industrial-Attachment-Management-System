import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/infrastructure/logger";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { SYSTEM_USER_ID } from "../../src/shared/system-user";
import {
  PrismaStudentRegistrationCleanupRepository,
  type StudentRegistrationCleanupRepository,
} from "../../src/modules/student-registration-cleanup/cleanup.repository";
import { StudentRegistrationCleanupService } from "../../src/modules/student-registration-cleanup/cleanup.service";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_STUDENT_REGISTRATION_CLEANUP_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `cleanup-it-${run}-`;
const userIds: string[] = [];
const jobRunIds: string[] = [];

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "student registration cleanup on PostgreSQL",
  () => {
    let prisma: PrismaClient;
    const logger = createLogger("silent");
    const repository: StudentRegistrationCleanupRepository = new PrismaStudentRegistrationCleanupRepository();
    const cleanupService = () =>
      new StudentRegistrationCleanupService({
        repo: repository,
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 }),
        logger,
      });

    async function createStudent(
      label: string,
      options: {
        status?: "PENDING_VERIFICATION" | "ACTIVE" | "DEACTIVATED";
        registrationStatus?: "PENDING" | "REJECTED";
        emailVerified?: boolean;
        createdDaysAgo?: number;
        decidedDaysAgo?: number;
      } = {},
    ): Promise<{ id: string; profileId: string }> {
      const id = randomUUID();
      const profileId = randomUUID();
      userIds.push(id);
      const status = options.status ?? "PENDING_VERIFICATION";
      const registrationStatus = options.registrationStatus ?? "PENDING";
      const email = `${emailPrefix}${label}@example.test`;

      await prisma.user.create({
        data: {
          id,
          email,
          passwordHash: "integration-hash",
          name: `Cleanup ${label}`,
          status,
          emailVerifiedAt: options.emailVerified ? new Date() : null,
        },
      });
      await prisma.userRole.create({ data: { userId: id, role: "STUDENT" } });
      await prisma.studentProfile.create({
        data: {
          id: profileId,
          userId: id,
          registrationNumber: registrationStatus === "PENDING" ? `CIT-111-${String(userIds.length).padStart(3, "0")}/2099` : null,
          registrationStatus,
          registrationDepartmentCode: "CIT",
          rejectedRegistrationNumber: registrationStatus === "REJECTED" ? `CIT-222-${String(userIds.length).padStart(3, "0")}/2099` : null,
          registrationDecidedAt: registrationStatus === "REJECTED" ? new Date() : null,
          registrationDecidedByUserId: registrationStatus === "REJECTED" ? SYSTEM_USER_ID : null,
          registrationDecisionReason: registrationStatus === "REJECTED" ? "Not on roster" : null,
        },
      });

      if (options.createdDaysAgo !== undefined) {
        await prisma.$executeRaw`
          UPDATE users SET "createdAt" = clock_timestamp() - ${options.createdDaysAgo}::double precision * INTERVAL '1 day'
          WHERE id = ${id}`;
      }
      if (options.decidedDaysAgo !== undefined) {
        await prisma.$executeRaw`
          UPDATE student_profiles
          SET "registrationDecidedAt" = clock_timestamp() - ${options.decidedDaysAgo}::double precision * INTERVAL '1 day'
          WHERE "userId" = ${id}`;
      }
      return { id, profileId };
    }

    async function runCleanup() {
      const result = await cleanupService().run();
      jobRunIds.push(result.jobRunId);
      return result;
    }

    async function cleanupFixtures() {
      for (const id of userIds.splice(0)) {
        await prisma.$executeRaw`DELETE FROM notifications WHERE "recipientUserId" = ${id}`;
        await prisma.$executeRaw`
          DELETE FROM registration_reviewers
          WHERE "userId" = ${id} OR "grantedByUserId" = ${id} OR "revokedByUserId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM audit_logs WHERE "actorUserId" = ${id} OR "targetId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM email_outbox WHERE "relatedUserId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM email_verification_tokens WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM student_profiles WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM user_roles WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM users WHERE id = ${id}`;
      }
      for (const id of jobRunIds.splice(0)) {
        await prisma.$executeRaw`DELETE FROM job_runs WHERE id = ${id}`;
      }
    }

    beforeAll(async () => {
      if (!connectionString) return;
      if (!enabled || !disposableConfirmed) {
        throw new Error(
          "Set RUN_STUDENT_REGISTRATION_CLEANUP_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true for a disposable database.",
        );
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing student registration cleanup integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run student registration cleanup integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `student-registration-cleanup-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 6 }) });
      await prisma.$connect();

      const systemUser = await prisma.user.findUnique({ where: { id: SYSTEM_USER_ID }, select: { id: true } });
      if (!systemUser) throw new Error("The disposable integration database is missing the seeded SYSTEM user.");
    }, 60_000);

    beforeEach(cleanupFixtures, 60_000);
    afterAll(async () => {
      if (!prisma) return;
      await cleanupFixtures();
      await prisma.$disconnect();
    });

    it("retains a younger unverified registration and removes registrations exactly and beyond 14 days old", async () => {
      const younger = await createStudent("younger", { createdDaysAgo: 13.99 });
      const exact = await createStudent("exact", { createdDaysAgo: 14 });
      const older = await createStudent("older", { createdDaysAgo: 15 });

      const exactBoundaryCandidate = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE users
          SET "createdAt" = date_trunc('milliseconds', transaction_timestamp() - INTERVAL '14 days')
          WHERE id = ${exact.id}`;
        return repository.findEligibleUserIds(tx, 100);
      });
      expect(exactBoundaryCandidate).toContain(exact.id);

      const result = await runCleanup();

      expect(result).toMatchObject({ itemsProcessed: 2, itemsDeleted: 2, itemsFailed: 0, status: "SUCCESS" });
      expect(await prisma.user.findUnique({ where: { id: younger.id } })).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: exact.id } })).toBeNull();
      expect(await prisma.user.findUnique({ where: { id: older.id } })).toBeNull();
    });

    it("uses rejection decision time rather than registration creation time", async () => {
      const oldRegistrationRecentDecision = await createStudent("recent-decision", {
        registrationStatus: "REJECTED",
        createdDaysAgo: 90,
        decidedDaysAgo: 13,
      });
      const newRegistrationOldDecision = await createStudent("old-decision", {
        registrationStatus: "REJECTED",
        createdDaysAgo: 1,
        decidedDaysAgo: 14,
      });

      await runCleanup();

      expect(await prisma.user.findUnique({ where: { id: oldRegistrationRecentDecision.id } })).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: newRegistrationOldDecision.id } })).toBeNull();
    });

    it("evaluates rejected registrations independently of a newer registration with another email", async () => {
      const oldRejected = await createStudent("old-rejected", {
        registrationStatus: "REJECTED",
        createdDaysAgo: 45,
        decidedDaysAgo: 20,
      });
      const newRegistration = await createStudent("new-email-registration", { createdDaysAgo: 1 });

      await runCleanup();

      expect(await prisma.user.findUnique({ where: { id: oldRejected.id } })).toBeNull();
      expect(await prisma.user.findUnique({ where: { id: newRegistration.id } })).not.toBeNull();
    });

    it("retains verified pending registrations, active students, and non-student accounts", async () => {
      const verifiedPending = await createStudent("verified-pending", {
        emailVerified: true,
        createdDaysAgo: 45,
      });
      const activeStudent = await createStudent("active", { status: "ACTIVE", createdDaysAgo: 45 });
      const nonStudentId = randomUUID();
      userIds.push(nonStudentId);
      await prisma.user.create({
        data: {
          id: nonStudentId,
          email: `${emailPrefix}non-student@example.test`,
          passwordHash: "integration-hash",
          name: "Non-student",
          status: "PENDING_VERIFICATION",
        },
      });
      await prisma.userRole.create({ data: { userId: nonStudentId, role: "UNIVERSITY_SUPERVISOR" } });

      const result = await runCleanup();

      expect(result.itemsDeleted).toBe(0);
      expect(await prisma.user.findUnique({ where: { id: verifiedPending.id } })).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: activeStudent.id } })).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: nonStudentId } })).not.toBeNull();
    });

    it("preserves audit rows and original actor attribution while removing the profile", async () => {
      const student = await createStudent("audit", { createdDaysAgo: 15 });
      await prisma.$executeRaw`
        INSERT INTO audit_logs (id, "actorUserId", action, "targetType", "targetId", metadata)
        VALUES (${randomUUID()}, ${student.id}, 'STUDENT_REGISTERED', 'User', ${student.id}, '{"role":"STUDENT"}'::jsonb)`;

      await runCleanup();

      const audit = await prisma.$queryRaw<
        { actorUserId: string; targetId: string; metadata: Record<string, unknown> }[]
      >`SELECT "actorUserId", "targetId", metadata FROM audit_logs WHERE "targetId" = ${student.id}`;
      expect(audit).toEqual([
        {
          actorUserId: SYSTEM_USER_ID,
          targetId: student.id,
          metadata: { role: "STUDENT", originalActorUserId: student.id },
        },
      ]);
      expect(await prisma.studentProfile.findUnique({ where: { userId: student.id } })).toBeNull();
    });

    it("deletes read and unread recipient notifications but preserves other users' notifications and audit logs", async () => {
      const student = await createStudent("notifications", { createdDaysAgo: 15 });
      const otherRecipient = await createStudent("other-recipient", {
        emailVerified: true,
        createdDaysAgo: 45,
      });
      await prisma.notification.createMany({
        data: [
          {
            recipientUserId: student.id,
            type: "REGISTRATION",
            title: "Unread",
            message: "Student notification",
          },
          {
            recipientUserId: student.id,
            type: "REGISTRATION",
            title: "Read",
            message: "Student notification",
            readAt: new Date(),
          },
          {
            recipientUserId: otherRecipient.id,
            type: "REGISTRATION",
            title: "Other recipient",
            message: "Keep this notification",
          },
        ],
      });
      await prisma.$executeRaw`
        INSERT INTO audit_logs (id, "actorUserId", action, "targetType", "targetId")
        VALUES (${randomUUID()}, ${student.id}, 'STUDENT_REGISTERED', 'User', ${student.id})`;

      await runCleanup();

      expect(await prisma.notification.count({ where: { recipientUserId: student.id } })).toBe(0);
      expect(await prisma.notification.count({ where: { recipientUserId: otherRecipient.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { targetId: student.id } })).toBe(1);
    });

    it("removes verification tokens and every related outbox record regardless of status", async () => {
      const student = await createStudent("outbox", { createdDaysAgo: 15 });
      await prisma.emailVerificationToken.create({
        data: {
          userId: student.id,
          tokenHash: `hash-${student.id}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const outboxIds: string[] = [];
      for (const status of ["PENDING", "PROCESSING", "FAILED", "SENT"] as const) {
        const id = randomUUID();
        outboxIds.push(id);
        await prisma.emailOutbox.create({
          data: {
            id,
            toEmail: `${emailPrefix}outbox@example.test`,
            relatedUserId: student.id,
            templateType: "EMAIL_VERIFICATION_REQUESTED",
            payload: { verificationUrl: "https://example.test/verify?token=secret" },
            status,
            idempotencyKey: `cleanup-${id}`,
            ...(status === "PROCESSING"
              ? { claimToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000), processingStartedAt: new Date() }
              : {}),
            ...(status === "SENT" ? { sentAt: new Date() } : {}),
          },
        });
      }

      await runCleanup();

      expect(await prisma.emailVerificationToken.count({ where: { userId: student.id } })).toBe(0);
      expect(await prisma.emailOutbox.count({ where: { id: { in: outboxIds } } })).toBe(0);
    });

    it("does not race an outbox worker holding a related row lock", async () => {
      const student = await createStudent("worker-lock", { createdDaysAgo: 15 });
      const outboxId = randomUUID();
      await prisma.emailOutbox.create({
        data: {
          id: outboxId,
          toEmail: `${emailPrefix}worker-lock@example.test`,
          relatedUserId: student.id,
          templateType: "EMAIL_VERIFICATION_REQUESTED",
          payload: { verificationUrl: "https://example.test/verify?token=secret" },
          status: "PROCESSING",
          idempotencyKey: `cleanup-lock-${outboxId}`,
        },
      });

      let releaseLock: (() => void) | undefined;
      let lockAcquired: (() => void) | undefined;
      const acquired = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const workerTransaction = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM email_outbox WHERE id = ${outboxId} FOR UPDATE`;
        lockAcquired?.();
        await lockReleased;
      }, { timeout: 30_000 });
      await acquired;

      let blocked: Awaited<ReturnType<typeof runCleanup>>;
      try {
        blocked = await runCleanup();
      } finally {
        releaseLock?.();
        await workerTransaction;
      }
      expect(blocked).toMatchObject({ itemsDeleted: 0, itemsFailed: 1, status: "FAILED" });
      expect(await prisma.user.findUnique({ where: { id: student.id } })).not.toBeNull();
      expect(await prisma.emailOutbox.count({ where: { id: outboxId } })).toBe(1);

      const retried = await runCleanup();
      expect(retried).toMatchObject({ itemsDeleted: 1, itemsFailed: 0, status: "SUCCESS" });
      expect(await prisma.emailOutbox.count({ where: { id: outboxId } })).toBe(0);
    });

    it("records successful no-op runs and is safe to repeat", async () => {
      const student = await createStudent("repeat", { createdDaysAgo: 15 });
      const first = await runCleanup();
      const second = await runCleanup();

      expect(first.itemsDeleted).toBe(1);
      expect(second).toMatchObject({ itemsProcessed: 0, itemsDeleted: 0, itemsFailed: 0, status: "SUCCESS" });
      expect(await prisma.user.findUnique({ where: { id: student.id } })).toBeNull();
      const runs = await prisma.jobRun.findMany({
        where: { id: { in: [first.jobRunId, second.jobRunId] } },
        orderBy: { startedAt: "asc" },
      });
      expect(runs.map((job) => job.status)).toEqual(["SUCCESS", "SUCCESS"]);
    });

    it("rolls back all per-user cleanup changes when another FK prevents deletion", async () => {
      const student = await createStudent("rollback", { createdDaysAgo: 15 });
      const independent = await createStudent("rollback-independent", { createdDaysAgo: 15 });
      await prisma.emailVerificationToken.create({
        data: {
          userId: student.id,
          tokenHash: `rollback-${student.id}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.emailOutbox.create({
        data: {
          id: randomUUID(),
          toEmail: `${emailPrefix}rollback@example.test`,
          relatedUserId: student.id,
          templateType: "EMAIL_VERIFICATION_REQUESTED",
          payload: { verificationUrl: "https://example.test/verify?token=secret" },
          idempotencyKey: `cleanup-rollback-${student.id}`,
        },
      });
      await prisma.$executeRaw`
        INSERT INTO audit_logs (id, "actorUserId", action, "targetType", "targetId")
        VALUES (${randomUUID()}, ${student.id}, 'STUDENT_REGISTERED', 'User', ${student.id})`;
      await prisma.registrationReviewer.create({
        data: {
          id: randomUUID(),
          userId: student.id,
          departmentCode: "CIT",
          grantedByUserId: SYSTEM_USER_ID,
        },
      });

      const result = await runCleanup();

      expect(result).toMatchObject({ itemsProcessed: 2, itemsDeleted: 1, itemsFailed: 1, status: "PARTIAL_FAILURE" });
      expect(await prisma.user.findUnique({ where: { id: student.id } })).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: independent.id } })).toBeNull();
      expect(await prisma.studentProfile.findUnique({ where: { userId: student.id } })).not.toBeNull();
      expect(await prisma.userRole.count({ where: { userId: student.id, role: "STUDENT" } })).toBe(1);
      expect(await prisma.emailVerificationToken.count({ where: { userId: student.id } })).toBe(1);
      expect(await prisma.emailOutbox.count({ where: { relatedUserId: student.id, status: "PENDING" } })).toBe(1);
      const audit = await prisma.auditLog.findFirst({ where: { targetId: student.id } });
      expect(audit?.actorUserId).toBe(student.id);
      expect(await prisma.registrationReviewer.count({ where: { userId: student.id } })).toBe(1);
    });

    it("rolls back all cleanup changes when deleting the student's notifications fails", async () => {
      const student = await createStudent("notification-rollback", { createdDaysAgo: 15 });
      await prisma.notification.create({
        data: {
          recipientUserId: student.id,
          type: "TEST",
          title: "Test",
          message: "Notification deletion rollback fixture.",
        },
      });
      await prisma.emailVerificationToken.create({
        data: {
          userId: student.id,
          tokenHash: `notification-rollback-${student.id}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const functionName = `cleanup_reject_notification_delete_${run}`;
      const triggerName = `cleanup_reject_notification_delete_${run}`;
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'simulated notification deletion failure';
        END;
        $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE DELETE ON notifications
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);

      try {
        const result = await runCleanup();
        expect(result).toMatchObject({ itemsProcessed: 1, itemsDeleted: 0, itemsFailed: 1, status: "FAILED" });
        expect(await prisma.user.findUnique({ where: { id: student.id } })).not.toBeNull();
        expect(await prisma.studentProfile.findUnique({ where: { userId: student.id } })).not.toBeNull();
        expect(await prisma.emailVerificationToken.count({ where: { userId: student.id } })).toBe(1);
        expect(await prisma.notification.count({ where: { recipientUserId: student.id } })).toBe(1);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON notifications`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      }
    });
  },
);
