import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { hashToken } from "../../src/shared/security/opaque-token";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import {
  PrismaOutboxRepository,
  type OutboxEnqueuer,
} from "../../src/modules/email-outbox/outbox.repository";
import { PrismaEmailVerificationTokenRepository } from "../../src/modules/student-registration/email-verification-token.repository";
import { PrismaStudentRegistrationRepository } from "../../src/modules/student-registration/student-registration.repository";
import { StudentRegistrationService } from "../../src/modules/student-registration/student-registration.service";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `reg-it-${run}-`;
const runDigits = String(Math.floor(Math.random() * 900) + 100);
const numbers = new Map<string, string>();
const numberFor = (label: string): string => {
  if (!numbers.has(label)) {
    numbers.set(label, `ZZR-${runDigits}-${String(numbers.size + 1).padStart(3, "0")}/2099`);
  }
  return numbers.get(label)!;
};

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "student registration and email verification on PostgreSQL",
  () => {
    let prisma: PrismaClient;
    const context = { ip: "203.0.113.7" };
    const email = (label: string) => `${emailPrefix}${label}@example.test`;
    const input = (label: string) => ({
      name: "Test Student",
      email: email(label),
      registrationNumber: numberFor(label),
      password: "Correct-Horse-9!",
    });

    const makeService = (outbox: OutboxEnqueuer = new PrismaOutboxRepository()) =>
      new StudentRegistrationService({
        users: new PrismaStudentRegistrationRepository(),
        tokens: new PrismaEmailVerificationTokenRepository(),
        outbox,
        audit: new PrismaAuditRepository(),
        appBaseUrl: "https://app.example.test",
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 }),
        hashPassword: async () => "integration-password-hash",
      });

    const userId = async (label: string) =>
      (await prisma.user.findUnique({ where: { email: email(label) }, select: { id: true } }))?.id;

    const outboxRows = (id: string) =>
      prisma.$queryRaw<
        {
          templateType: string;
          idempotencyKey: string;
          relatedUserId: string | null;
          payload: { verificationUrl: string; expiresAt: string } | null;
        }[]
      >`SELECT "templateType", "idempotencyKey", "relatedUserId", payload
        FROM email_outbox WHERE "relatedUserId" = ${id}`;

    const rawTokenFor = async (id: string) => {
      const [row] = await outboxRows(id);
      if (!row?.payload) throw new Error("Expected an unsent verification outbox payload");
      const token = new URL(row.payload.verificationUrl).searchParams.get("token");
      if (!token) throw new Error("Verification URL did not contain a token");
      return token;
    };

    async function cleanup() {
      const users = await prisma.user.findMany({
        where: { email: { startsWith: emailPrefix } },
        select: { id: true },
      });
      for (const { id } of users) {
        await prisma.$executeRaw`DELETE FROM audit_logs WHERE "actorUserId" = ${id} OR "targetId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM email_outbox WHERE "relatedUserId" = ${id}`;
        await prisma.emailVerificationToken.deleteMany({ where: { userId: id } });
        await prisma.studentProfile.deleteMany({ where: { userId: id } });
        await prisma.userRole.deleteMany({ where: { userId: id } });
        await prisma.user.delete({ where: { id } });
      }
    }

    const auditRows = (id: string) =>
      prisma.$queryRaw<
        { action: string; actorUserId: string; targetType: string; metadata: Record<string, unknown> | null }[]
      >`SELECT action, "actorUserId", "targetType", metadata
        FROM audit_logs WHERE "targetId" = ${id} ORDER BY "occurredAt"`;

    const auditRowsForEmail = async (targetEmail: string) => {
      const user = await prisma.user.findUnique({ where: { email: targetEmail }, select: { id: true } });
      return user ? auditRows(user.id) : [];
    };

    beforeAll(async () => {
      if (!connectionString) return;
      if (!enabled || !disposableConfirmed) {
        throw new Error(
          "Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true for a disposable database.",
        );
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing registration integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run registration integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `student-registration-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 6 }) });
      await prisma.$connect();
    }, 60_000);

    beforeEach(cleanup);
    afterAll(async () => {
      if (!prisma) return;
      await cleanup();
      await prisma.$disconnect();
    });

    it("commits user, role, profile, token and outbox row together, storing only hashes", async () => {
      await makeService().register(input("commit"), context);
      const id = (await userId("commit"))!;

      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user).toMatchObject({ status: "PENDING_VERIFICATION", passwordHash: "integration-password-hash" });
      expect(await prisma.userRole.findMany({ where: { userId: id } })).toHaveLength(1);
      expect(await prisma.studentProfile.findUniqueOrThrow({ where: { userId: id } })).toMatchObject({
        registrationNumber: input("commit").registrationNumber,
        registrationStatus: "PENDING",
        registrationDepartmentCode: "ZZR",
      });

      const [token] = await prisma.emailVerificationToken.findMany({ where: { userId: id } });
      const [message] = await outboxRows(id);
      const raw = await rawTokenFor(id);
      expect(token!.tokenHash).toBe(hashToken(raw));
      expect(token!.usedAt).toBeNull();
      expect(message).toMatchObject({
        templateType: "EMAIL_VERIFICATION_REQUESTED",
        idempotencyKey: `email-verification:${token!.tokenHash}`,
      });
      expect(Object.keys(message!.payload!).sort()).toEqual(["expiresAt", "verificationUrl"]);
      expect(JSON.stringify({ user, token })).not.toContain(raw);
      expect(message!.payload!.verificationUrl).toContain(raw);
      expect(user.emailVerifiedAt).toBeNull();
      expect(await auditRows(id)).toEqual([
        { action: "STUDENT_REGISTERED", actorUserId: id, targetType: "User", metadata: { role: "STUDENT" } },
      ]);
    });

    it("rolls every insert back when outbox persistence fails", async () => {
      const real = new PrismaOutboxRepository();
      const failing: OutboxEnqueuer = {
        enqueue: async (tx, message) => {
          await real.enqueue(tx, message);
          throw new Error("simulated failure after outbox insert");
        },
      };

      await expect(makeService(failing).register(input("rollback"), context)).rejects.toThrow("simulated failure");
      expect(await userId("rollback")).toBeUndefined();
      expect(await prisma.studentProfile.count({ where: { registrationNumber: input("rollback").registrationNumber } }))
        .toBe(0);
      const [rollbackOutbox] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM email_outbox WHERE "toEmail" = ${email("rollback")}`;
      expect(rollbackOutbox!.count).toBe(0);
      expect(await auditRowsForEmail(email("rollback"))).toHaveLength(0);
    });

    it("acknowledges existing email silently and rejects a taken registration number", async () => {
      const service = makeService();
      await service.register(input("first"), context);

      const again = await service.register({ ...input("first"), registrationNumber: numberFor("other") }, context);
      expect(again.message).toBeTruthy();
      expect(await prisma.user.count({ where: { email: email("first") } })).toBe(1);
      const [existingEmailOutbox] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM email_outbox WHERE "toEmail" = ${email("first")}`;
      expect(existingEmailOutbox!.count).toBe(1);

      await expect(
        service.register({ ...input("second"), registrationNumber: input("first").registrationNumber }, context),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
      expect(await userId("second")).toBeUndefined();
    });

    it("enforces email and registration-number uniqueness in PostgreSQL", async () => {
      const firstId = randomUUID();
      const secondId = randomUUID();
      await prisma.user.create({
        data: { id: firstId, email: email("unique"), name: "First", passwordHash: "hash" },
      });
      await expect(prisma.user.create({
        data: { id: secondId, email: email("unique"), name: "Second", passwordHash: "hash" },
      })).rejects.toMatchObject({ code: "P2002" });

      await prisma.studentProfile.create({
        data: { userId: firstId, registrationNumber: numberFor("duplicate"), registrationDepartmentCode: "ZZR" },
      });
      await prisma.user.create({
        data: { id: secondId, email: email("unique-two"), name: "Second", passwordHash: "hash" },
      });
      await expect(prisma.studentProfile.create({
        data: { userId: secondId, registrationNumber: numberFor("duplicate"), registrationDepartmentCode: "ZZR" },
      })).rejects.toMatchObject({ code: "P2002" });
    });

    it("verifies email ownership without activating the account", async () => {
      const service = makeService();
      await service.register(input("verify"), context);
      const id = (await userId("verify"))!;
      const token = await rawTokenFor(id);

      expect(await service.verifyEmail({ token }, context)).toEqual({ emailVerified: true });
      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user.status).toBe("PENDING_VERIFICATION");
      expect(user.emailVerifiedAt).not.toBeNull();
      expect((await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: id } })).usedAt).not.toBeNull();
      expect((await auditRows(id)).map(({ action }) => action)).toEqual(["STUDENT_REGISTERED", "EMAIL_VERIFIED"]);
      await expect(service.verifyEmail({ token }, context)).rejects.toMatchObject({ status: 404 });
    });

    it("allows exactly one of two concurrent verifications to win", async () => {
      const service = makeService();
      await service.register(input("race"), context);
      const token = await rawTokenFor((await userId("race"))!);
      const results = await Promise.allSettled([
        service.verifyEmail({ token }, context),
        service.verifyEmail({ token }, context),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    });

    it("rejects expired links and keeps a non-pending account's token unspent", async () => {
      const service = makeService();
      await service.register(input("expired"), context);
      const expiredUserId = (await userId("expired"))!;
      await prisma.emailVerificationToken.updateMany({
        where: { userId: expiredUserId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await expect(service.verifyEmail({ token: await rawTokenFor(expiredUserId) }, context))
        .rejects.toMatchObject({ status: 404 });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: expiredUserId } })).status)
        .toBe("PENDING_VERIFICATION");

      await service.register(input("active"), context);
      const activeUserId = (await userId("active"))!;
      await prisma.user.update({ where: { id: activeUserId }, data: { status: "ACTIVE" } });
      await expect(service.verifyEmail({ token: await rawTokenFor(activeUserId) }, context))
        .rejects.toMatchObject({ status: 404 });
      expect((await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: activeUserId } })).usedAt)
        .toBeNull();
      expect((await auditRows(activeUserId)).map(({ action }) => action)).toEqual(["STUDENT_REGISTERED"]);
    });
  },
);
