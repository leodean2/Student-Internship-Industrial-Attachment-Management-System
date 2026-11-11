import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaOutboxRepository, type ClaimRef } from "../../src/modules/email-outbox/outbox.repository";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_EMAIL_OUTBOX_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const idPrefix = `outbox-test-${run}-`;
const jobRunIds: string[] = [];

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "PrismaOutboxRepository against PostgreSQL (Decision #54 §8, §12, §13)",
  () => {
    let prisma: PrismaClient;
    const repository = new PrismaOutboxRepository();
    const tx = <T>(fn: (transaction: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(fn, { timeout: 30_000 });
    const claim = (batchSize = 10, leaseSeconds = 60) =>
      tx((transaction) => repository.claimBatch(transaction, batchSize, leaseSeconds));
    const id = (label: string) => `${idPrefix}${label}`;

    interface Row {
      id: string;
      status: string;
      attempts: number;
      claimToken: string | null;
      leaseExpiresAt: Date | null;
      processingStartedAt: Date | null;
      nextAttemptAt: Date | null;
      sentAt: Date | null;
      hasPayload: boolean;
    }

    const row = async (rowId: string) =>
      (await prisma.$queryRaw<Row[]>`
        SELECT id, status, attempts, "claimToken", "leaseExpiresAt", "processingStartedAt",
               "nextAttemptAt", "sentAt", payload IS NOT NULL AS "hasPayload"
        FROM email_outbox WHERE id = ${rowId}`)[0]!;

    async function seed(
      label: string,
      options: {
        status?: string;
        attempts?: number;
        nextInSecs?: number;
        leaseInSecs?: number | null;
        token?: string | null;
        createdAtSecs?: number;
      } = {},
    ) {
      const rowId = id(label);
      const status = options.status ?? "PENDING";
      await prisma.$executeRaw`
        INSERT INTO email_outbox
          (id, "toEmail", "templateType", payload, status, attempts, "nextAttemptAt",
           "leaseExpiresAt", "claimToken", "idempotencyKey", "createdAt", "sentAt")
        VALUES (
          ${rowId}, ${`${rowId}@example.test`}, 'verify', ${JSON.stringify({ id: rowId })}::jsonb,
          ${status}::"EmailOutboxStatus", ${options.attempts ?? 0},
          ${options.nextInSecs === undefined ? null : options.nextInSecs}::double precision * interval '1 second' + clock_timestamp(),
          ${options.leaseInSecs === undefined || options.leaseInSecs === null ? null : options.leaseInSecs}::double precision * interval '1 second' + clock_timestamp(),
          ${options.token ?? null}, ${`idem-${rowId}`},
          clock_timestamp() + ${options.createdAtSecs ?? 0}::double precision * interval '1 second',
          CASE WHEN ${status} = 'SENT' THEN clock_timestamp() END)`;
      return rowId;
    }

    const processing = async (label: string, attempts: number, leaseInSecs: number): Promise<ClaimRef> => {
      const token = randomUUID();
      const rowId = await seed(label, { status: "PROCESSING", attempts, leaseInSecs, token });
      return { id: rowId, claimToken: token };
    };

    async function cleanupFixtures() {
      await prisma.$executeRaw`DELETE FROM email_outbox WHERE id LIKE ${`${idPrefix}%`}`;
      for (const jobRunId of jobRunIds.splice(0)) {
        await prisma.$executeRaw`DELETE FROM job_runs WHERE id = ${jobRunId}`;
      }
    }

    beforeAll(async () => {
      if (!connectionString) return;
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
      target.searchParams.set("application_name", `outbox-repository-${run}`);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: target.toString(), max: 8 }),
      });

      const migration = await prisma.$queryRaw<{
        columns: number;
        hasRunning: boolean;
        payloadNullable: boolean;
      }[]>`
        SELECT
          (SELECT count(*)::int
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'email_outbox'
             AND column_name IN ('processingStartedAt', 'claimToken', 'leaseExpiresAt')) AS columns,
          (SELECT is_nullable = 'YES'
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'email_outbox'
             AND column_name = 'payload') AS "payloadNullable",
          EXISTS (
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'JobRunStatus' AND e.enumlabel = 'RUNNING'
          ) AS "hasRunning"`;
      if (migration[0]?.columns !== 3 || !migration[0]?.hasRunning || !migration[0]?.payloadNullable) {
        throw new Error(
          "TEST_DATABASE_URL is missing the email outbox worker or terminal payload-scrubbing migration. " +
          "Apply migrations only to the confirmed disposable test_db.",
        );
      }

      const [existingOutbox] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM email_outbox`;
      const [existingRuns] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM job_runs WHERE "jobName" = 'outbox-worker'`;
      if (existingOutbox!.count !== 0 || existingRuns!.count !== 0) {
        throw new Error("The disposable integration database must have an empty email_outbox and no outbox-worker job runs.");
      }
    });

    beforeEach(cleanupFixtures);
    afterAll(async () => {
      if (!prisma) return;
      await cleanupFixtures();
      await prisma.$disconnect();
    });

    describe("claiming (§8.1, §8.2)", () => {
      it("claims PENDING rows oldest-first and respects the batch size", async () => {
        await seed("old-3", { createdAtSecs: 3 });
        await seed("old-1", { createdAtSecs: 1 });
        await seed("old-2", { createdAtSecs: 2 });
        const fourth = await seed("old-4", { createdAtSecs: 4 });
        const got = await claim(3);
        expect(got.map((message) => message.id)).toEqual(expect.arrayContaining([
          id("old-1"),
          id("old-2"),
          id("old-3"),
        ]));
        expect((await row(fourth)).status).toBe("PENDING");
      });

      it("sets PROCESSING, lease, start time, unique token and increments attempts once", async () => {
        await seed("claim-once", { attempts: 2 });
        const [message] = await claim(10, 60);
        const saved = await row(id("claim-once"));
        expect(message).toMatchObject({
          id: id("claim-once"),
          toEmail: `${id("claim-once")}@example.test`,
          templateType: "verify",
          payload: { id: id("claim-once") },
          attempts: 3,
        });
        expect(saved).toMatchObject({
          status: "PROCESSING",
          attempts: 3,
          claimToken: message!.claimToken,
        });
        expect(saved.processingStartedAt).not.toBeNull();
        const [lease] = await prisma.$queryRaw<{ seconds: number }[]>`
          SELECT extract(epoch FROM ("leaseExpiresAt" - clock_timestamp()))::float AS seconds
          FROM email_outbox WHERE id = ${id("claim-once")}`;
        expect(lease!.seconds).toBeGreaterThan(55);
        expect(lease!.seconds).toBeLessThanOrEqual(60);
      });

      it("gives every message its own unique claim token", async () => {
        for (let index = 0; index < 8; index++) await seed(`unique-${index}`);
        const claimed = await claim(8);
        expect(new Set(claimed.map(({ claimToken }) => claimToken)).size).toBe(8);
        for (const message of claimed) expect((await row(message.id)).claimToken).toBe(message.claimToken);
      });

      it("excludes exhausted, non-PENDING, and not-yet-due rows", async () => {
        await seed("exhausted", { attempts: 5 });
        await seed("already-sent", { status: "SENT" });
        await seed("later", { nextInSecs: 3600 });
        await seed("due", { nextInSecs: -5 });
        await seed("fresh");
        const ids = (await claim()).map(({ id: messageId }) => messageId).sort();
        expect(ids).toEqual([id("due"), id("fresh")].sort());
        expect((await row(id("exhausted"))).attempts).toBe(5);
      });

      it("allows attempt four to become attempt five but never claims a sixth attempt", async () => {
        await seed("fifth-attempt", { attempts: 4 });
        const [message] = await claim();
        expect(message!.attempts).toBe(5);
        await tx((transaction) => repository.scheduleRetry(transaction, message!, 1000));
        await prisma.$executeRaw`UPDATE email_outbox SET "nextAttemptAt" = NULL WHERE id = ${id("fifth-attempt")}`;
        expect(await claim()).toEqual([]);
      });

      it("returns an empty result for an empty queue", async () => {
        expect(await claim()).toEqual([]);
      });

      it("does not give a row to multiple simultaneous claimers", async () => {
        for (let round = 0; round < 5; round++) {
          await cleanupFixtures();
          for (let index = 0; index < 40; index++) await seed(`parallel-${round}-${index}`, { createdAtSecs: index });
          const results = await Promise.all(Array.from({ length: 6 }, () => claim(10)));
          const ids = results.flat().map(({ id: messageId }) => messageId);
          expect(new Set(ids).size, `round ${round}: a row was claimed twice`).toBe(ids.length);
          expect(ids.length, `round ${round}: all 40 rows must be claimed`).toBe(40);
          const [invalid] = await prisma.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count
            FROM email_outbox
            WHERE id LIKE ${`${idPrefix}%`} AND (attempts <> 1 OR status <> 'PROCESSING')`;
          expect(invalid!.count).toBe(0);
        }
      });

      it("skips a row held by another transaction instead of blocking", async () => {
        const locked = await seed("locked", { createdAtSecs: 0 });
        const free = await seed("free", { createdAtSecs: 1 });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let lockedReady!: () => void;
        const ready = new Promise<void>((resolve) => { lockedReady = resolve; });
        const holder = tx(async (transaction) => {
          await transaction.$queryRaw`SELECT id FROM email_outbox WHERE id = ${locked} FOR UPDATE`;
          lockedReady();
          await held;
        });
        await ready;
        try {
          const result = await Promise.race([
            claim(10),
            new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5000)),
          ]);
          expect(result).not.toBe("blocked");
          expect((result as { id: string }[]).map(({ id: messageId }) => messageId)).toEqual([free]);
          expect((await row(locked)).status).toBe("PENDING");
        } finally {
          release();
          await holder;
        }
      });
    });

    describe("stale-lease recovery (§8.3)", () => {
      it("requeues expired attempts one through four and clears ownership", async () => {
        for (const attempts of [1, 2, 3, 4]) await processing(`expired-${attempts}`, attempts, -5);
        expect(await tx((transaction) => repository.recoverStaleLeases(transaction)))
          .toEqual({ requeued: 4, failed: 0 });
        for (const attempts of [1, 2, 3, 4]) {
          expect(await row(id(`expired-${attempts}`))).toMatchObject({
            status: "PENDING",
            attempts,
            claimToken: null,
            leaseExpiresAt: null,
            processingStartedAt: null,
          });
        }
      });

      it("fails an expired attempt-five lease", async () => {
        await processing("expired-fifth", 5, -5);
        expect(await tx((transaction) => repository.recoverStaleLeases(transaction)))
          .toEqual({ requeued: 0, failed: 1 });
        expect(await row(id("expired-fifth"))).toMatchObject({
          status: "FAILED",
          claimToken: null,
          leaseExpiresAt: null,
        });
      });

      it("scrubs the payload when recovery fails an exhausted lease", async () => {
        const exhausted = await processing("expired-fifth-payload", 5, -5);
        expect(await tx((transaction) => repository.recoverStaleLeases(transaction)))
          .toEqual({ requeued: 0, failed: 1 });
        expect(await row(exhausted.id)).toMatchObject({ status: "FAILED", hasPayload: false });
      });

      it("leaves non-expired leases PROCESSING with their token", async () => {
        const live = await processing("live-lease", 2, 30);
        expect(await tx((transaction) => repository.recoverStaleLeases(transaction)))
          .toEqual({ requeued: 0, failed: 0 });
        expect(await row(live.id)).toMatchObject({ status: "PROCESSING", claimToken: live.claimToken });
      });

      it("does not recover NULL leases", async () => {
        await seed("legacy-null-lease", { status: "PROCESSING", attempts: 1, leaseInSecs: null });
        await tx((transaction) => repository.recoverStaleLeases(transaction));
        expect((await row(id("legacy-null-lease"))).status).toBe("PROCESSING");
      });

      it("keeps the two recovery updates atomic in the caller transaction", async () => {
        await processing("atomic-retry", 2, -5);
        await processing("atomic-exhausted", 5, -5);
        await expect(tx(async (transaction) => {
          await repository.recoverStaleLeases(transaction);
          throw new Error("simulated crash");
        })).rejects.toThrow("simulated crash");
        expect((await row(id("atomic-retry"))).status).toBe("PROCESSING");
        expect((await row(id("atomic-exhausted"))).status).toBe("PROCESSING");
      });
    });

    describe("lease renewal (§8.4)", () => {
      it("extends leases and returns the IDs that still belong to these claims", async () => {
        const first = await processing("renew-first", 1, 1);
        const second = await processing("renew-second", 1, 1);
        expect(await tx((transaction) => repository.renewLeases(transaction, [first, second], 300)))
          .toEqual([first.id, second.id].sort());
        const [lease] = await prisma.$queryRaw<{ seconds: number }[]>`
          SELECT min(extract(epoch FROM ("leaseExpiresAt" - clock_timestamp())))::float AS seconds
          FROM email_outbox WHERE id LIKE ${`${idPrefix}renew-%`}`;
        expect(lease!.seconds).toBeGreaterThan(250);
      });

      it("keeps each ID paired with its own token", async () => {
        const first = await processing("pair-first", 1, 1);
        const second = await processing("pair-second", 1, 1);
        expect(await tx((transaction) => repository.renewLeases(transaction, [
          { id: first.id, claimToken: second.claimToken },
          { id: second.id, claimToken: second.claimToken },
        ], 300))).toEqual([second.id]);
        const [lease] = await prisma.$queryRaw<{ seconds: number }[]>`
          SELECT extract(epoch FROM ("leaseExpiresAt" - clock_timestamp()))::float AS seconds
          FROM email_outbox WHERE id = ${first.id}`;
        expect(lease!.seconds).toBeLessThan(5);
      });

      it("rejects stale ownership after another worker reclaims an expired row", async () => {
        const previous = await processing("stale-renewal", 1, -1);
        await tx((transaction) => repository.recoverStaleLeases(transaction));
        const [current] = await claim();
        expect(current!.claimToken).not.toBe(previous.claimToken);
        expect(await tx((transaction) => repository.renewLeases(transaction, [previous], 300))).toEqual([]);
        expect(await tx((transaction) => repository.renewLeases(transaction, [
          { id: current!.id, claimToken: current!.claimToken },
        ], 300))).toEqual([current!.id]);
      });

      it("does not renew completed messages and accepts an empty renewal set", async () => {
        const message = await processing("renew-completed", 1, 30);
        expect(await tx((transaction) => repository.markSent(transaction, message))).toBe(true);
        expect(await tx((transaction) => repository.renewLeases(transaction, [message], 300))).toEqual([]);
        expect(await tx((transaction) => repository.renewLeases(transaction, [], 300))).toEqual([]);
      });
    });

    describe("ownership-checked completion (§12)", () => {
      it("scrubs the payload after successfully marking a message sent", async () => {
        const message = await processing("complete-sent-scrub", 1, 30);
        expect(await tx((transaction) => repository.markSent(transaction, message))).toBe(true);
        expect(await row(message.id)).toMatchObject({ status: "SENT", hasPayload: false });
      });

      it("scrubs the payload after successfully marking a message failed", async () => {
        const message = await processing("complete-failed-scrub", 5, 30);
        expect(await tx((transaction) => repository.markFailed(transaction, message))).toBe(true);
        expect(await row(message.id)).toMatchObject({ status: "FAILED", hasPayload: false });
      });

      it("does not scrub the payload when a stale owner cannot complete a message", async () => {
        const message = await processing("complete-stale-scrub", 1, 30);
        const wrongOwner = { id: message.id, claimToken: randomUUID() };
        expect(await tx((transaction) => repository.markSent(transaction, wrongOwner))).toBe(false);
        expect(await row(message.id)).toMatchObject({ status: "PROCESSING", hasPayload: true });
      });

      it("marks a claim sent and clears its lease fields", async () => {
        const message = await processing("complete-sent", 1, 30);
        expect(await tx((transaction) => repository.markSent(transaction, message))).toBe(true);
        expect(await row(message.id)).toMatchObject({
          status: "SENT",
          claimToken: null,
          leaseExpiresAt: null,
          processingStartedAt: null,
        });
        expect((await row(message.id)).sentAt).not.toBeNull();
      });

      it("marks a claim failed and clears ownership fields", async () => {
        const message = await processing("complete-failed", 5, 30);
        expect(await tx((transaction) => repository.markFailed(transaction, message))).toBe(true);
        expect(await row(message.id)).toMatchObject({ status: "FAILED", claimToken: null, leaseExpiresAt: null });
      });

      it("schedules retry from the database clock without changing attempts", async () => {
        const message = await processing("complete-retry", 2, 30);
        expect(await tx((transaction) => repository.scheduleRetry(transaction, message, 300_000))).toBe(true);
        expect(await row(message.id)).toMatchObject({
          status: "PENDING",
          attempts: 2,
          claimToken: null,
          leaseExpiresAt: null,
          processingStartedAt: null,
        });
        const [delay] = await prisma.$queryRaw<{ seconds: number }[]>`
          SELECT extract(epoch FROM ("nextAttemptAt" - clock_timestamp()))::float AS seconds
          FROM email_outbox WHERE id = ${message.id}`;
        expect(delay!.seconds).toBeGreaterThan(295);
        expect(delay!.seconds).toBeLessThanOrEqual(300);
        expect(await claim()).toEqual([]);
      });

      it("does not write when the claim token is wrong", async () => {
        const message = await processing("complete-wrong-token", 1, 30);
        const wrong = { id: message.id, claimToken: randomUUID() };
        expect(await tx((transaction) => repository.markSent(transaction, wrong))).toBe(false);
        expect(await tx((transaction) => repository.markFailed(transaction, wrong))).toBe(false);
        expect(await tx((transaction) => repository.scheduleRetry(transaction, wrong, 1000))).toBe(false);
        expect(await row(message.id)).toMatchObject({ status: "PROCESSING", claimToken: message.claimToken });
      });

      it("prevents an old owner from completing a row after it was reclaimed", async () => {
        const previous = await processing("complete-reclaimed", 1, -1);
        await tx((transaction) => repository.recoverStaleLeases(transaction));
        const [current] = await claim();
        expect(await tx((transaction) => repository.markSent(transaction, previous))).toBe(false);
        expect(await row(previous.id)).toMatchObject({
          status: "PROCESSING",
          claimToken: current!.claimToken,
          attempts: 2,
        });
        expect(await tx((transaction) => repository.markSent(transaction, current!))).toBe(true);
      });

      it("cannot complete a claim after it is no longer PROCESSING", async () => {
        const message = await processing("complete-twice", 1, 30);
        expect(await tx((transaction) => repository.markSent(transaction, message))).toBe(true);
        expect(await tx((transaction) => repository.markSent(transaction, message))).toBe(false);
        expect(await tx((transaction) => repository.markFailed(transaction, message))).toBe(false);
      });
    });

    describe("job runs (§7, §13)", () => {
      it("creates a RUNNING row and finalizes it with counts and a finish time", async () => {
        const jobRunId = await tx((transaction) => repository.createJobRun(transaction, 7));
        jobRunIds.push(jobRunId);
        const [created] = await prisma.$queryRaw<{
          jobName: string;
          status: string;
          itemsProcessed: number;
          itemsFailed: number;
          finishedAt: Date | null;
        }[]>`
          SELECT "jobName", status, "itemsProcessed", "itemsFailed", "finishedAt"
          FROM job_runs WHERE id = ${jobRunId}`;
        expect(created).toMatchObject({
          jobName: "outbox-worker",
          status: "RUNNING",
          itemsProcessed: 7,
          itemsFailed: 0,
          finishedAt: null,
        });

        await tx((transaction) => repository.finalizeJobRun(transaction, jobRunId, {
          itemsProcessed: 7,
          itemsFailed: 2,
          status: "PARTIAL_FAILURE",
        }));
        const [finished] = await prisma.$queryRaw<{
          status: string;
          itemsFailed: number;
          finishedAt: Date | null;
        }[]>`
          SELECT status, "itemsFailed", "finishedAt" FROM job_runs WHERE id = ${jobRunId}`;
        expect(finished).toMatchObject({ status: "PARTIAL_FAILURE", itemsFailed: 2 });
        expect(finished!.finishedAt).not.toBeNull();
      });

      it("does not create a job run merely by claiming an empty queue", async () => {
        expect(await claim()).toEqual([]);
        const [count] = await prisma.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM job_runs WHERE "jobName" = 'outbox-worker'`;
        expect(count!.count).toBe(0);
      });
    });

    describe("input guards", () => {
      const ref = { id: "guard-id", claimToken: "guard-token" };

      it("rejects invalid batch sizes and lease durations before querying", async () => {
        await expect(claim(0)).rejects.toThrow(RangeError);
        await expect(claim(101)).rejects.toThrow(RangeError);
        await expect(claim(1.5)).rejects.toThrow(RangeError);
        await expect(claim(10, 0)).rejects.toThrow(RangeError);
        await expect(claim(10, Number.NaN)).rejects.toThrow(RangeError);
      });

      it("rejects duplicate IDs in a renewal batch and non-positive leases", async () => {
        await expect(
          tx((transaction) => repository.renewLeases(transaction, [ref, ref], 60)),
        ).rejects.toThrow(/duplicate/i);
        await expect(
          tx((transaction) => repository.renewLeases(transaction, [ref], 0)),
        ).rejects.toThrow(RangeError);
      });

      it("rejects negative or non-finite retry delays", async () => {
        await expect(
          tx((transaction) => repository.scheduleRetry(transaction, ref, -1)),
        ).rejects.toThrow(RangeError);
        await expect(
          tx((transaction) => repository.scheduleRetry(transaction, ref, Number.POSITIVE_INFINITY)),
        ).rejects.toThrow(RangeError);
      });

      it("rejects an empty job run and finalizing a job run that does not exist", async () => {
        await expect(
          tx((transaction) => repository.createJobRun(transaction, 0)),
        ).rejects.toThrow(RangeError);
        await expect(
          tx((transaction) =>
            repository.finalizeJobRun(transaction, `${idPrefix}missing-run`, {
              itemsProcessed: 1,
              itemsFailed: 0,
              status: "SUCCESS",
            }),
          ),
        ).rejects.toThrow(/exactly one row/);
      });
    });
  },
);
