-- CreateTable
CREATE TABLE "student_roster_imports" (
    "id" TEXT NOT NULL,
    "importedByUserId" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileSha256" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "insertedCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "conflictCount" INTEGER NOT NULL,
    "invalidCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL,

    CONSTRAINT "student_roster_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_roster_entries" (
    "id" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "studentName" TEXT,
    "rosterStatus" TEXT,
    "importId" TEXT NOT NULL,

    CONSTRAINT "student_roster_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_roster_imports_importedAt_idx" ON "student_roster_imports"("importedAt");

-- CreateIndex
CREATE UNIQUE INDEX "student_roster_entries_registrationNumber_key" ON "student_roster_entries"("registrationNumber");

-- CreateIndex
CREATE INDEX "student_roster_entries_departmentCode_idx" ON "student_roster_entries"("departmentCode");

-- AddForeignKey
ALTER TABLE "student_roster_imports" ADD CONSTRAINT "student_roster_imports_importedByUserId_fkey" FOREIGN KEY ("importedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "student_roster_entries" ADD CONSTRAINT "student_roster_entries_importId_fkey" FOREIGN KEY ("importId") REFERENCES "student_roster_imports"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- C1-D2: roster integrity. Counts must account for every data row.
ALTER TABLE "student_roster_entries"
  ADD CONSTRAINT "ck_roster_entries_number_normalized"
  CHECK ("registrationNumber" <> '' AND "registrationNumber" = upper(btrim("registrationNumber")));

ALTER TABLE "student_roster_imports"
  ADD CONSTRAINT "ck_roster_imports_counts"
  CHECK (
    "insertedCount" >= 0 AND "skippedCount" >= 0 AND "conflictCount" >= 0
    AND "invalidCount" >= 0 AND "duplicateCount" >= 0
    AND "rowCount" = "insertedCount" + "skippedCount" + "conflictCount" + "invalidCount" + "duplicateCount"
  );
