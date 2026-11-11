-- Structural verification. Run against the database AFTER all migrations have been applied.
-- Every row should read PASS. Expected values come from schema.prisma / constraints.sql / Decisions #71-73 / Batch B (#83-#87).
--
-- CHECK constraint baseline (34 total after C1-D3):
--   23  from 20261014171000_constraints
--    1  ck_users_email_lowercase          (20261104090000, Decision #88)
--    3  ck_user_name_length, ck_supervisor_staff_id_length, ck_supervisor_title_length
--                                         (20261106090000, Batch B Decision #85)
--    2  ck_registration_reviewers_department_code, ck_registration_reviewers_revocation_consistent
--    2  ck_roster_entries_number_normalized, ck_roster_imports_counts
--    3  ck_student_profiles_confirmed_complete, ck_student_profiles_rejected_complete,
--       ck_student_profiles_pending_has_number
--   34  total
WITH checks(label, expected, actual) AS (VALUES
 ('1. base tables',                         35, (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE '\_%' AND table_name <> '_prisma_migrations')),
 ('5. ordinary unique indexes (non-pk)',    29, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE 'CREATE UNIQUE%' AND indexdef NOT LIKE '%WHERE%' AND indexname NOT LIKE '%pkey')),
 ('6. partial unique indexes',               5, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE '%WHERE%')),
 ('7. CHECK constraints',                   34, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace)),
 ('4. FKs with ON DELETE CASCADE',           3, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confdeltype='c')),
 ('4. FKs with ON DELETE RESTRICT',         58, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confdeltype='r')),
 ('4. FKs with ON UPDATE <> NO ACTION',      0, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confupdtype<>'a')),
 ('8. singleton config rows',                1, (SELECT count(*) FROM reporting_schedule_config WHERE id=1)),
 ('9. SYSTEM user rows',                     1, (SELECT count(*) FROM users WHERE id='00000000-0000-0000-0000-000000000001' AND name='SYSTEM')),
 ('9. SYSTEM role rows (must be none)',      0, (SELECT count(*) FROM user_roles WHERE "userId"='00000000-0000-0000-0000-000000000001')),
 ('2. attachments.organizationSupervisorId NOT NULL', 1, (SELECT count(*) FROM information_schema.columns WHERE table_name='attachments' AND column_name='organizationSupervisorId' AND is_nullable='NO')),
 ('2. attachments.universitySupervisorId nullable',   1, (SELECT count(*) FROM information_schema.columns WHERE table_name='attachments' AND column_name='universitySupervisorId' AND is_nullable='YES')),
 ('3. claimedBySupervisorId -> organization_supervisor_profiles', 1, (SELECT count(*) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] WHERE contype='f' AND conrelid='attachment_applications'::regclass AND a.attname='claimedBySupervisorId' AND confrelid='organization_supervisor_profiles'::regclass)),
 ('10. refresh-token chains whose sessionExpiresAt differs between a token and its successor (must be 0, Decision #77)', 0, (SELECT count(*) FROM refresh_tokens a JOIN refresh_tokens b ON a."replacedById" = b.id WHERE a."sessionExpiresAt" <> b."sessionExpiresAt")),
 ('3. audit_logs has FK only on actorUserId',         1, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid='audit_logs'::regclass)),
 -- Batch B structural checks (Decisions #83-#87)
 ('B1. invitations.createdAt column exists (NOT NULL)', 1, (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='invitations' AND column_name='createdAt' AND is_nullable='NO')),
 ('B2. invitations.acceptedAt column exists (nullable)', 1, (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='invitations' AND column_name='acceptedAt' AND is_nullable='YES')),
 ('B3. invitations.revokedAt column exists (nullable)',  1, (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='invitations' AND column_name='revokedAt'  AND is_nullable='YES')),
 ('B4. no stored status column on invitations',          0, (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='invitations' AND column_name='status')),
 ('B5. invitations.tokenHash unique index exists',       1, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='invitations' AND indexname='invitations_tokenHash_key')),
 ('B6. invitations.acceptedByUserId unique index exists',1, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='invitations' AND indexname='invitations_acceptedByUserId_key')),
 ('B7. invitations composite listing index exists',      1, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='invitations' AND indexname='invitations_createdAt_id_idx')),
 ('B8. ck_user_name_length constraint exists',           1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='users'::regclass AND conname='ck_user_name_length')),
 ('B9. ck_supervisor_staff_id_length constraint exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='university_supervisor_profiles'::regclass AND conname='ck_supervisor_staff_id_length')),
 ('B10. ck_supervisor_title_length constraint exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='university_supervisor_profiles'::regclass AND conname='ck_supervisor_title_length')),
 ('C1-D1. reviewer active unique index exists', 1, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='registration_reviewers' AND indexname='uq_registration_reviewers_active')),
 ('C1-D1. reviewer department code check exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='registration_reviewers'::regclass AND conname='ck_registration_reviewers_department_code')),
 ('C1-D1. reviewer revocation consistency check exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='registration_reviewers'::regclass AND conname='ck_registration_reviewers_revocation_consistent')),
 ('C1-D2. registration number unique index exists', 1, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='student_roster_entries' AND indexname='student_roster_entries_registrationNumber_key')),
 ('C1-D2. normalized number check exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='student_roster_entries'::regclass AND conname='ck_roster_entries_number_normalized')),
 ('C1-D2. import counts check exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='student_roster_imports'::regclass AND conname='ck_roster_imports_counts')),
 ('C1-D3. registration review index exists', 1, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='student_profiles' AND indexname='student_profiles_registrationStatus_registrationDepartmentC_idx')),
 ('C1-D3. decision reviewer FK is RESTRICT', 1, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid='student_profiles'::regclass AND conname='student_profiles_registrationDecidedByUserId_fkey' AND confdeltype='r')),
 ('C1-D3. confirmed registration check exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='student_profiles'::regclass AND conname='ck_student_profiles_confirmed_complete')),
 ('C1-D3. rejected registration check exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='student_profiles'::regclass AND conname='ck_student_profiles_rejected_complete')),
 ('C1-D3. pending registration check exists', 1, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND conrelid='student_profiles'::regclass AND conname='ck_student_profiles_pending_has_number'))
)
SELECT label, expected, actual, CASE WHEN expected=actual THEN 'PASS' ELSE 'FAIL' END AS result FROM checks;
-- The introspection round-trip is done outside SQL:  npx prisma db pull --print   then diff against schema.prisma
