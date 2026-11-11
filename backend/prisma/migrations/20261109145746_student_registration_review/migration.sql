-- Validate legacy identifiers before adding schema. The application preflight uses
-- departmentCodeOf/isValidRegistrationNumber from shared/registration-number.ts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "student_profiles"
    WHERE "registrationNumber" IS NULL
       OR "registrationNumber" !~ '^[A-Z]{3}-[0-9]{3}-[0-9]{3}/[0-9]{4}$'
  ) THEN
    RAISE EXCEPTION 'student_profiles contains a null or invalid registration number; investigate before applying this migration';
  END IF;
END $$;

/*
  Warnings:

  - Added the required column `registrationDepartmentCode` to the `student_profiles` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- AlterTable
ALTER TABLE "student_profiles" ADD COLUMN     "registrationDecidedAt" TIMESTAMP(3),
ADD COLUMN     "registrationDecidedByUserId" TEXT,
ADD COLUMN     "registrationDecisionBasis" TEXT,
ADD COLUMN     "registrationDecisionReason" TEXT,
ADD COLUMN     "registrationDepartmentCode" TEXT,
ADD COLUMN     "registrationStatus" "RegistrationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "rejectedRegistrationNumber" TEXT,
ALTER COLUMN "registrationNumber" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "student_profiles_registrationStatus_registrationDepartmentC_idx" ON "student_profiles"("registrationStatus", "registrationDepartmentCode");

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_registrationDecidedByUserId_fkey" FOREIGN KEY ("registrationDecidedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Existing profiles remain pending and retain their registration numbers. The prefix
-- is populated only after the same strict registration-number shape has been preflighted.
UPDATE "student_profiles"
SET "registrationDepartmentCode" = substring("registrationNumber" from '^([A-Z]{3})-[0-9]{3}-[0-9]{3}/[0-9]{4}$'),
    "registrationStatus" = 'PENDING',
    "registrationDecidedAt" = NULL,
    "registrationDecidedByUserId" = NULL,
    "registrationDecisionBasis" = NULL,
    "registrationDecisionReason" = NULL;

ALTER TABLE "student_profiles"
  ALTER COLUMN "registrationDepartmentCode" SET NOT NULL;

-- C1-D3: the profile's registration state must be internally consistent.
ALTER TABLE "student_profiles"
  ADD CONSTRAINT "ck_student_profiles_confirmed_complete"
  CHECK ("registrationStatus" <> 'CONFIRMED' OR (
    "registrationNumber" IS NOT NULL AND "registrationDecidedAt" IS NOT NULL
    AND "registrationDecidedByUserId" IS NOT NULL AND "registrationDecisionBasis" IS NOT NULL));

ALTER TABLE "student_profiles"
  ADD CONSTRAINT "ck_student_profiles_rejected_complete"
  CHECK ("registrationStatus" <> 'REJECTED' OR (
    "registrationNumber" IS NULL AND "rejectedRegistrationNumber" IS NOT NULL
    AND "registrationDecidedAt" IS NOT NULL AND "registrationDecidedByUserId" IS NOT NULL
    AND "registrationDecisionReason" IS NOT NULL));

ALTER TABLE "student_profiles"
  ADD CONSTRAINT "ck_student_profiles_pending_has_number"
  CHECK ("registrationStatus" <> 'PENDING' OR "registrationNumber" IS NOT NULL);
