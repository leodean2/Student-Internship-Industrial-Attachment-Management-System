-- Decision #88: user emails are stored lower-cased. Application requests already normalize them.
-- Preflight before applying: SELECT id, email FROM "users" WHERE "email" <> lower("email");
ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_email_lowercase" CHECK ("email" = lower("email"));
