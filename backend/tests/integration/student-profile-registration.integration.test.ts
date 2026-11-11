import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `prof-it-${run}-`;
const number = (n: number) => `PROF-${run}-${n}`;

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "student profile registration state on PostgreSQL (C1-D3 schema)",
  () => {
    let prisma: PrismaClient;
    let reviewerId: string;

    const makeUser = async (label: string) => {
      const id = randomUUID();
      await prisma.user.create({
        data: { id, email: `${emailPrefix}${label}@example.test`, name: label, passwordHash: "x" },
      });
      return id;
    };
    const decided = () => ({
      registrationDecidedAt: new Date(),
      registrationDecidedByUserId: reviewerId,
    });

    async function cleanup() {
      const users = await prisma.user.findMany({
        where: { email: { startsWith: emailPrefix } },
        select: { id: true },
      });
      const ids = users.map(({ id }) => id);
      if (ids.length === 0) return;
      await prisma.studentProfile.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
      if (!connectionString) throw new Error("TEST_DATABASE_URL is required for enabled profile integration tests.");
      if (!enabled || !disposableConfirmed) {
        throw new Error("Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true for a disposable database.");
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing profile integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run profile integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `student-profile-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 4 }) });
    }, 60_000);

    beforeEach(async () => {
      await cleanup();
      reviewerId = await makeUser("reviewer");
    });
    afterAll(async () => {
      if (!prisma) return;
      await cleanup();
      await prisma.$disconnect();
    });

    it("defaults to PENDING and requires a number while pending", async () => {
      const userId = await makeUser("pending");
      const profile = await prisma.studentProfile.create({
        data: { userId, registrationNumber: number(1), registrationDepartmentCode: "PROF" },
      });
      expect(profile.registrationStatus).toBe("PENDING");

      const other = await makeUser("pending-null");
      await expect(
        prisma.studentProfile.create({
          data: { userId: other, registrationNumber: null, registrationDepartmentCode: "PROF" },
        }),
      ).rejects.toThrow();
    });

    it("CONFIRMED needs a number, a decision time, a decider and a basis", async () => {
      const base = { registrationDepartmentCode: "PROF", registrationStatus: "CONFIRMED" as const };
      for (const [label, extra] of [
        ["no-number", { registrationNumber: null, registrationDecisionBasis: "checked", ...decided() }],
        ["no-basis", { registrationNumber: number(2), ...decided() }],
        ["no-decider", {
          registrationNumber: number(3),
          registrationDecisionBasis: "checked",
          registrationDecidedAt: new Date(),
        }],
      ] as const) {
        const userId = await makeUser(`conf-${label}`);
        await expect(prisma.studentProfile.create({ data: { userId, ...base, ...extra } })).rejects.toThrow();
      }
      const userId = await makeUser("conf-ok");
      await expect(
        prisma.studentProfile.create({
          data: {
            userId,
            ...base,
            registrationNumber: number(4),
            registrationDecisionBasis: "checked against the roster",
            ...decided(),
          },
        }),
      ).resolves.toMatchObject({ registrationStatus: "CONFIRMED" });
    });

    it("REJECTED needs a reason, decider, time and the claimed number, and holds no active number", async () => {
      const base = { registrationDepartmentCode: "PROF", registrationStatus: "REJECTED" as const };
      const full = { rejectedRegistrationNumber: number(5), registrationDecisionReason: "not on the roster", ...decided() };
      const cases = [
        ["still-holds-number", { ...full, registrationNumber: number(5) }],
        ["no-reason", { registrationNumber: null, rejectedRegistrationNumber: number(5), ...decided() }],
        ["no-claimed-number", { registrationNumber: null, registrationDecisionReason: "not on the roster", ...decided() }],
        ["no-decider", {
          registrationNumber: null,
          rejectedRegistrationNumber: number(5),
          registrationDecisionReason: "x",
          registrationDecidedAt: new Date(),
        }],
      ] as const;
      for (const [label, extra] of cases) {
        const userId = await makeUser(`rej-${label}`);
        await expect(prisma.studentProfile.create({ data: { userId, ...base, ...extra } })).rejects.toThrow();
      }
      const userId = await makeUser("rej-ok");
      await expect(
        prisma.studentProfile.create({
          data: { userId, ...base, registrationNumber: null, ...full },
        }),
      ).resolves.toMatchObject({ registrationStatus: "REJECTED" });
    });

    it("keeps the unique constraint: NULL numbers coexist, and released numbers can be claimed again", async () => {
      const rejected = {
        registrationDepartmentCode: "PROF",
        registrationStatus: "REJECTED" as const,
        registrationNumber: null,
        registrationDecisionReason: "not on the roster",
        ...decided(),
      };
      const a = await makeUser("rej-a");
      const b = await makeUser("rej-b");
      await prisma.studentProfile.create({ data: { userId: a, ...rejected, rejectedRegistrationNumber: number(6) } });
      await prisma.studentProfile.create({ data: { userId: b, ...rejected, rejectedRegistrationNumber: number(7) } });

      const owner = await makeUser("owner");
      await prisma.studentProfile.create({
        data: { userId: owner, registrationNumber: number(6), registrationDepartmentCode: "PROF" },
      });
      const squatter = await makeUser("squatter");
      await expect(
        prisma.studentProfile.create({
          data: { userId: squatter, registrationNumber: number(6), registrationDepartmentCode: "PROF" },
        }),
      ).rejects.toThrow();
    });
  },
);
