import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { PrismaStudentProfileRepository } from "../../src/modules/student-profile/student-profile.repository";
import { StudentProfileService } from "../../src/modules/student-profile/student-profile.service";
import { createUpdateStudentProfileSchema } from "../../src/modules/student-profile/student-profile.validation";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `sprof-it-${run}-`;
const schema = createUpdateStudentProfileSchema();
const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "student profile completion on PostgreSQL (C1-F)",
  () => {
    let prisma: PrismaClient;
    let service: StudentProfileService;
    let reviewerId: string;
    const email = (label: string) => `${emailPrefix}${label}@example.test`;
    const actorOf = (userId: string, profileId: string) =>
      ({
        userId,
        status: "ACTIVE",
        roles: new Set(["STUDENT"]),
        profileIds: { student: profileId, organizationSupervisor: [] },
      }) as unknown as ActorContext;

    async function makeStudent(label: string, registrationStatus: "CONFIRMED" | "PENDING" = "CONFIRMED") {
      const userId = randomUUID();
      const digits = String(Math.floor(Math.random() * 900) + 100);
      await prisma.user.create({
        data: {
          id: userId,
          email: email(label),
          name: `Student ${label}`,
          passwordHash: "x",
          status: "ACTIVE",
          emailVerifiedAt: new Date(),
          roles: { create: [{ role: "STUDENT" }] },
        },
      });
      const profile = await prisma.studentProfile.create({
        data: {
          userId,
          registrationNumber: `SPR-${digits}-001/2099`,
          registrationDepartmentCode: "SPR",
          registrationStatus,
          ...(registrationStatus === "CONFIRMED"
            ? {
                registrationDecidedAt: new Date(),
                registrationDecidedByUserId: reviewerId,
                registrationDecisionBasis: "test",
              }
            : {}),
        },
      });
      return { userId, profileId: profile.id };
    }

    async function cleanup() {
      const users = await prisma.user.findMany({
        where: { email: { startsWith: emailPrefix } },
        select: { id: true },
      });
      const ids = users.map(({ id }) => id);
      if (ids.length === 0) return;
      const profiles = await prisma.studentProfile.findMany({
        where: { userId: { in: ids } },
        select: { id: true },
      });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ actorUserId: { in: ids } }, { targetId: { in: profiles.map(({ id }) => id) } }] },
      });
      await prisma.studentProfile.deleteMany({ where: { userId: { in: ids } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
      if (!connectionString) throw new Error("TEST_DATABASE_URL is required.");
      if (!enabled || !disposableConfirmed) {
        throw new Error("Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true.");
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing student profile integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run student profile integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `student-profile-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 4 }) });
      service = new StudentProfileService({
        repo: new PrismaStudentProfileRepository(),
        audit: new PrismaAuditRepository(),
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 }),
      });
    }, 60_000);

    beforeEach(async () => {
      await cleanup();
      reviewerId = randomUUID();
      await prisma.user.create({
        data: {
          id: reviewerId,
          email: email("reviewer"),
          name: "reviewer",
          passwordHash: "x",
          status: "ACTIVE",
          roles: { create: [{ role: "UNIVERSITY_SUPERVISOR" }] },
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await cleanup();
      await prisma.$disconnect();
    });

    it("persists the seven fields, computes completion, and leaves registration data untouched", async () => {
      const student = await makeStudent("complete");
      const before = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.profileId } });
      const view = await service.update(
        actorOf(student.userId, student.profileId),
        schema.parse({
          university: "Example University",
          faculty: "Computing",
          department: "Information Technology",
          course: "BSc Information Technology",
          yearOfStudy: 3,
          phone: "0712 345 678",
          expectedGraduation: nextYear,
        }),
      );
      expect(view.isComplete).toBe(true);
      const saved = await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.profileId } });
      expect(saved).toMatchObject({ university: "Example University", yearOfStudy: 3, phone: "+254712345678" });
      expect(saved.expectedGraduation?.toISOString().slice(0, 10)).toBe(nextYear);
      expect(saved).toMatchObject({
        registrationNumber: before.registrationNumber,
        registrationStatus: "CONFIRMED",
        registrationDepartmentCode: "SPR",
        registrationDecisionBasis: "test",
      });
    });

    it("clears a field with null and records field names only in the audit log", async () => {
      const student = await makeStudent("clear");
      const actor = actorOf(student.userId, student.profileId);
      await service.update(actor, schema.parse({ phone: "0712345678", university: "Example University" }));
      const view = await service.update(actor, schema.parse({ phone: null }));
      expect(view.phone).toBeNull();
      expect((await prisma.studentProfile.findUniqueOrThrow({ where: { id: student.profileId } })).phone).toBeNull();

      const audit = await prisma.auditLog.findMany({
        where: { targetId: student.profileId },
        orderBy: { occurredAt: "asc" },
      });
      expect(audit.map((a) => a.action)).toEqual(["STUDENT_PROFILE_UPDATED", "STUDENT_PROFILE_UPDATED"]);
      expect(audit.map((a) => a.metadata)).toEqual([{ fields: ["phone", "university"] }, { fields: ["phone"] }]);
      expect(JSON.stringify(audit)).not.toMatch(/254712345678|Example University/);
    });

    it("never writes through another student's profile or an unconfirmed one", async () => {
      const owner = await makeStudent("owner");
      const intruder = await makeStudent("intruder");
      const pending = await makeStudent("pending", "PENDING");

      await expect(
        service.update(actorOf(intruder.userId, owner.profileId), schema.parse({ phone: "0712345678" })),
      ).rejects.toThrow();
      await expect(
        service.update(actorOf(pending.userId, pending.profileId), schema.parse({ phone: "0712345678" })),
      ).rejects.toThrow();
      expect((await prisma.studentProfile.findUniqueOrThrow({ where: { id: owner.profileId } })).phone).toBeNull();
      expect((await prisma.studentProfile.findUniqueOrThrow({ where: { id: pending.profileId } })).phone).toBeNull();
      expect(
        await prisma.auditLog.count({ where: { targetId: { in: [owner.profileId, pending.profileId] } } }),
      ).toBe(0);
    });
  },
);
