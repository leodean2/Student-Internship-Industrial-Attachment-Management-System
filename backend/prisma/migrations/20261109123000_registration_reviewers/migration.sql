-- CreateTable
CREATE TABLE "registration_reviewers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "registration_reviewers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registration_reviewers_userId_idx" ON "registration_reviewers"("userId");

-- AddForeignKey
ALTER TABLE "registration_reviewers"
  ADD CONSTRAINT "registration_reviewers_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "registration_reviewers"
  ADD CONSTRAINT "registration_reviewers_grantedByUserId_fkey"
  FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "registration_reviewers"
  ADD CONSTRAINT "registration_reviewers_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- C1-D1: one active assignment per user and department (revoked rows stay as history).
CREATE UNIQUE INDEX "uq_registration_reviewers_active"
  ON "registration_reviewers" ("userId", "departmentCode")
  WHERE "revokedAt" IS NULL;

ALTER TABLE "registration_reviewers"
  ADD CONSTRAINT "ck_registration_reviewers_department_code"
    CHECK ("departmentCode" ~ '^[A-Z0-9]{2,10}$'),
  ADD CONSTRAINT "ck_registration_reviewers_revocation_consistent"
    CHECK (("revokedAt" IS NULL) = ("revokedByUserId" IS NULL));
