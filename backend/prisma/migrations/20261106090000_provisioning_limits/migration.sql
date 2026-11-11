-- Batch B, Delivery 1: invitation lifecycle timestamps and provisioning length limits.
-- Run the preflight queries first; each must return zero before applying the CHECK constraints.
-- SELECT count(*) FROM "users" WHERE char_length("name") NOT BETWEEN 1 AND 100;
-- SELECT count(*) FROM "university_supervisor_profiles"
-- WHERE ("staffId" IS NOT NULL AND char_length("staffId") NOT BETWEEN 1 AND 64)
--    OR ("title" IS NOT NULL AND char_length("title") NOT BETWEEN 1 AND 100);

ALTER TABLE "invitations"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3);

ALTER TABLE "users"
  ADD CONSTRAINT "ck_user_name_length"
  CHECK (char_length("name") BETWEEN 1 AND 100);

ALTER TABLE "university_supervisor_profiles"
  ADD CONSTRAINT "ck_supervisor_staff_id_length"
  CHECK ("staffId" IS NULL OR char_length("staffId") BETWEEN 1 AND 64),
  ADD CONSTRAINT "ck_supervisor_title_length"
  CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 100);
