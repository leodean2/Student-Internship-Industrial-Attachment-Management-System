-- Structural verification (checks 1-9). Run against the database AFTER `prisma migrate dev` + constraints.sql.
-- Every row should read PASS. Expected values come from schema.prisma / constraints.sql / Decisions #71-73.
WITH checks(label, expected, actual) AS (VALUES
 ('1. base tables',                         32, (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE '\_%' AND table_name <> '_prisma_migrations')),
 ('5. ordinary unique indexes (non-pk)',    28, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE 'CREATE UNIQUE%' AND indexdef NOT LIKE '%WHERE%' AND indexname NOT LIKE '%pkey')),
 ('6. partial unique indexes',               4, (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE '%WHERE%')),
 ('7. CHECK constraints',                   23, (SELECT count(*) FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace)),
 ('4. FKs with ON DELETE CASCADE',           3, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confdeltype='c')),
 ('4. FKs with ON DELETE RESTRICT',         52, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confdeltype='r')),
 ('4. FKs with ON UPDATE <> NO ACTION',      0, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confupdtype<>'a')),
 ('8. singleton config rows',                1, (SELECT count(*) FROM reporting_schedule_config WHERE id=1)),
 ('9. SYSTEM user rows',                     1, (SELECT count(*) FROM users WHERE id='00000000-0000-0000-0000-000000000001' AND name='SYSTEM')),
 ('9. SYSTEM role rows (must be none)',      0, (SELECT count(*) FROM user_roles WHERE "userId"='00000000-0000-0000-0000-000000000001')),
 ('2. attachments.organizationSupervisorId NOT NULL', 1, (SELECT count(*) FROM information_schema.columns WHERE table_name='attachments' AND column_name='organizationSupervisorId' AND is_nullable='NO')),
 ('2. attachments.universitySupervisorId nullable',   1, (SELECT count(*) FROM information_schema.columns WHERE table_name='attachments' AND column_name='universitySupervisorId' AND is_nullable='YES')),
 ('3. claimedBySupervisorId -> organization_supervisor_profiles', 1, (SELECT count(*) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] WHERE contype='f' AND conrelid='attachment_applications'::regclass AND a.attname='claimedBySupervisorId' AND confrelid='organization_supervisor_profiles'::regclass)),
 ('10. refresh-token chains whose sessionExpiresAt differs between a token and its successor (must be 0, Decision #77)', 0, (SELECT count(*) FROM refresh_tokens a JOIN refresh_tokens b ON a."replacedById" = b.id WHERE a."sessionExpiresAt" <> b."sessionExpiresAt")),
 ('3. audit_logs has FK only on actorUserId',         1, (SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid='audit_logs'::regclass))
)
SELECT label, expected, actual, CASE WHEN expected=actual THEN 'PASS' ELSE 'FAIL' END AS result FROM checks;
-- The introspection round-trip is done outside SQL:  npx prisma db pull --print   then diff against schema.prisma
