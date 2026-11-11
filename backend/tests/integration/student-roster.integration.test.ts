import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { RosterLookup } from "../../src/modules/student-roster/roster-lookup";
import { PrismaStudentRosterRepository } from "../../src/modules/student-roster/student-roster.repository";
import { StudentRosterService } from "../../src/modules/student-roster/student-roster.service";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `roster-it-${run}-`;
const numbers = ["ZZT-000-001/2099", "ZZT-000-002/2099", "ZZT-000-003/2099"] as const;
const [N1, N2, N3] = numbers;
const csv = (...lines: string[]) => ["registration_number,student_name,student_status", ...lines].join("\n");

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "student roster import on PostgreSQL (C1-D2)",
  () => {
    let prisma: PrismaClient;
    let service: StudentRosterService;
    let lookup: RosterLookup;
    let adminId: string;
    let actor: ActorContext;
    const repo = new PrismaStudentRosterRepository();

    const build = (audit = new PrismaAuditRepository()) =>
      new StudentRosterService({ repo, audit, runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 30_000 }) });

    async function cleanup() {
      await prisma.studentRosterEntry.deleteMany({ where: { registrationNumber: { in: [...numbers] } } });
      const users = await prisma.user.findMany({ where: { email: { startsWith: emailPrefix } }, select: { id: true } });
      const ids = users.map(({ id }) => id);
      if (ids.length === 0) return;
      await prisma.studentRosterImport.deleteMany({ where: { importedByUserId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
      if (!connectionString) {
        throw new Error("TEST_DATABASE_URL is required for enabled roster integration tests.");
      }
      if (!enabled || !disposableConfirmed) {
        throw new Error("Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true for a disposable database.");
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing roster integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run roster integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `student-roster-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 6 }) });
      service = build();
      lookup = new RosterLookup(repo);
    }, 60_000);

    beforeEach(async () => {
      await cleanup();
      adminId = randomUUID();
      await prisma.user.create({
        data: {
          id: adminId,
          email: `${emailPrefix}admin@example.test`,
          name: "admin",
          passwordHash: "x",
          status: "ACTIVE",
          roles: { create: [{ role: "ADMIN" }] },
        },
      });
      actor = {
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

    it("commits entries, the import record, and audit together", async () => {
      const report = await service.importCsv(
        actor,
        csv(`${N1},A,ACTIVE`, `${N2},B,WITHDRAWN`, "bad,C,ACTIVE"),
        { dryRun: false },
      );
      expect(report.counts).toEqual({ rows: 3, inserted: 2, skipped: 0, conflicts: 0, invalid: 1, duplicates: 0 });

      const record = await prisma.studentRosterImport.findUniqueOrThrow({ where: { id: report.importId! } });
      expect(record).toMatchObject({
        importedByUserId: adminId,
        rowCount: 3,
        insertedCount: 2,
        invalidCount: 1,
        fileSha256: report.fileSha256,
      });
      expect(
        await prisma.studentRosterEntry.findMany({
          where: { importId: record.id },
          select: { registrationNumber: true, departmentCode: true },
          orderBy: { registrationNumber: "asc" },
        }),
      ).toEqual([
        { registrationNumber: N1, departmentCode: "ZZT" },
        { registrationNumber: N2, departmentCode: "ZZT" },
      ]);
      const audit = await prisma.auditLog.findMany({ where: { targetId: record.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "STUDENT_ROSTER_IMPORTED", actorUserId: adminId });
      expect(JSON.stringify(audit[0]!.metadata)).not.toContain("ZZT");
    });

    it("does not write during a dry run", async () => {
      await service.importCsv(actor, csv(`${N1},A,ACTIVE`), { dryRun: true });
      expect(await prisma.studentRosterEntry.count({ where: { registrationNumber: N1 } })).toBe(0);
      expect(await prisma.studentRosterImport.count({ where: { importedByUserId: adminId } })).toBe(0);
    });

    it("is idempotent and never overwrites a differing entry", async () => {
      await service.importCsv(actor, csv(`${N1},Original,ACTIVE`), { dryRun: false });
      const same = await service.importCsv(actor, csv(`${N1},Original,ACTIVE`), { dryRun: false });
      expect(same.counts).toMatchObject({ inserted: 0, skipped: 1, conflicts: 0 });

      const different = await service.importCsv(
        actor,
        csv(`${N1},Changed,WITHDRAWN`, `${N2},New,ACTIVE`),
        { dryRun: false },
      );
      expect(different.counts).toMatchObject({ inserted: 1, skipped: 0, conflicts: 1 });
      expect(await prisma.studentRosterEntry.findUniqueOrThrow({ where: { registrationNumber: N1 } })).toMatchObject({
        studentName: "Original",
        rosterStatus: "ACTIVE",
      });
    });

    it("rolls back the import if a later step fails", async () => {
      const real = new PrismaAuditRepository();
      const failing = build({
        record: async (tx, entry) => {
          await real.record(tx, entry);
          throw new Error("simulated crash after the audit insert");
        },
      });
      await expect(
        failing.importCsv(actor, csv(`${N1},A,ACTIVE`, `${N2},B,ACTIVE`), { dryRun: false }),
      ).rejects.toThrow("simulated crash");
      expect(await prisma.studentRosterEntry.count({ where: { registrationNumber: { in: [...numbers] } } })).toBe(0);
      expect(await prisma.studentRosterImport.count({ where: { importedByUserId: adminId } })).toBe(0);
    });

    it("serializes concurrent identical commits so each row is inserted exactly once", async () => {
      const file = csv(`${N1},A,ACTIVE`, `${N2},B,ACTIVE`, `${N3},C,ACTIVE`);
      const [first, second] = await Promise.all([
        service.importCsv(actor, file, { dryRun: false }),
        service.importCsv(actor, file, { dryRun: false }),
      ]);
      expect(first.counts.inserted + second.counts.inserted).toBe(3);
      expect(first.counts.skipped + second.counts.skipped).toBe(3);
      expect(await prisma.studentRosterEntry.count({ where: { registrationNumber: { in: [...numbers] } } })).toBe(
        3,
      );
    });

    it("enforces uniqueness and CHECK constraints in the database itself", async () => {
      const report = await service.importCsv(actor, csv(`${N1},A,ACTIVE`), { dryRun: false });
      const importId = report.importId!;
      await expect(
        prisma.studentRosterEntry.create({ data: { registrationNumber: N1, departmentCode: "ZZT", importId } }),
      ).rejects.toThrow();
      await expect(
        prisma.studentRosterEntry.create({ data: { registrationNumber: "zzt-000-009/2099", departmentCode: "ZZT", importId } }),
      ).rejects.toThrow();
      await expect(
        prisma.studentRosterImport.create({
          data: {
            importedByUserId: adminId,
            fileSha256: "x",
            rowCount: 5,
            insertedCount: 1,
            skippedCount: 0,
            conflictCount: 0,
            invalidCount: 0,
            duplicateCount: 0,
          },
        }),
      ).rejects.toThrow();
    });

    it("looks up the three-state match from the roster table", async () => {
      await service.importCsv(actor, csv(`${N1},A,ACTIVE`, `${N2},B,WITHDRAWN`), { dryRun: false });
      const match = (number: string) => prisma.$transaction((tx) => lookup.match(tx, number));
      expect(await match(N1)).toMatchObject({ result: "found", studentName: "A" });
      expect(await match(N2)).toMatchObject({ result: "found_ineligible" });
      expect(await match(N3)).toEqual({ result: "not_found" });
    });
  },
);
