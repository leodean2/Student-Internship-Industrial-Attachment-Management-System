import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueInvitationCreated } from "../../src/modules/email-outbox/invitation-created.producer";
import { PrismaOutboxRepository } from "../../src/modules/email-outbox/outbox.repository";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const keyPrefix = `invitation-created:itest-${run}-`;

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "enqueueInvitationCreated shares the caller's transaction",
  () => {
    let prisma: PrismaClient;
    const outbox = new PrismaOutboxRepository();
    const input = (suffix: string) => ({
      toEmail: `invitee-${suffix}@example.test`,
      rawToken: "abc-DEF_123",
      tokenHash: `itest-${run}-${suffix}`,
      role: "UNIVERSITY_SUPERVISOR",
      expiresAt: new Date("2026-12-08T14:30:00.000Z"),
      appBaseUrl: "https://app.example.test",
    });
    const rowsFor = (suffix: string) =>
      prisma.$queryRaw<{
        status: string;
        attempts: number;
        templateType: string;
        payload: Record<string, string>;
      }[]>`
        SELECT status::text AS status, attempts::int AS attempts, "templateType", payload
        FROM email_outbox WHERE "idempotencyKey" = ${`${keyPrefix}${suffix}`}`;
    const cleanup = () => prisma.$executeRaw`
      DELETE FROM email_outbox WHERE "idempotencyKey" LIKE ${`${keyPrefix}%`}`;

    beforeAll(async () => {
      if (!connectionString) throw new Error("TEST_DATABASE_URL is required for invitation outbox integration tests.");
      if (!enabled || !disposableConfirmed) {
        throw new Error("Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true for a disposable database.");
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing invitation outbox integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (!target.hostname.endsWith(".neon.tech") || decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing invitation outbox integration tests outside Neon test_db.");
      }
      target.searchParams.set("application_name", `invitation-outbox-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 4 }) });
      const [existingOutbox] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM email_outbox`;
      const [existingRuns] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM job_runs WHERE "jobName" = 'outbox-worker'`;
      if (existingOutbox!.count !== 0 || existingRuns!.count !== 0) {
        throw new Error("The disposable integration database must have an empty email_outbox and no outbox-worker job runs.");
      }
    }, 60_000);

    beforeEach(async () => cleanup());

    afterAll(async () => {
      if (!prisma) return;
      await cleanup();
      await prisma.$disconnect();
    });

    it("commits the outbox row with the surrounding transaction", async () => {
      await prisma.$transaction((tx) => enqueueInvitationCreated(outbox, tx, input("commit")), { timeout: 30_000 });
      const [saved, ...rest] = await rowsFor("commit");
      expect(rest).toHaveLength(0);
      expect(saved).toMatchObject({ status: "PENDING", attempts: 0, templateType: "INVITATION_CREATED" });
      expect(Object.keys(saved!.payload).sort()).toEqual(["acceptanceUrl", "expiresAt", "role"]);
      expect(saved!.payload.acceptanceUrl).toBe(
        "https://app.example.test/accept-invitation?token=abc-DEF_123",
      );
    });

    it("leaves no outbox row when the surrounding transaction rolls back", async () => {
      await expect(
        prisma.$transaction(
          async (tx) => {
            await enqueueInvitationCreated(outbox, tx, input("rollback"));
            throw new Error("invitation write failed");
          },
          { timeout: 30_000 },
        ),
      ).rejects.toThrow("invitation write failed");
      expect(await rowsFor("rollback")).toHaveLength(0);
    });

    it("does not enqueue the same issuance twice", async () => {
      const first = await prisma.$transaction((tx) => enqueueInvitationCreated(outbox, tx, input("dup")), { timeout: 30_000 });
      const second = await prisma.$transaction((tx) => enqueueInvitationCreated(outbox, tx, input("dup")), { timeout: 30_000 });
      expect([first.created, second.created]).toEqual([true, false]);
      expect(await rowsFor("dup")).toHaveLength(1);
    });
  },
);
