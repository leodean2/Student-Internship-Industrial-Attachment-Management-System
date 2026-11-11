import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Tx } from "../../infrastructure/transaction";
import type { JsonValue } from "./email-provider";
import type { FinalJobRunStatus } from "./job-run-status";
import { MAX_ATTEMPTS } from "./retry-policy";

export const OUTBOX_JOB_NAME = "outbox-worker";

export interface OutboxMessage {
  toEmail: string;
  relatedUserId?: string | null;
  templateType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ClaimedMessage {
  readonly id: string;
  readonly toEmail: string;
  readonly templateType: string;
  readonly payload: JsonValue;
  readonly attempts: number;
  readonly claimToken: string;
}

export interface ClaimRef {
  readonly id: string;
  readonly claimToken: string;
}

export interface RecoveryResult {
  readonly requeued: number;
  readonly failed: number;
}

export interface OutboxEnqueuer {
  enqueue(tx: Tx, message: OutboxMessage): Promise<{ created: boolean }>;
}

export interface OutboxRepository extends OutboxEnqueuer {
  recoverStaleLeases(tx: Tx): Promise<RecoveryResult>;
  claimBatch(tx: Tx, batchSize: number, leaseSeconds: number): Promise<ClaimedMessage[]>;
  renewLeases(tx: Tx, claims: readonly ClaimRef[], leaseSeconds: number): Promise<string[]>;
  markSent(tx: Tx, claim: ClaimRef): Promise<boolean>;
  markFailed(tx: Tx, claim: ClaimRef): Promise<boolean>;
  scheduleRetry(tx: Tx, claim: ClaimRef, delayMs: number): Promise<boolean>;
  createJobRun(tx: Tx, itemsProcessed: number): Promise<string>;
  finalizeJobRun(
    tx: Tx,
    jobRunId: string,
    result: { itemsProcessed: number; itemsFailed: number; status: FinalJobRunStatus },
  ): Promise<void>;
}

interface CandidateRow {
  id: string;
  toEmail: string;
  templateType: string;
  payload: JsonValue;
  attempts: number;
}

interface ClaimedRow {
  id: string;
  claimToken: string;
  attempts: number;
}

const pairRows = (claims: readonly ClaimRef[]): Prisma.Sql =>
  Prisma.join(claims.map((claim) => Prisma.sql`(${claim.id}::text, ${claim.claimToken}::text)`));

function assertLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new RangeError(`leaseSeconds must be positive and finite (received ${leaseSeconds})`);
  }
}

