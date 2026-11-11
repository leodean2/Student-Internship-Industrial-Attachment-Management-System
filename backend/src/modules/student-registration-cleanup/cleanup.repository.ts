import { Prisma } from "@prisma/client";
import type { Tx } from "../../infrastructure/transaction";
import { SYSTEM_USER_ID } from "../../shared/system-user";
import { STUDENT_REGISTRATION_CLEANUP_JOB_NAME } from "./cleanup.job-name";

export const CLEANUP_BATCH_SIZE = 100;

export type CleanupRunStatus = "SUCCESS" | "PARTIAL_FAILURE" | "FAILED";

export interface StudentRegistrationCleanupRepository {
  startJobRun(tx: Tx): Promise<string>;
  findEligibleUserIds(tx: Tx, limit: number): Promise<string[]>;
  cleanupEligibleUser(tx: Tx, userId: string): Promise<boolean>;
  finishJobRun(
    tx: Tx,
    jobRunId: string,
    result: { itemsProcessed: number; itemsFailed: number; status: CleanupRunStatus },
  ): Promise<void>;
}

const eligibleUserPredicate = Prisma.sql`(
  (
    u.status = 'PENDING_VERIFICATION'
    AND u."emailVerifiedAt" IS NULL
    AND sp."registrationStatus" = 'PENDING'
    AND u."createdAt" <= c.now - INTERVAL '14 days'
  )
  OR (
    u.status <> 'ACTIVE'
    AND sp."registrationStatus" = 'REJECTED'
    AND sp."registrationDecidedAt" <= c.now - INTERVAL '14 days'
  )
)`;

const studentOnlyPredicate = Prisma.sql`(
  EXISTS (
    SELECT 1 FROM user_roles AS student_role
    WHERE student_role."userId" = u.id AND student_role.role = 'STUDENT'
  )
  AND NOT EXISTS (
    SELECT 1 FROM user_roles AS other_role
    WHERE other_role."userId" = u.id AND other_role.role <> 'STUDENT'
  )
)`;

export class PrismaStudentRegistrationCleanupRepository implements StudentRegistrationCleanupRepository {
  async startJobRun(tx: Tx): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO job_runs (id, "jobName", "startedAt", "itemsProcessed", "itemsFailed", status)
      VALUES (gen_random_uuid()::text, ${STUDENT_REGISTRATION_CLEANUP_JOB_NAME}, clock_timestamp(), 0, 0, 'RUNNING')
      RETURNING id`;
    const row = rows[0];
    if (!row) throw new Error("Failed to create a student registration cleanup job run.");
    return row.id;
  }

  async findEligibleUserIds(tx: Tx, limit: number): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > CLEANUP_BATCH_SIZE) {
      throw new RangeError(`limit must be an integer from 1 to ${CLEANUP_BATCH_SIZE}`);
    }

    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH cutoff AS (SELECT transaction_timestamp() AS now)
      SELECT u.id
      FROM users AS u
      JOIN student_profiles AS sp ON sp."userId" = u.id
      CROSS JOIN cutoff AS c
      WHERE ${studentOnlyPredicate}
        AND ${eligibleUserPredicate}
      ORDER BY u."createdAt", u.id
      LIMIT ${limit}`);
    return rows.map(({ id }) => id);
  }

  async cleanupEligibleUser(tx: Tx, userId: string): Promise<boolean> {
    const profiles = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM student_profiles WHERE "userId" = ${userId} FOR UPDATE`;
    if (profiles.length !== 1) return false;

    const users = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (users.length !== 1) return false;

    const eligible = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH cutoff AS (SELECT clock_timestamp() AS now)
      SELECT u.id
      FROM users AS u
      JOIN student_profiles AS sp ON sp."userId" = u.id
      CROSS JOIN cutoff AS c
      WHERE u.id = ${userId}
        AND ${studentOnlyPredicate}
        AND ${eligibleUserPredicate}`);
    if (eligible.length !== 1) return false;

    const lockedOutboxRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM email_outbox
      WHERE "relatedUserId" = ${userId}
      FOR UPDATE SKIP LOCKED`;
    const relatedOutboxCounts = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM email_outbox WHERE "relatedUserId" = ${userId}`;
    const relatedOutboxRows = relatedOutboxCounts[0]?.count;
    if (relatedOutboxRows === undefined || lockedOutboxRows.length !== relatedOutboxRows) {
      throw new Error("Student registration cleanup could not lock every related outbox row.");
    }

    await tx.$executeRaw`
      DELETE FROM email_outbox WHERE "relatedUserId" = ${userId}`;

    await tx.$executeRaw`
      DELETE FROM notifications WHERE "recipientUserId" = ${userId}`;

    await tx.$executeRaw`
      UPDATE audit_logs
      SET "actorUserId" = ${SYSTEM_USER_ID},
          metadata = CASE
            WHEN jsonb_typeof(metadata) = 'object'
              THEN metadata || jsonb_build_object('originalActorUserId', "actorUserId")
            ELSE jsonb_build_object(
              'originalMetadata', metadata,
              'originalActorUserId', "actorUserId"
            )
          END
      WHERE "actorUserId" = ${userId}`;

    await tx.$executeRaw`DELETE FROM email_verification_tokens WHERE "userId" = ${userId}`;

    const deletedProfiles = await tx.$executeRaw`
      DELETE FROM student_profiles WHERE "userId" = ${userId}`;
    if (deletedProfiles !== 1) {
      throw new Error("Student registration cleanup did not delete exactly one profile.");
    }

    const deletedRoles = await tx.$executeRaw`
      DELETE FROM user_roles WHERE "userId" = ${userId} AND role = 'STUDENT'`;
    if (deletedRoles !== 1) {
      throw new Error("Student registration cleanup did not delete exactly one student role.");
    }

    const deletedUsers = await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
    if (deletedUsers !== 1) {
      throw new Error("Student registration cleanup did not delete exactly one user.");
    }
    return true;
  }

  async finishJobRun(
    tx: Tx,
    jobRunId: string,
    result: { itemsProcessed: number; itemsFailed: number; status: CleanupRunStatus },
  ): Promise<void> {
    if (
      !Number.isInteger(result.itemsProcessed) ||
      result.itemsProcessed < 0 ||
      !Number.isInteger(result.itemsFailed) ||
      result.itemsFailed < 0 ||
      result.itemsFailed > result.itemsProcessed
    ) {
      throw new RangeError("Invalid student registration cleanup job-run counts.");
    }

    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE job_runs
      SET "finishedAt" = clock_timestamp(),
          "itemsProcessed" = ${result.itemsProcessed},
          "itemsFailed" = ${result.itemsFailed},
          status = ${result.status}::"JobRunStatus"
      WHERE id = ${jobRunId}
        AND "jobName" = ${STUDENT_REGISTRATION_CLEANUP_JOB_NAME}
        AND status = 'RUNNING'`);
    if (updated !== 1) throw new Error("Student registration cleanup job-run finalization did not update exactly one row.");
  }
}
