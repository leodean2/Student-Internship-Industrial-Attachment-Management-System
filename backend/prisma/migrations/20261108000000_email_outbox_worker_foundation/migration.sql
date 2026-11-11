-- Decision #54: email outbox worker lease/ownership fields and RUNNING status.
-- Preflight: no worker process may be running while this is applied. (The worker is introduced by this decision.)

-- AlterEnum
ALTER TYPE "JobRunStatus" ADD VALUE IF NOT EXISTS 'RUNNING';

-- AlterTable
ALTER TABLE "email_outbox"
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);

-- One-time operational reset (Decision #54 §4).
-- Rows left in PROCESSING by any earlier code have NULL lease data, and the normal stale-lease recovery query
-- ("leaseExpiresAt" < clock_timestamp()) never matches NULL, so they would stay stuck forever. Return them to
-- the queue, or fail them if they already exhausted their 5 attempts. Idempotent: after the first run no
-- PROCESSING row has a NULL lease, so re-running changes nothing. Normal PROCESSING rows written by the new
-- worker always carry a lease and are not touched.
UPDATE "email_outbox"
SET "status" = 'PENDING'
WHERE "status" = 'PROCESSING' AND "leaseExpiresAt" IS NULL AND "attempts" < 5;

UPDATE "email_outbox"
SET "status" = 'FAILED'
WHERE "status" = 'PROCESSING' AND "leaseExpiresAt" IS NULL AND "attempts" >= 5;
