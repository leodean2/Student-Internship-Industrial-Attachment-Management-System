import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import type { Tx } from "../../src/infrastructure/transaction";
import { PermanentEmailError, type EmailProvider } from "../../src/modules/email-outbox/email-provider";
import { OutboxOrchestrator, type OrchestratorConfig } from "../../src/modules/email-outbox/orchestrator";
import { PrismaOutboxRepository } from "../../src/modules/email-outbox/outbox.repository";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";

interface OutboxRow {
  id: string;
  status: string;
  attempts: number;
  claimToken: string | null;
  hasLease: boolean;
  nextAttemptDeltaSec: number | null;
}

interface JobRunRow {
  status: string;
  itemsProcessed: number;
  itemsFailed: number;
  finished: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(stepMs);
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

/** Fails promptly if a provider call never starts because the cycle already ended. */
async function providerCalled(started: Promise<void>, cycle: Promise<unknown>): Promise<void> {
  await Promise.race([
    started,
    cycle.then(() => {
      throw new Error("the cycle finished before the provider was called");
    }),
  ]);
}

function gatedProvider() {
  const started = deferred<void>();
  const gate = deferred<void>();
  const provider: EmailProvider = {
    send: (_message, signal) => {
      started.resolve();
      return new Promise<void>((resolve, reject) => {
        void gate.promise.then(resolve, reject);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  return { provider, started: started.promise, release: () => gate.resolve() };
}

const okProvider: EmailProvider = { send: async () => undefined };
const failingProvider = (error: Error): EmailProvider => ({
  send: async () => {
    throw error;
  },
});

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "outbox worker orchestration on PostgreSQL",
  () => {
    const run = randomUUID().replaceAll("-", "").slice(0, 10);
    const idPrefix = `outbox-worker-it-${run}-`;
    const jobRunIds: string[] = [];
    let prisma: PrismaClient;
    let runTx: ReturnType<typeof prismaTxRunner>;

    const baseConfig: OrchestratorConfig = {
      batchSize: 10,
      concurrency: 5,
      pollIntervalMs: 50,
      leaseDurationMs: 10_000,
      leaseRenewalIntervalMs: 500,
      providerTimeoutMs: 15_000,
      persistRetry: { baseMs: 50, maxMs: 200 },
    };

    function makeOrchestrator(provider: EmailProvider, overrides: Partial<OrchestratorConfig> = {}) {
      class RecordingOutboxRepository extends PrismaOutboxRepository {
        override async createJobRun(tx: Tx, itemsProcessed: number): Promise<string> {
          const id = await super.createJobRun(tx, itemsProcessed);
          jobRunIds.push(id);
          return id;
        }
      }

      const orchestrator = new OutboxOrchestrator({
        workerId: `worker-${run}`,
        config: { ...baseConfig, ...overrides },
        repo: new RecordingOutboxRepository(),
        runTx,
        provider,
        logger: pino({ level: "silent" }),
        random: () => 0.5,
      });
      return orchestrator;
    }

    async function insertMessage(suffix: string, attempts = 0): Promise<string> {
      const id = `${idPrefix}${suffix}`;
      await prisma.$executeRaw`
        INSERT INTO email_outbox ("id", "toEmail", "templateType", "payload", "idempotencyKey", attempts)
        VALUES (${id}, ${`${id}@example.test`}, 'TEST_TEMPLATE', '{}'::jsonb, ${`${id}-idem`}, ${attempts})`;
      return id;
    }

    async function readOutboxRow(id: string): Promise<OutboxRow> {
      const rows = await prisma.$queryRaw<OutboxRow[]>`
        SELECT id,
               status::text AS status,
               attempts::int AS attempts,
               "claimToken",
               "leaseExpiresAt" IS NOT NULL AS "hasLease",
               EXTRACT(EPOCH FROM ("nextAttemptAt" - clock_timestamp()))::float8 AS "nextAttemptDeltaSec"
        FROM email_outbox WHERE id = ${id}`;
      const row = rows[0];
      if (!row) throw new Error(`fixture row ${id} not found`);
      return row;
    }

    async function readJobRun(id: string): Promise<JobRunRow> {
      const rows = await prisma.$queryRaw<JobRunRow[]>`
        SELECT status::text AS status,
               "itemsProcessed"::int AS "itemsProcessed",
               "itemsFailed"::int AS "itemsFailed",
               "finishedAt" IS NOT NULL AS finished
        FROM job_runs WHERE id = ${id}`;
      const row = rows[0];
      if (!row) throw new Error(`job run ${id} not found`);
      return row;
    }

    async function cleanupFixtures(): Promise<void> {
      await prisma.$executeRaw`DELETE FROM email_outbox WHERE id LIKE ${`${idPrefix}%`}`;
      for (const jobRunId of jobRunIds.splice(0)) {
        await prisma.$executeRaw`DELETE FROM job_runs WHERE id = ${jobRunId}`;
      }
    }

    beforeAll(async () => {
      if (!connectionString) throw new Error("TEST_DATABASE_URL is required for enabled outbox worker integration tests.");
      if (!enabled || !disposableConfirmed) {
        throw new Error(
          "Set RUN_EMAIL_OUTBOX_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true only for a disposable database.",
        );
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing email outbox integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run email outbox integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `outbox-worker-${run}`);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: target.toString(), max: 8 }),
      });

      const migration = await prisma.$queryRaw<{ columns: number; hasRunning: boolean }[]>`
        SELECT
          (SELECT count(*)::int
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'email_outbox'
             AND column_name IN ('processingStartedAt', 'claimToken', 'leaseExpiresAt')) AS columns,
          EXISTS (
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'JobRunStatus' AND e.enumlabel = 'RUNNING'
          ) AS "hasRunning"`;
      if (migration[0]?.columns !== 3 || !migration[0]?.hasRunning) {
        throw new Error("TEST_DATABASE_URL is missing the email outbox worker foundation migration.");
      }

      const [existingOutbox] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM email_outbox`;
      const [existingRuns] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM job_runs WHERE "jobName" = 'outbox-worker'`;
      if (existingOutbox!.count !== 0 || existingRuns!.count !== 0) {
        throw new Error("The disposable integration database must have an empty email_outbox and no outbox-worker job runs.");
      }
      runTx = prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 });
    }, 60_000);

    beforeEach(async () => cleanupFixtures());

    afterAll(async () => {
      if (!prisma) return;
      await cleanupFixtures();
      await prisma.$disconnect();
    });

    it("sends a batch and finalizes a SUCCESS job run", async () => {
      const ids = [await insertMessage("a"), await insertMessage("b"), await insertMessage("c")];
      const orchestrator = makeOrchestrator(okProvider);

      expect(await orchestrator.runCycle()).toBe(3);

      for (const id of ids) {
        expect(await readOutboxRow(id)).toMatchObject({
          status: "SENT",
          attempts: 1,
          claimToken: null,
          hasLease: false,
        });
      }
      expect(jobRunIds).toHaveLength(1);
      expect(await readJobRun(jobRunIds[0]!)).toEqual({
        status: "SUCCESS",
        itemsProcessed: 3,
        itemsFailed: 0,
        finished: true,
      });
    }, 30_000);

    it("creates no job run when nothing is claimable", async () => {
      const orchestrator = makeOrchestrator(okProvider);
      expect(await orchestrator.runCycle()).toBe(0);
      const [count] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM job_runs WHERE "jobName" = 'outbox-worker'`;
      expect(count!.count).toBe(0);
    }, 30_000);

    it("schedules a transient retry using the database clock and counts it as a successful run", async () => {
      const id = await insertMessage("transient");
      const orchestrator = makeOrchestrator(failingProvider(new Error("provider temporarily unavailable")));

      await orchestrator.runCycle();

      const row = await readOutboxRow(id);
      expect(row).toMatchObject({ status: "PENDING", attempts: 1, claimToken: null, hasLease: false });
      expect(row.nextAttemptDeltaSec).toBeGreaterThan(50);
      expect(row.nextAttemptDeltaSec).toBeLessThanOrEqual(66);
      expect(jobRunIds).toHaveLength(1);
      expect((await readJobRun(jobRunIds[0]!)).status).toBe("SUCCESS");
    }, 30_000);

    it("fails permanent errors immediately and records a terminal job-run failure", async () => {
      const id = await insertMessage("permanent");
      const orchestrator = makeOrchestrator(failingProvider(new PermanentEmailError("invalid test recipient")));

      await orchestrator.runCycle();

      expect(await readOutboxRow(id)).toMatchObject({ status: "FAILED", attempts: 1, claimToken: null });
      expect(jobRunIds).toHaveLength(1);
      expect(await readJobRun(jobRunIds[0]!)).toMatchObject({
        status: "FAILED",
        itemsProcessed: 1,
        itemsFailed: 1,
        finished: true,
      });
    }, 30_000);

    it("fails a fifth-attempt transient failure but sends a fifth-attempt success", async () => {
      const failedId = await insertMessage("fifth-fail", 4);
      const failing = makeOrchestrator(failingProvider(new Error("provider temporarily unavailable")));
      await failing.runCycle();
      expect(await readOutboxRow(failedId)).toMatchObject({ status: "FAILED", attempts: 5 });

      const sentId = await insertMessage("fifth-success", 4);
      const succeeding = makeOrchestrator(okProvider);
      await succeeding.runCycle();
      expect(await readOutboxRow(sentId)).toMatchObject({ status: "SENT", attempts: 5 });

      expect(jobRunIds).toHaveLength(2);
      const statuses = await Promise.all(jobRunIds.map(async (id) => (await readJobRun(id)).status));
      expect(statuses).toContain("FAILED");
      expect(statuses).toContain("SUCCESS");
    }, 30_000);

    it("renews leases through graceful shutdown, completes claimed work, and starts no later claims", async () => {
      const { provider, started, release } = gatedProvider();
      const id = await insertMessage("slow-send");
      const orchestrator = makeOrchestrator(provider);

      const cycle = orchestrator.runCycle();
      await providerCalled(started, cycle);
      orchestrator.beginShutdown();

      let requeued = 0;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        requeued += (await runTx((tx) => new PrismaOutboxRepository().recoverStaleLeases(tx))).requeued;
        await sleep(300);
      }
      expect(requeued).toBe(0);
      expect(await readOutboxRow(id)).toMatchObject({ status: "PROCESSING", attempts: 1, hasLease: true });

      release();
      await cycle;
      expect(await readOutboxRow(id)).toMatchObject({ status: "SENT", claimToken: null, hasLease: false });

      const lateId = await insertMessage("after-shutdown");
      expect(await orchestrator.runCycle()).toBe(0);
      expect(await readOutboxRow(lateId)).toMatchObject({ status: "PENDING", attempts: 0 });

      expect(jobRunIds).toHaveLength(1);
    }, 30_000);

    it("does not overwrite a row after the claim token is changed by another owner", async () => {
      const { provider, started } = gatedProvider();
      const id = await insertMessage("ownership-lost");
      const orchestrator = makeOrchestrator(provider);

      const cycle = orchestrator.runCycle();
      await providerCalled(started, cycle);
      await prisma.$executeRaw`UPDATE email_outbox SET "claimToken" = 'replacement-owner' WHERE id = ${id}`;
      await cycle;

      expect(await readOutboxRow(id)).toMatchObject({
        status: "PROCESSING",
        claimToken: "replacement-owner",
        attempts: 1,
      });
      expect(jobRunIds).toHaveLength(1);
      expect(await readJobRun(jobRunIds[0]!)).toMatchObject({
        status: "SUCCESS",
        itemsProcessed: 1,
        itemsFailed: 0,
      });
    }, 30_000);

    it("leaves hard-stopped claims for stale-lease recovery", async () => {
      const { provider, started } = gatedProvider();
      const firstId = await insertMessage("abandoned-first");
      const lastAttemptId = await insertMessage("abandoned-last-attempt", 4);
      const orchestrator = makeOrchestrator(provider);

      const cycle = orchestrator.runCycle();
      await providerCalled(started, cycle);
      expect(orchestrator.forceStop().sort()).toEqual([firstId, lastAttemptId].sort());
      await cycle;

      expect(await readOutboxRow(firstId)).toMatchObject({ status: "PROCESSING", attempts: 1 });
      expect(await readOutboxRow(lastAttemptId)).toMatchObject({ status: "PROCESSING", attempts: 5 });
      expect(jobRunIds).toHaveLength(1);
      expect((await readJobRun(jobRunIds[0]!)).status).toBe("RUNNING");

      await waitFor(async () => {
        const rows = await prisma.$queryRaw<{ expired: boolean }[]>`
          SELECT "leaseExpiresAt" < clock_timestamp() AS expired
          FROM email_outbox WHERE id = ${lastAttemptId}`;
        return rows[0]?.expired === true;
      }, 15_000);

      const recovery = await runTx((tx) => new PrismaOutboxRepository().recoverStaleLeases(tx));
      expect(recovery).toEqual({ requeued: 1, failed: 1 });
      expect(await readOutboxRow(firstId)).toMatchObject({
        status: "PENDING",
        attempts: 1,
        claimToken: null,
        hasLease: false,
      });
      expect(await readOutboxRow(lastAttemptId)).toMatchObject({
        status: "FAILED",
        attempts: 5,
        claimToken: null,
        hasLease: false,
      });
    }, 40_000);
  },
);