function assertRetryDelay(delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(`delayMs must be non-negative and finite (received ${delayMs})`);
  }
}

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly newClaimToken: () => string = randomUUID) {}

  async enqueue(tx: Tx, message: OutboxMessage): Promise<{ created: boolean }> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO email_outbox ("id", "toEmail", "relatedUserId", "templateType", "payload", "idempotencyKey")
      VALUES (${randomUUID()}, ${message.toEmail}, ${message.relatedUserId ?? null}, ${message.templateType}, ${JSON.stringify(message.payload)}::jsonb, ${message.idempotencyKey})
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING "id"`;
    return { created: rows.length === 1 };
  }

  async recoverStaleLeases(tx: Tx): Promise<RecoveryResult> {
    const requeued = await tx.$executeRaw(Prisma.sql`
      UPDATE email_outbox
      SET status = 'PENDING',
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "processingStartedAt" = NULL
      WHERE status = 'PROCESSING'
        AND "leaseExpiresAt" < clock_timestamp()
        AND attempts < ${MAX_ATTEMPTS}`);
    const failed = await tx.$executeRaw(Prisma.sql`
      UPDATE email_outbox
      SET status = 'FAILED',
          payload = NULL,
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "processingStartedAt" = NULL
      WHERE status = 'PROCESSING'
        AND "leaseExpiresAt" < clock_timestamp()
        AND attempts >= ${MAX_ATTEMPTS}`);
    return { requeued, failed };
  }

  async claimBatch(tx: Tx, batchSize: number, leaseSeconds: number): Promise<ClaimedMessage[]> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new RangeError(`batchSize must be an integer from 1 to 100 (received ${batchSize})`);
    }
    assertLeaseSeconds(leaseSeconds);

    const candidates = await tx.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT id, "toEmail", "templateType", payload, attempts
      FROM email_outbox
      WHERE status = 'PENDING'
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY "createdAt" ASC, id ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED`);
    if (candidates.length === 0) return [];

    const refs = candidates.map(({ id }) => ({ id, claimToken: this.newClaimToken() }));
    const claimById = new Map(refs.map((ref) => [ref.id, ref.claimToken]));
    const claimed = await tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
      UPDATE email_outbox
      SET status = 'PROCESSING',
          "processingStartedAt" = clock_timestamp(),
          "claimToken" = v."claimToken",
          "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision),
          attempts = attempts + 1,
          "nextAttemptAt" = NULL
      FROM (VALUES ${pairRows(refs)}) AS v(id, "claimToken")
      WHERE email_outbox.id = v.id
        AND email_outbox.status = 'PENDING'
        AND email_outbox.attempts < ${MAX_ATTEMPTS}
      RETURNING email_outbox.id, email_outbox."claimToken", email_outbox.attempts`);

    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    if (claimed.length !== candidates.length) {
      throw new Error("Outbox claim did not update every row locked for processing.");
    }

    return claimed.map((row) => {
      const candidate = byId.get(row.id);
      if (!candidate || claimById.get(row.id) !== row.claimToken) {
        throw new Error("Outbox claim returned an unexpected ID or claim token.");
      }
      return {
        id: row.id,
        toEmail: candidate.toEmail,
        templateType: candidate.templateType,
        payload: candidate.payload,
        attempts: Number(row.attempts),
        claimToken: row.claimToken,
      };
    });
  }

  async renewLeases(tx: Tx, claims: readonly ClaimRef[], leaseSeconds: number): Promise<string[]> {
    if (claims.length === 0) return [];
    assertLeaseSeconds(leaseSeconds);
    if (new Set(claims.map(({ id }) => id)).size !== claims.length) {
      throw new Error("A lease renewal batch cannot contain duplicate message IDs.");
    }
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE email_outbox
      SET "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision)
      FROM (VALUES ${pairRows(claims)}) AS v(id, "claimToken")
      WHERE email_outbox.id = v.id
        AND email_outbox."claimToken" = v."claimToken"
        AND email_outbox.status = 'PROCESSING'
      RETURNING email_outbox.id`);
    return rows.map(({ id }) => id);
  }

  async markSent(tx: Tx, claim: ClaimRef): Promise<boolean> {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE email_outbox
      SET status = 'SENT',
          "sentAt" = clock_timestamp(),
          payload = NULL,
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "processingStartedAt" = NULL
      WHERE id = ${claim.id}
        AND "claimToken" = ${claim.claimToken}
        AND status = 'PROCESSING'`);
    return updated === 1;
  }

  async markFailed(tx: Tx, claim: ClaimRef): Promise<boolean> {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE email_outbox
      SET status = 'FAILED',
          payload = NULL,
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "processingStartedAt" = NULL
      WHERE id = ${claim.id}
        AND "claimToken" = ${claim.claimToken}
        AND status = 'PROCESSING'`);
    return updated === 1;
  }

  async scheduleRetry(tx: Tx, claim: ClaimRef, delayMs: number): Promise<boolean> {
    assertRetryDelay(delayMs);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE email_outbox
      SET status = 'PENDING',
          "nextAttemptAt" = clock_timestamp() + make_interval(secs => ${delayMs / 1000}::double precision),
          "claimToken" = NULL,
          "leaseExpiresAt" = NULL,
          "processingStartedAt" = NULL
      WHERE id = ${claim.id}
        AND "claimToken" = ${claim.claimToken}
        AND status = 'PROCESSING'`);
    return updated === 1;
  }

  async createJobRun(tx: Tx, itemsProcessed: number): Promise<string> {
    if (!Number.isInteger(itemsProcessed) || itemsProcessed < 1) {
      throw new RangeError(`itemsProcessed must be a positive integer (received ${itemsProcessed})`);
    }
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO job_runs (id, "jobName", "startedAt", "itemsProcessed", "itemsFailed", status)
      VALUES (gen_random_uuid()::text, ${OUTBOX_JOB_NAME}, clock_timestamp(), ${itemsProcessed}, 0, 'RUNNING')
      RETURNING id`);
    const row = rows[0];
    if (!row) throw new Error("Failed to create a job run record.");
    return row.id;
  }

  async finalizeJobRun(
    tx: Tx,
    jobRunId: string,
    result: { itemsProcessed: number; itemsFailed: number; status: FinalJobRunStatus },
  ): Promise<void> {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE job_runs
      SET "finishedAt" = clock_timestamp(),
          "itemsProcessed" = ${result.itemsProcessed},
          "itemsFailed" = ${result.itemsFailed},
          status = ${result.status}::"JobRunStatus"
      WHERE id = ${jobRunId}`);
    if (updated !== 1) throw new Error("Job-run finalization did not update exactly one row.");
  }
}
