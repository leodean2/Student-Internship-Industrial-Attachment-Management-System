import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { PrismaOutboxRepository } from "../../src/modules/email-outbox/outbox.repository";
import { PrismaRegistrationReviewRepository } from "../../src/modules/registration-review/registration-review.repository";
import { RegistrationReviewService } from "../../src/modules/registration-review/registration-review.service";
import { RegistrationReviewPolicy } from "../../src/modules/registration-reviewer/registration-review.policy";
import { PrismaRegistrationReviewerRepository } from "../../src/modules/registration-reviewer/registration-reviewer.repository";
import { departmentCodeOf } from "../../src/shared/registration-number";
import { RosterLookup } from "../../src/modules/student-roster/roster-lookup";
import { PrismaStudentRosterRepository } from "../../src/modules/student-roster/student-roster.repository";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `rev-queue-${run}-`;
const runDigits = String(Math.floor(Math.random() * 900) + 100);
const reservedNumbers = new Set<string>();
const number = (department: "ZZA" | "ZZB", n: number): string => {
  const value = `${department}-${runDigits}-${String(n).padStart(3, "0")}/2099`;
  reservedNumbers.add(value);
  return value;
};
const BASIS = { basis: "checked against the roster" };
const REASON = { reason: "does not match the roster" };

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "registration review on PostgreSQL (C1-D3)",
  () => {
    let prisma: PrismaClient;
    let service: RegistrationReviewService;
    let adminId: string;
    let rosterImportId: string;
    const rosterRepo = new PrismaStudentRosterRepository();
    const email = (label: string) => `${emailPrefix}${label}@example.test`;
    const actorOf = (userId: string) =>
      ({
        userId,
        status: "ACTIVE",
        roles: new Set(["UNIVERSITY_SUPERVISOR"]),
        profileIds: { organizationSupervisor: [] },
      }) as unknown as ActorContext;

    const build = (audit = new PrismaAuditRepository()) =>
      new RegistrationReviewService({
        repo: new PrismaRegistrationReviewRepository(),
        policy: new RegistrationReviewPolicy(new PrismaRegistrationReviewerRepository()),
        roster: new RosterLookup(rosterRepo),
        rosterRepo,
        audit,
        outbox: new PrismaOutboxRepository(),
        appBaseUrl: "https://app.example.test",
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 30_000 }),
      });

    async function makeReviewer(label: string, departments: string[]) {
      const id = randomUUID();
      await prisma.user.create({
        data: {
          id,
          email: email(label),
          name: label,
          passwordHash: "x",
          status: "ACTIVE",
          roles: { create: [{ role: "UNIVERSITY_SUPERVISOR" }] },
        },
      });
      for (const departmentCode of departments) {
        await prisma.registrationReviewer.create({
          data: { userId: id, departmentCode, grantedByUserId: adminId },
        });
      }
      return id;
    }

    async function makeStudent(label: string, registrationNumber: string, verified = true) {
      const userId = randomUUID();
      await prisma.user.create({
        data: {
          id: userId,
          email: email(label),
          name: `Student ${label}`,
          passwordHash: "x",
          status: "PENDING_VERIFICATION",
          emailVerifiedAt: verified ? new Date() : null,
          roles: { create: [{ role: "STUDENT" }] },
        },
      });
      const profile = await prisma.studentProfile.create({
        data: {
          userId,
          registrationNumber,
          registrationDepartmentCode: departmentCodeOf(registrationNumber),
        },
      });
      return { userId, profileId: profile.id };
    }

    const addRoster = (registrationNumber: string, rosterStatus = "ACTIVE") =>
      prisma.studentRosterEntry.create({
        data: {
          registrationNumber,
          departmentCode: departmentCodeOf(registrationNumber),
          studentName: null,
          rosterStatus,
          importId: rosterImportId,
        },
      });
    const profileOf = (profileId: string) => prisma.studentProfile.findUniqueOrThrow({ where: { id: profileId } });
    const userOf = (userId: string) => prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const outboxFor = (userId: string) => prisma.emailOutbox.findMany({ where: { relatedUserId: userId } });
    const invariantViolations = () =>
      prisma.$queryRaw<{ id: string }[]>`
        SELECT u.id FROM users u
        JOIN user_roles r ON r."userId" = u.id AND r.role = 'STUDENT'
        JOIN student_profiles p ON p."userId" = u.id
        WHERE u.email LIKE ${`${emailPrefix}%`}
          AND u.status = 'ACTIVE'
          AND (u."emailVerifiedAt" IS NULL OR p."registrationStatus" <> 'CONFIRMED')`;

    async function cleanup() {
      const users = await prisma.user.findMany({
        where: { email: { startsWith: emailPrefix } },
        select: { id: true },
      });
      const ids = users.map(({ id }) => id);
      if (reservedNumbers.size > 0) {
        await prisma.studentRosterEntry.deleteMany({
          where: { registrationNumber: { in: [...reservedNumbers] } },
        });
      }
      if (ids.length === 0) return;
      const profiles = await prisma.studentProfile.findMany({
        where: { userId: { in: ids } },
        select: { id: true },
      });
      await prisma.emailOutbox.deleteMany({ where: { relatedUserId: { in: ids } } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { actorUserId: { in: ids } },
            { targetId: { in: [...ids, ...profiles.map(({ id }) => id)] } },
          ],
        },
      });
      await prisma.studentProfile.deleteMany({ where: { userId: { in: ids } } });
      await prisma.registrationReviewer.deleteMany({
        where: { OR: [{ userId: { in: ids } }, { grantedByUserId: { in: ids } }] },
      });
      await prisma.studentRosterImport.deleteMany({ where: { importedByUserId: { in: ids } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
      if (!connectionString) throw new Error("TEST_DATABASE_URL is required for enabled registration review tests.");
      if (!enabled || !disposableConfirmed) {
        throw new Error("Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true for a disposable database.");
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing registration review integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run registration review integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `registration-review-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 8 }) });
      service = build();
    }, 60_000);

    beforeEach(async () => {
      await cleanup();
      adminId = randomUUID();
      await prisma.user.create({
        data: {
          id: adminId,
          email: email("admin"),
          name: "admin",
          passwordHash: "x",
          status: "ACTIVE",
          roles: { create: [{ role: "ADMIN" }] },
        },
      });
      const rosterImport = await prisma.studentRosterImport.create({
        data: {
          importedByUserId: adminId,
          fileSha256: "x",
          rowCount: 0,
          insertedCount: 0,
          skippedCount: 0,
          conflictCount: 0,
          invalidCount: 0,
          duplicateCount: 0,
        },
      });
      rosterImportId = rosterImport.id;
    });

    afterAll(async () => {
      if (!prisma) return;
      await cleanup();
      await prisma.$disconnect();
    });

    it("confirms, activates, queues email and audits without sensitive metadata", async () => {
      const reviewer = await makeReviewer("reviewer", ["ZZA"]);
      const registrationNumber = number("ZZA", 1);
      const student = await makeStudent("student", registrationNumber);
      await addRoster(registrationNumber);
      await service.confirm(actorOf(reviewer), student.profileId, BASIS);

      expect(await profileOf(student.profileId)).toMatchObject({
        registrationStatus: "CONFIRMED",
        registrationDecidedByUserId: reviewer,
        registrationDecisionBasis: BASIS.basis,
      });
      expect((await userOf(student.userId)).status).toBe("ACTIVE");
      expect(await outboxFor(student.userId)).toMatchObject([
        { templateType: "REGISTRATION_CONFIRMED", status: "PENDING", toEmail: email("student") },
      ]);
      const audit = await prisma.auditLog.findMany({ where: { targetId: student.profileId } });
      expect(audit.map(({ action }) => action)).toEqual(["REGISTRATION_NUMBER_CONFIRMED"]);
      const metadata = JSON.stringify(audit.map(({ metadata: data }) => data));
      for (const secret of [registrationNumber, BASIS.basis, "Student student"]) expect(metadata).not.toContain(secret);
      expect(await invariantViolations()).toEqual([]);
    });

    it("blocks confirmation for unverified, unmatched and ineligible registrations", async () => {
      const reviewer = await makeReviewer("reviewer-block", ["ZZA"]);
      const unverified = await makeStudent("unverified", number("ZZA", 2), false);
      const missing = await makeStudent("missing", number("ZZA", 3));
      const ineligibleNumber = number("ZZA", 4);
      const ineligible = await makeStudent("ineligible", ineligibleNumber);
      await addRoster(number("ZZA", 2));
      await addRoster(ineligibleNumber, "WITHDRAWN");

      for (const student of [unverified, missing, ineligible]) {
        await expect(service.confirm(actorOf(reviewer), student.profileId, BASIS)).rejects.toThrow();
        expect((await profileOf(student.profileId)).registrationStatus).toBe("PENDING");
        expect((await userOf(student.userId)).status).toBe("PENDING_VERIFICATION");
        expect(await outboxFor(student.userId)).toHaveLength(0);
      }
      expect(await invariantViolations()).toEqual([]);
    });

    it("does not activate an account if email verification changes during confirmation", async () => {
      const reviewer = await makeReviewer("reviewer-verification-race", ["ZZA"]);
      const registrationNumber = number("ZZA", 41);
      const student = await makeStudent("verification-race", registrationNumber);
      await addRoster(registrationNumber);

      const functionName = `clear_verification_during_confirm_${run}`;
      const triggerName = `clear_verification_during_confirm_${run}`;
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE users SET "emailVerifiedAt" = NULL WHERE id = NEW."userId";
          RETURN NEW;
        END; $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE UPDATE OF "registrationStatus" ON student_profiles
        FOR EACH ROW
        WHEN (OLD."registrationStatus" = 'PENDING' AND NEW."registrationStatus" = 'CONFIRMED')
        EXECUTE FUNCTION "${functionName}"()`);

      try {
        await expect(service.confirm(actorOf(reviewer), student.profileId, BASIS))
          .rejects.toMatchObject({ status: 409 });
        expect(await profileOf(student.profileId)).toMatchObject({
          registrationStatus: "PENDING",
          registrationNumber,
        });
        expect(await userOf(student.userId)).toMatchObject({
          status: "PENDING_VERIFICATION",
          emailVerifiedAt: expect.any(Date),
        });
        expect(await outboxFor(student.userId)).toHaveLength(0);
        expect(await prisma.auditLog.count({ where: { targetId: student.profileId } })).toBe(0);
        expect(await invariantViolations()).toEqual([]);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON student_profiles`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      }
    });

    it("rejects a claim, releases its number, and keeps the account pending", async () => {
      const reviewer = await makeReviewer("reviewer-reject", ["ZZA"]);
      const registrationNumber = number("ZZA", 5);
      const student = await makeStudent("rejected", registrationNumber, false);
      await service.reject(actorOf(reviewer), student.profileId, REASON);
      expect(await profileOf(student.profileId)).toMatchObject({
        registrationStatus: "REJECTED",
        registrationNumber: null,
        rejectedRegistrationNumber: registrationNumber,
        registrationDecisionReason: REASON.reason,
      });
      expect((await userOf(student.userId)).status).toBe("PENDING_VERIFICATION");
      expect(await outboxFor(student.userId)).toMatchObject([{ templateType: "REGISTRATION_REJECTED" }]);
      const metadata = JSON.stringify(
        (await prisma.auditLog.findMany({ where: { targetId: student.profileId } })).map(({ metadata: data }) => data),
      );
      expect(metadata).not.toContain(REASON.reason);
      expect(metadata).not.toContain(registrationNumber);

      const replacement = await makeStudent("replacement", registrationNumber);
      expect((await profileOf(replacement.profileId)).registrationNumber).toBe(registrationNumber);
    });

    it("requires authorization for both current and destination departments when correcting", async () => {
      const both = await makeReviewer("reviewer-both", ["ZZA", "ZZB"]);
      const currentOnly = await makeReviewer("reviewer-current", ["ZZA"]);
      const destinationOnly = await makeReviewer("reviewer-destination", ["ZZB"]);
      const student = await makeStudent("correction", number("ZZA", 6));
      const before = await profileOf(student.profileId);
      const correctedNumber = number("ZZB", 6);
      await expect(service.correct(actorOf(currentOnly), student.profileId, { registrationNumber: correctedNumber }))
        .rejects.toMatchObject({ status: 403 });
      await expect(service.correct(actorOf(destinationOnly), student.profileId, { registrationNumber: correctedNumber }))
        .rejects.toMatchObject({ status: 403 });
      expect(await profileOf(student.profileId)).toEqual(before);
      expect(await prisma.auditLog.count({ where: { targetId: student.profileId } })).toBe(0);

      await service.correct(actorOf(both), student.profileId, { registrationNumber: correctedNumber });
      expect(await profileOf(student.profileId)).toMatchObject({
        registrationNumber: correctedNumber,
        registrationDepartmentCode: "ZZB",
        registrationStatus: "PENDING",
        registrationDecidedAt: null,
        registrationDecisionReason: null,
      });
      expect((await prisma.auditLog.findMany({ where: { targetId: student.profileId } })).map(({ action }) => action))
        .toEqual(["REGISTRATION_NUMBER_CORRECTED"]);
    });

    it("serializes confirm against reject and correct so exactly one decision wins", async () => {
      const reviewer = await makeReviewer("reviewer-race", ["ZZA"]);
      const confirmedNumber = number("ZZA", 10);
      const confirmStudent = await makeStudent("confirm-race", confirmedNumber);
      await addRoster(confirmedNumber);
      const confirmedRace = await Promise.allSettled([
        service.confirm(actorOf(reviewer), confirmStudent.profileId, BASIS),
        service.reject(actorOf(reviewer), confirmStudent.profileId, REASON),
      ]);
      expect(confirmedRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const finalProfile = await profileOf(confirmStudent.profileId);
      const finalUser = await userOf(confirmStudent.userId);
      if (finalProfile.registrationStatus === "CONFIRMED") expect(finalUser.status).toBe("ACTIVE");
      else expect(finalUser.status).toBe("PENDING_VERIFICATION");
      expect(await outboxFor(confirmStudent.userId)).toHaveLength(1);

      const correctNumber = number("ZZA", 11);
      const correctionStudent = await makeStudent("correct-race", correctNumber);
      await addRoster(correctNumber);
      const correctedRace = await Promise.allSettled([
        service.confirm(actorOf(reviewer), correctionStudent.profileId, BASIS),
        service.correct(actorOf(reviewer), correctionStudent.profileId, { registrationNumber: number("ZZA", 12) }),
      ]);
      expect(correctedRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const correctedProfile = await profileOf(correctionStudent.profileId);
      const correctedUser = await userOf(correctionStudent.userId);
      if (correctedProfile.registrationStatus === "CONFIRMED") expect(correctedUser.status).toBe("ACTIVE");
      else expect(correctedUser.status).toBe("PENDING_VERIFICATION");
      expect(await invariantViolations()).toEqual([]);
    });

    it("denies review to ADMIN actors and revoked reviewers", async () => {
      const registrationNumber = number("ZZA", 20);
      const student = await makeStudent("denial-student", registrationNumber);
      await addRoster(registrationNumber);

      // ADMIN has no reviewer assignment.
      const adminActor = {
        userId: adminId,
        status: "ACTIVE",
        roles: new Set(["ADMIN"]),
        profileIds: { organizationSupervisor: [] },
      } as unknown as ActorContext;
      await expect(service.confirm(adminActor, student.profileId, BASIS))
        .rejects.toMatchObject({ status: 403 });

      // A supervisor with a revoked assignment is also denied.
      const revokedId = randomUUID();
      await prisma.user.create({
        data: {
          id: revokedId,
          email: email("revoked-reviewer"),
          name: "revoked",
          passwordHash: "x",
          status: "ACTIVE",
          roles: { create: [{ role: "UNIVERSITY_SUPERVISOR" }] },
        },
      });
      const assignment = await prisma.registrationReviewer.create({
        data: { userId: revokedId, departmentCode: "ZZA", grantedByUserId: adminId },
      });
      await prisma.registrationReviewer.update({
        where: { id: assignment.id },
        data: { revokedAt: new Date(), revokedByUserId: adminId },
      });
      await expect(service.confirm(actorOf(revokedId), student.profileId, BASIS))
        .rejects.toMatchObject({ status: 403 });

      // Profile is untouched.
      expect((await profileOf(student.profileId)).registrationStatus).toBe("PENDING");
    });

    it("rejects a correction to a number another profile holds and leaves the profile unchanged", async () => {
      const reviewer = await makeReviewer("reviewer-taken", ["ZZA"]);
      const firstNumber = number("ZZA", 30);
      const heldNumber = number("ZZA", 31);
      const first = await makeStudent("taken-first", firstNumber);
      await makeStudent("taken-second", heldNumber);
      const before = await profileOf(first.profileId);

      await expect(
        service.correct(actorOf(reviewer), first.profileId, { registrationNumber: heldNumber }),
      ).rejects.toThrow(/already registered/i);

      expect(await profileOf(first.profileId)).toEqual(before);
      expect(await prisma.auditLog.count({ where: { targetId: first.profileId } })).toBe(0);
    });

    it("rolls back all changes when a later step in the confirm transaction fails", async () => {
      const reviewer = await makeReviewer("reviewer-rollback", ["ZZA"]);
      const registrationNumber = number("ZZA", 40);
      const student = await makeStudent("rollback-student", registrationNumber);
      await addRoster(registrationNumber);

      const functionName = `fail_confirm_audit_${run}`;
      const triggerName = `fail_confirm_audit_${run}`;
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated audit failure'; END; $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);

      try {
        await expect(service.confirm(actorOf(reviewer), student.profileId, BASIS)).rejects.toThrow();

        // Profile, user status, and outbox must all be unchanged.
        expect((await profileOf(student.profileId)).registrationStatus).toBe("PENDING");
        expect((await userOf(student.userId)).status).toBe("PENDING_VERIFICATION");
        expect(await outboxFor(student.userId)).toHaveLength(0);
        expect(await invariantViolations()).toEqual([]);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON audit_logs`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      }
    });
  },
);
