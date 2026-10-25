-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "UserRoleName" AS ENUM ('STUDENT', 'UNIVERSITY_SUPERVISOR', 'ORGANIZATION_SUPERVISOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('ADMIN_CREATED', 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'CLAIMED', 'ACCEPTED', 'REJECTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('CONFIRMED', 'ACTIVE', 'COMPLETION_PENDING', 'COMPLETED', 'ENDED_EARLY');

-- CreateEnum
CREATE TYPE "AttachmentOutcome" AS ENUM ('SATISFACTORY', 'UNSATISFACTORY', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "TerminationInitiator" AS ENUM ('STUDENT', 'ORGANIZATION', 'UNIVERSITY');

-- CreateEnum
CREATE TYPE "WeeklyLogStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEEDS_REVISION', 'REVIEWED');

-- CreateEnum
CREATE TYPE "FinalEvaluationStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('APPLICATION_SUPPORTING', 'ATTACHMENT_PERIOD');

-- CreateEnum
CREATE TYPE "EmailOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('SUCCESS', 'PARTIAL_FAILURE', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRoleName" NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "course" TEXT,
    "faculty" TEXT,
    "department" TEXT,
    "yearOfStudy" INTEGER,
    "expectedGraduation" TIMESTAMP(3),

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "university_supervisor_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "staffId" TEXT,
    "title" TEXT,

    CONSTRAINT "university_supervisor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_supervisor_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "organization_supervisor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "admin_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sessionExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRoleName" NOT NULL,
    "organizationId" TEXT,
    "invitedByUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedByUserId" TEXT,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'PENDING',
    "proposedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_applications" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "claimedBySupervisorId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "studentAcknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachment_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "organizationSupervisorId" TEXT NOT NULL,
    "universitySupervisorId" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "outcome" "AttachmentOutcome",
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reportingPeriodLengthDays" INTEGER NOT NULL,
    "previousAttachmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "termination_reason_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiresAdminClearanceForReapplication" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "termination_reason_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "termination_records" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "reasonCategoryId" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "initiatedByType" "TerminationInitiator" NOT NULL,
    "reasonDescription" TEXT NOT NULL,
    "terminatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearanceGrantedAt" TIMESTAMP(3),
    "clearanceGrantedByAdminId" TEXT,

    CONSTRAINT "termination_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporting_schedule_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "periodLengthDays" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reporting_schedule_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_logs" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "periodNumber" INTEGER NOT NULL,
    "activities" TEXT NOT NULL,
    "skillsLearned" TEXT,
    "challenges" TEXT,
    "reflection" TEXT,
    "status" "WeeklyLogStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewedById" TEXT,
    "revisionComment" TEXT,
    "orgVerifiedAt" TIMESTAMP(3),
    "orgVerifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_log_versions" (
    "id" TEXT NOT NULL,
    "weeklyLogId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "activities" TEXT NOT NULL,
    "skillsLearned" TEXT,
    "challenges" TEXT,
    "reflection" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_log_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervision_visits" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "universitySupervisorId" TEXT NOT NULL,
    "visitDate" TIMESTAMP(3) NOT NULL,
    "visitType" TEXT,
    "summary" TEXT NOT NULL,
    "observations" TEXT NOT NULL,
    "recommendations" TEXT NOT NULL,
    "studentAcknowledgedAt" TIMESTAMP(3),
    "studentComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervision_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_criteria" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "evaluation_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "industry_evaluations" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "industry_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "industry_evaluation_ratings" (
    "id" TEXT NOT NULL,
    "industryEvaluationId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,

    CONSTRAINT "industry_evaluation_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "industry_evaluation_versions" (
    "id" TEXT NOT NULL,
    "industryEvaluationId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "industry_evaluation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "final_evaluations" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "universitySupervisorId" TEXT NOT NULL,
    "status" "FinalEvaluationStatus" NOT NULL DEFAULT 'DRAFT',
    "overallScore" DECIMAL(5,2),
    "outcome" "AttachmentOutcome",
    "finalizedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "supersededByFinalEvaluationId" TEXT,
    "industryEvaluationVersionIdUsed" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "final_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "final_evaluation_ratings" (
    "id" TEXT NOT NULL,
    "finalEvaluationId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,

    CONSTRAINT "final_evaluation_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_type_configs" (
    "id" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "document_type_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "attachmentApplicationId" TEXT,
    "attachmentId" TEXT,
    "documentTypeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "relatedUserId" TEXT,
    "templateType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "status" "JobRunStatus" NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_userId_role_key" ON "user_roles"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_userId_key" ON "student_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_registrationNumber_key" ON "student_profiles"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "university_supervisor_profiles_userId_key" ON "university_supervisor_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_supervisor_profiles_userId_organizationId_key" ON "organization_supervisor_profiles"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_profiles_userId_key" ON "admin_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replacedById_key" ON "refresh_tokens"("replacedById");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_tokenHash_key" ON "email_verification_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_acceptedByUserId_key" ON "invitations"("acceptedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_applicationId_key" ON "attachments"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_previousAttachmentId_key" ON "attachments"("previousAttachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "termination_reason_categories_code_key" ON "termination_reason_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "termination_records_attachmentId_key" ON "termination_records"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_logs_attachmentId_periodNumber_key" ON "weekly_logs"("attachmentId", "periodNumber");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_log_versions_weeklyLogId_versionNumber_key" ON "weekly_log_versions"("weeklyLogId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "industry_evaluations_attachmentId_key" ON "industry_evaluations"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "industry_evaluation_ratings_industryEvaluationId_criterionI_key" ON "industry_evaluation_ratings"("industryEvaluationId", "criterionId");

-- CreateIndex
CREATE UNIQUE INDEX "industry_evaluation_versions_industryEvaluationId_versionNu_key" ON "industry_evaluation_versions"("industryEvaluationId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "final_evaluations_supersededByFinalEvaluationId_key" ON "final_evaluations"("supersededByFinalEvaluationId");

-- CreateIndex
CREATE UNIQUE INDEX "final_evaluation_ratings_finalEvaluationId_criterionId_key" ON "final_evaluation_ratings"("finalEvaluationId", "criterionId");

-- CreateIndex
CREATE UNIQUE INDEX "document_type_configs_category_code_key" ON "document_type_configs"("category", "code");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storageKey_key" ON "document_versions"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_versionNumber_key" ON "document_versions"("documentId", "versionNumber");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_idempotencyKey_key" ON "email_outbox"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "university_supervisor_profiles" ADD CONSTRAINT "university_supervisor_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organization_supervisor_profiles" ADD CONSTRAINT "organization_supervisor_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organization_supervisor_profiles" ADD CONSTRAINT "organization_supervisor_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admin_profiles" ADD CONSTRAINT "admin_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "refresh_tokens"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachment_applications" ADD CONSTRAINT "attachment_applications_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachment_applications" ADD CONSTRAINT "attachment_applications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachment_applications" ADD CONSTRAINT "attachment_applications_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachment_applications" ADD CONSTRAINT "attachment_applications_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachment_applications" ADD CONSTRAINT "attachment_applications_claimedBySupervisorId_fkey" FOREIGN KEY ("claimedBySupervisorId") REFERENCES "organization_supervisor_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "attachment_applications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organizationSupervisorId_fkey" FOREIGN KEY ("organizationSupervisorId") REFERENCES "organization_supervisor_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_universitySupervisorId_fkey" FOREIGN KEY ("universitySupervisorId") REFERENCES "university_supervisor_profiles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_previousAttachmentId_fkey" FOREIGN KEY ("previousAttachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_reasonCategoryId_fkey" FOREIGN KEY ("reasonCategoryId") REFERENCES "termination_reason_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "termination_records" ADD CONSTRAINT "termination_records_clearanceGrantedByAdminId_fkey" FOREIGN KEY ("clearanceGrantedByAdminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_logs" ADD CONSTRAINT "weekly_logs_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_logs" ADD CONSTRAINT "weekly_logs_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_logs" ADD CONSTRAINT "weekly_logs_orgVerifiedBy_fkey" FOREIGN KEY ("orgVerifiedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "weekly_log_versions" ADD CONSTRAINT "weekly_log_versions_weeklyLogId_fkey" FOREIGN KEY ("weeklyLogId") REFERENCES "weekly_logs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supervision_visits" ADD CONSTRAINT "supervision_visits_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supervision_visits" ADD CONSTRAINT "supervision_visits_universitySupervisorId_fkey" FOREIGN KEY ("universitySupervisorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "industry_evaluations" ADD CONSTRAINT "industry_evaluations_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "industry_evaluations" ADD CONSTRAINT "industry_evaluations_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "industry_evaluation_ratings" ADD CONSTRAINT "industry_evaluation_ratings_industryEvaluationId_fkey" FOREIGN KEY ("industryEvaluationId") REFERENCES "industry_evaluations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "industry_evaluation_ratings" ADD CONSTRAINT "industry_evaluation_ratings_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "evaluation_criteria"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "industry_evaluation_versions" ADD CONSTRAINT "industry_evaluation_versions_industryEvaluationId_fkey" FOREIGN KEY ("industryEvaluationId") REFERENCES "industry_evaluations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "final_evaluations" ADD CONSTRAINT "final_evaluations_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "final_evaluations" ADD CONSTRAINT "final_evaluations_universitySupervisorId_fkey" FOREIGN KEY ("universitySupervisorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "final_evaluations" ADD CONSTRAINT "final_evaluations_supersededByFinalEvaluationId_fkey" FOREIGN KEY ("supersededByFinalEvaluationId") REFERENCES "final_evaluations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "final_evaluations" ADD CONSTRAINT "final_evaluations_industryEvaluationVersionIdUsed_fkey" FOREIGN KEY ("industryEvaluationVersionIdUsed") REFERENCES "industry_evaluation_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "final_evaluation_ratings" ADD CONSTRAINT "final_evaluation_ratings_finalEvaluationId_fkey" FOREIGN KEY ("finalEvaluationId") REFERENCES "final_evaluations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "final_evaluation_ratings" ADD CONSTRAINT "final_evaluation_ratings_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "evaluation_criteria"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_attachmentApplicationId_fkey" FOREIGN KEY ("attachmentApplicationId") REFERENCES "attachment_applications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "document_type_configs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_relatedUserId_fkey" FOREIGN KEY ("relatedUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

