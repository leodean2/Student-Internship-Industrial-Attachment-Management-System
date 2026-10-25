-- =============================================================================
-- constraints.sql
-- Constraints that Prisma's schema syntax cannot express. Apply as a follow-up
-- migration AFTER the baseline `prisma migrate dev` migration has created the
-- tables (e.g. save as prisma/migrations/<timestamp>_constraints/migration.sql).
-- Every statement cites the decision it implements (see data-model.md).
-- Table/column names match the @@map / field names in schema.prisma
-- (columns are camelCase and must be double-quoted).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PARTIAL UNIQUE INDEXES  (#71)
-- -----------------------------------------------------------------------------

-- #7/#34/#35: one unresolved application per student
CREATE UNIQUE INDEX "uq_application_one_unresolved_per_student"
  ON "attachment_applications" ("studentId")
  WHERE "status" IN ('ADMIN_CREATED','DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','CLAIMED');

-- #1: one ACTIVE attachment per student
CREATE UNIQUE INDEX "uq_attachment_one_active_per_student"
  ON "attachments" ("studentId")
  WHERE "status" = 'ACTIVE';

-- #67 (Option A): exactly one current FinalEvaluation per attachment
CREATE UNIQUE INDEX "uq_final_evaluation_one_current_per_attachment"
  ON "final_evaluations" ("attachmentId")
  WHERE "supersededAt" IS NULL;

-- #68: exactly one current version per document
CREATE UNIQUE INDEX "uq_document_version_one_current"
  ON "document_versions" ("documentId")
  WHERE "isCurrent" = true;

-- -----------------------------------------------------------------------------
-- SINGLETON TABLE  (#61/#72)
-- -----------------------------------------------------------------------------

ALTER TABLE "reporting_schedule_config"
  ADD CONSTRAINT "ck_reporting_schedule_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "ck_reporting_period_length_positive" CHECK ("periodLengthDays" > 0);

INSERT INTO "reporting_schedule_config" ("id", "periodLengthDays", "updatedAt")
VALUES (1, 7, NOW())
ON CONFLICT ("id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- ATTACHMENT  (#14, #61, #72)
-- NOTE: deliberately NO CHECK tying status to universitySupervisorId — that is
-- a service-layer precondition on the CONFIRMED->ACTIVE job (#36, #72 amendment).
-- -----------------------------------------------------------------------------

ALTER TABLE "attachments"
  ADD CONSTRAINT "ck_attachment_dates" CHECK ("endDate" >= "startDate"),
  ADD CONSTRAINT "ck_attachment_period_length_positive" CHECK ("reportingPeriodLengthDays" > 0),
  ADD CONSTRAINT "ck_attachment_outcome_only_when_terminal"
    CHECK ("outcome" IS NULL OR "status" IN ('COMPLETED','ENDED_EARLY'));

-- -----------------------------------------------------------------------------
-- ATTACHMENT APPLICATION  (#72)
-- -----------------------------------------------------------------------------

ALTER TABLE "attachment_applications"
  ADD CONSTRAINT "ck_application_rejection_reason"
    CHECK ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL),
  ADD CONSTRAINT "ck_application_decline_reason"
    CHECK ("status" <> 'DECLINED' OR "declineReason" IS NOT NULL),
  ADD CONSTRAINT "ck_application_review_paired"
    CHECK (("reviewedById" IS NULL) = ("reviewedAt" IS NULL)),
  ADD CONSTRAINT "ck_application_claim_paired"
    CHECK (("claimedBySupervisorId" IS NULL) = ("claimedAt" IS NULL));

-- -----------------------------------------------------------------------------
-- TERMINATION RECORD  (#72)
-- -----------------------------------------------------------------------------

ALTER TABLE "termination_records"
  ADD CONSTRAINT "ck_termination_clearance_paired"
    CHECK (("clearanceGrantedAt" IS NULL) = ("clearanceGrantedByAdminId" IS NULL));

-- -----------------------------------------------------------------------------
-- WEEKLY LOG  (#19, #61, #72)
-- -----------------------------------------------------------------------------

ALTER TABLE "weekly_logs"
  ADD CONSTRAINT "ck_weekly_log_period_positive" CHECK ("periodNumber" >= 1),
  ADD CONSTRAINT "ck_weekly_log_revision_comment"
    CHECK ("status" <> 'NEEDS_REVISION' OR "revisionComment" IS NOT NULL),
  ADD CONSTRAINT "ck_weekly_log_org_verification_paired"
    CHECK (("orgVerifiedAt" IS NULL) = ("orgVerifiedBy" IS NULL));

-- -----------------------------------------------------------------------------
-- EVALUATIONS  (#72) — ratings and scores are on a 0-100 scale
-- Weights summing to 100 across the ACTIVE criteria set is NOT a CHECK: it is
-- an aggregate across rows, enforced by the admin config service inside a
-- single transaction against the complete resulting active set.
-- -----------------------------------------------------------------------------

ALTER TABLE "evaluation_criteria"
  ADD CONSTRAINT "ck_criterion_weight_range" CHECK ("weight" > 0 AND "weight" <= 100);

ALTER TABLE "industry_evaluation_ratings"
  ADD CONSTRAINT "ck_industry_rating_range" CHECK ("rating" BETWEEN 0 AND 100);

ALTER TABLE "final_evaluation_ratings"
  ADD CONSTRAINT "ck_final_rating_range" CHECK ("rating" BETWEEN 0 AND 100);

ALTER TABLE "final_evaluations"
  ADD CONSTRAINT "ck_final_overall_score_range"
    CHECK ("overallScore" IS NULL OR "overallScore" BETWEEN 0 AND 100);

-- -----------------------------------------------------------------------------
-- DOCUMENTS  (#68, #72)
-- -----------------------------------------------------------------------------

ALTER TABLE "documents"
  ADD CONSTRAINT "ck_document_exactly_one_parent"
    CHECK (num_nonnulls("attachmentApplicationId", "attachmentId") = 1);

ALTER TABLE "document_versions"
  ADD CONSTRAINT "ck_document_version_size_positive" CHECK ("sizeBytes" > 0);

-- -----------------------------------------------------------------------------
-- INVITATION  (#62/#72): organizationId present iff role = ORGANIZATION_SUPERVISOR
-- -----------------------------------------------------------------------------

ALTER TABLE "invitations"
  ADD CONSTRAINT "ck_invitation_role_org_pairing"
    CHECK (("role" = 'ORGANIZATION_SUPERVISOR') = ("organizationId" IS NOT NULL));

-- -----------------------------------------------------------------------------
-- EMAIL OUTBOX  (#72)
-- -----------------------------------------------------------------------------

ALTER TABLE "email_outbox"
  ADD CONSTRAINT "ck_outbox_attempts_nonnegative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "ck_outbox_sent_requires_timestamp"
    CHECK ("status" <> 'SENT' OR "sentAt" IS NOT NULL);

-- -----------------------------------------------------------------------------
-- REFRESH TOKEN SESSION CAP  (Decision #77)
-- A token can never outlive its session. (That every token in a rotation chain carries the SAME
-- sessionExpiresAt is a cross-row rule: enforced by the application, verified by verify-structure.sql.)
-- -----------------------------------------------------------------------------

ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "ck_refresh_token_within_session" CHECK ("expiresAt" <= "sessionExpiresAt");

-- -----------------------------------------------------------------------------
-- SEED: SYSTEM sentinel user  (#69)
-- Holds NO row in user_roles — structurally incapable of authenticating, being
-- assigned, or passing any role guard. Non-loginable placeholder password hash.
-- -----------------------------------------------------------------------------

INSERT INTO "users" ("id", "email", "passwordHash", "name", "status", "createdAt", "updatedAt")
VALUES ('00000000-0000-0000-0000-000000000001', 'system@internal.invalid', '!', 'SYSTEM', 'ACTIVE', NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;
