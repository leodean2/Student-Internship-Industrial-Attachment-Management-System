-- Run ONLY against a scratch database that already has the baseline migration + constraints.sql applied.
-- It inserts fixture rows (ids like 'u_student', 'A1') and leaves them behind.
\set ON_ERROR_STOP off
DROP TABLE IF EXISTS _results;
CREATE TABLE _results(n serial, name text, expected text, got text, pass boolean);

CREATE OR REPLACE FUNCTION t(name text, stmt text, expect text) RETURNS void AS $f$
DECLARE got text := 'ok';
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE;
  END;
  INSERT INTO _results(name, expected, got, pass) VALUES (name, expect, got, got = expect);
END $f$ LANGUAGE plpgsql;

-- ---------- fixture (all must succeed) ----------
SELECT t('fixture: users', $$INSERT INTO users(id,email,"passwordHash",name,"updatedAt") VALUES
 ('u_student','s@x.com','h','Student',now()),('u_student2','s2@x.com','h','Student2',now()),
 ('u_admin','a@x.com','h','Admin',now()),('u_usup','us@x.com','h','UniSup',now()),
 ('u_osup','os@x.com','h','OrgSup',now()),('u_osup2','os2@x.com','h','OrgSup2',now())$$,'ok');
SELECT t('fixture: profiles', $$
 INSERT INTO student_profiles(id,"userId","registrationNumber") VALUES ('s1','u_student','CIT-1'),('s2','u_student2','CIT-2');
 INSERT INTO university_supervisor_profiles(id,"userId") VALUES ('usp1','u_usup');
 INSERT INTO organizations(id,name,"proposedByUserId","updatedAt") VALUES ('org1','Acme','u_admin',now());
 INSERT INTO organization_supervisor_profiles(id,"userId","organizationId") VALUES ('osp1','u_osup','org1'),('osp2','u_osup2','org1')$$,'ok');
SELECT t('fixture: unresolved app s1', $$INSERT INTO attachment_applications(id,"studentId","organizationId","createdById","updatedAt") VALUES ('app1','s1','org1','u_student',now())$$,'ok');

-- ---------- applications ----------
SELECT t('#7 second unresolved app for same student rejected', $$INSERT INTO attachment_applications(id,"studentId","organizationId","createdById","updatedAt") VALUES ('app_dup','s1','org1','u_student',now())$$,'23505');
SELECT t('#7 resolved (ACCEPTED) apps do NOT count as unresolved', $$INSERT INTO attachment_applications(id,"studentId","organizationId",status,"createdById","reviewedById","reviewedAt","claimedBySupervisorId","claimedAt","updatedAt") VALUES
 ('app2','s1','org1','ACCEPTED','u_student','u_admin',now(),'osp1',now(),now()),
 ('app3','s1','org1','ACCEPTED','u_student','u_admin',now(),'osp1',now(),now()),
 ('app4','s2','org1','ACCEPTED','u_student2','u_admin',now(),'osp1',now(),now()),
 ('app5','s2','org1','ACCEPTED','u_student2','u_admin',now(),'osp1',now(),now())$$,'ok');
SELECT t('#72 REJECTED without rejectionReason rejected', $$INSERT INTO attachment_applications(id,"studentId","organizationId",status,"createdById","reviewedById","reviewedAt","updatedAt") VALUES ('x1','s2','org1','REJECTED','u_student2','u_admin',now(),now())$$,'23514');
SELECT t('#72 REJECTED with reason accepted', $$INSERT INTO attachment_applications(id,"studentId","organizationId",status,"createdById","reviewedById","reviewedAt","rejectionReason","updatedAt") VALUES ('app6','s2','org1','REJECTED','u_student2','u_admin',now(),'no fit',now())$$,'ok');
SELECT t('#72 DECLINED without declineReason rejected', $$INSERT INTO attachment_applications(id,"studentId","organizationId",status,"createdById","reviewedById","reviewedAt","claimedBySupervisorId","claimedAt","updatedAt") VALUES ('x2','s2','org1','DECLINED','u_student2','u_admin',now(),'osp1',now(),now())$$,'23514');
SELECT t('#72 reviewedById without reviewedAt rejected', $$INSERT INTO attachment_applications(id,"studentId","organizationId",status,"createdById","reviewedById","updatedAt") VALUES ('x3','s2','org1','ACCEPTED','u_student2','u_admin',now())$$,'23514');
SELECT t('#72 claimedBySupervisorId without claimedAt rejected', $$INSERT INTO attachment_applications(id,"studentId","organizationId",status,"createdById","claimedBySupervisorId","updatedAt") VALUES ('x4','s2','org1','ACCEPTED','u_student2','osp1',now())$$,'23514');

-- ---------- attachments ----------
SELECT t('attachment A1 ACTIVE for s1 (with university supervisor)', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId","universitySupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('A1','app2','s1','org1','osp1','usp1','ACTIVE','2026-06-01','2026-08-31',7,now())$$,'ok');
SELECT t('#1 second ACTIVE attachment for same student rejected', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId","universitySupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('A_dup','app3','s1','org1','osp1','usp1','ACTIVE','2026-06-01','2026-08-31',7,now())$$,'23505');
SELECT t('#1 non-ACTIVE (CONFIRMED) second attachment for same student allowed', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('A2','app3','s1','org1','osp1','CONFIRMED','2027-06-01','2027-08-31',7,now())$$,'ok');
SELECT t('#36/#72 AMENDMENT: ACTIVE with NULL universitySupervisorId is NOT blocked by the DB (service-layer rule)', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('A3','app4','s2','org1','osp1','ACTIVE','2026-06-01','2026-08-31',7,now())$$,'ok');
SELECT t('#72 endDate < startDate rejected', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('x5','app5','s2','org1','osp1','CONFIRMED','2026-09-01','2026-08-01',7,now())$$,'23514');
SELECT t('#72 outcome while CONFIRMED rejected', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,outcome,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('x6','app5','s2','org1','osp1','CONFIRMED','SATISFACTORY','2026-06-01','2026-08-31',7,now())$$,'23514');
SELECT t('#72 reportingPeriodLengthDays = 0 rejected', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('x7','app5','s2','org1','osp1','CONFIRMED','2026-06-01','2026-08-31',0,now())$$,'23514');
SELECT t('#9/#64 organizationSupervisorId NULL rejected (required)', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('x8','app5','s2','org1','CONFIRMED','2026-06-01','2026-08-31',7,now())$$,'23502');
SELECT t('#59 two attachments for one application rejected', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","updatedAt") VALUES ('x9','app2','s2','org1','osp1','CONFIRMED','2026-06-01','2026-08-31',7,now())$$,'23505');
SELECT t('#5/#71 first successor via previousAttachmentId allowed', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","previousAttachmentId","updatedAt") VALUES ('A4','app5','s2','org1','osp1','CONFIRMED','2027-01-01','2027-03-31',7,'A3',now())$$,'ok');
SELECT t('#71 second attachment claiming same predecessor rejected (linear chain)', $$INSERT INTO attachments(id,"applicationId","studentId","organizationId","organizationSupervisorId",status,"startDate","endDate","reportingPeriodLengthDays","previousAttachmentId","updatedAt") VALUES ('x10','app6','s2','org1','osp1','CONFIRMED','2027-01-01','2027-03-31',7,'A3',now())$$,'23505');

-- ---------- termination ----------
SELECT t('termination category', $$INSERT INTO termination_reason_categories(id,code,name) VALUES ('trc1','MISCONDUCT','Misconduct')$$,'ok');
SELECT t('termination record', $$INSERT INTO termination_records(id,"attachmentId","reasonCategoryId","initiatedByUserId","initiatedByType","reasonDescription") VALUES ('tr1','A3','trc1','u_admin','UNIVERSITY','x')$$,'ok');
SELECT t('#64 second termination record for same attachment rejected', $$INSERT INTO termination_records(id,"attachmentId","reasonCategoryId","initiatedByUserId","initiatedByType","reasonDescription") VALUES ('tr2','A3','trc1','u_admin','UNIVERSITY','x')$$,'23505');
SELECT t('#72 clearanceGrantedAt without admin rejected', $$UPDATE termination_records SET "clearanceGrantedAt"=now() WHERE id='tr1'$$,'23514');
SELECT t('#72 clearance both set accepted', $$UPDATE termination_records SET "clearanceGrantedAt"=now(),"clearanceGrantedByAdminId"='u_admin' WHERE id='tr1'$$,'ok');

-- ---------- weekly logs ----------
SELECT t('weekly log period 1', $$INSERT INTO weekly_logs(id,"attachmentId","periodNumber",activities,"updatedAt") VALUES ('wl1','A1',1,'did things',now())$$,'ok');
SELECT t('#61 duplicate (attachmentId, periodNumber) rejected', $$INSERT INTO weekly_logs(id,"attachmentId","periodNumber",activities,"updatedAt") VALUES ('wl_dup','A1',1,'again',now())$$,'23505');
SELECT t('#72 periodNumber = 0 rejected', $$INSERT INTO weekly_logs(id,"attachmentId","periodNumber",activities,"updatedAt") VALUES ('x11','A1',0,'a',now())$$,'23514');
SELECT t('#19 NEEDS_REVISION without comment rejected', $$INSERT INTO weekly_logs(id,"attachmentId","periodNumber",activities,status,"updatedAt") VALUES ('x12','A1',2,'a','NEEDS_REVISION',now())$$,'23514');
SELECT t('#19 NEEDS_REVISION with comment accepted', $$INSERT INTO weekly_logs(id,"attachmentId","periodNumber",activities,status,"revisionComment","updatedAt") VALUES ('wl2','A1',2,'a','NEEDS_REVISION','be specific',now())$$,'ok');
SELECT t('#72 orgVerifiedAt without orgVerifiedBy rejected', $$UPDATE weekly_logs SET "orgVerifiedAt"=now() WHERE id='wl1'$$,'23514');
SELECT t('#65 reviewedById may reference any User (historical attribution)', $$UPDATE weekly_logs SET "reviewedById"='u_usup' WHERE id='wl1'$$,'ok');

-- ---------- evaluations ----------
SELECT t('criteria', $$INSERT INTO evaluation_criteria(id,name,weight) VALUES ('c1','Technical Skills',60),('c2','Technical Skills',40)$$,'ok'); -- also proves name is NOT unique (#71 amendment)
SELECT t('#72 criterion weight 0 rejected', $$INSERT INTO evaluation_criteria(id,name,weight) VALUES ('cx','Z',0)$$,'23514');
SELECT t('#72 criterion weight 101 rejected', $$INSERT INTO evaluation_criteria(id,name,weight) VALUES ('cy','Z',101)$$,'23514');
SELECT t('industry evaluation', $$INSERT INTO industry_evaluations(id,"attachmentId","submittedByUserId","updatedAt") VALUES ('ie1','A1','u_osup',now())$$,'ok');
SELECT t('#27 second industry evaluation for same attachment rejected', $$INSERT INTO industry_evaluations(id,"attachmentId","submittedByUserId","updatedAt") VALUES ('ie2','A1','u_osup',now())$$,'23505');
SELECT t('industry rating 100 ok', $$INSERT INTO industry_evaluation_ratings(id,"industryEvaluationId","criterionId",rating) VALUES ('ir1','ie1','c1',100)$$,'ok');
SELECT t('#72 industry rating 101 rejected', $$INSERT INTO industry_evaluation_ratings(id,"industryEvaluationId","criterionId",rating) VALUES ('ir2','ie1','c2',101)$$,'23514');
SELECT t('#72 industry rating -1 rejected', $$INSERT INTO industry_evaluation_ratings(id,"industryEvaluationId","criterionId",rating) VALUES ('ir3','ie1','c2',-1)$$,'23514');
SELECT t('#67 duplicate rating per criterion rejected', $$INSERT INTO industry_evaluation_ratings(id,"industryEvaluationId","criterionId",rating) VALUES ('ir4','ie1','c1',50)$$,'23505');
SELECT t('industry evaluation version', $$INSERT INTO industry_evaluation_versions(id,"industryEvaluationId","versionNumber",snapshot) VALUES ('iev1','ie1',1,'{}')$$,'ok');
SELECT t('final evaluation FE1 (current)', $$INSERT INTO final_evaluations(id,"attachmentId","universitySupervisorId","industryEvaluationVersionIdUsed","updatedAt") VALUES ('fe1','A1','u_usup','iev1',now())$$,'ok');
SELECT t('#67 second CURRENT final evaluation for same attachment rejected', $$INSERT INTO final_evaluations(id,"attachmentId","universitySupervisorId","updatedAt") VALUES ('fe_dup','A1','u_usup',now())$$,'23505');
SELECT t('#33/#67 reopen: supersede FE1, then new current FE2 allowed (1:N)', $$UPDATE final_evaluations SET "supersededAt"=now() WHERE id='fe1'; INSERT INTO final_evaluations(id,"attachmentId","universitySupervisorId","updatedAt") VALUES ('fe2','A1','u_usup',now())$$,'ok');
SELECT t('#71 two evaluations superseded by the same successor rejected', $$UPDATE final_evaluations SET "supersededByFinalEvaluationId"='fe2' WHERE id='fe1'; INSERT INTO final_evaluations(id,"attachmentId","universitySupervisorId","supersededAt","supersededByFinalEvaluationId","updatedAt") VALUES ('fe0','A3','u_usup',now(),'fe2',now())$$,'23505');
SELECT t('#72 overallScore 101 rejected', $$UPDATE final_evaluations SET "overallScore"=101 WHERE id='fe2'$$,'23514');
SELECT t('#72 overallScore 87.5 accepted', $$UPDATE final_evaluations SET "overallScore"=87.5 WHERE id='fe2'$$,'ok');
SELECT t('#72 final rating 101 rejected', $$INSERT INTO final_evaluation_ratings(id,"finalEvaluationId","criterionId",rating) VALUES ('fr1','fe2','c1',101)$$,'23514');

-- ---------- documents ----------
SELECT t('doc type', $$INSERT INTO document_type_configs(id,category,code,name) VALUES ('dt1','APPLICATION_SUPPORTING','CV','CV'),('dt2','ATTACHMENT_PERIOD','CV','CV (period)')$$,'ok'); -- same code, different category => allowed (#71)
SELECT t('#71 duplicate (category, code) rejected', $$INSERT INTO document_type_configs(id,category,code,name) VALUES ('dt3','APPLICATION_SUPPORTING','CV','dup')$$,'23505');
SELECT t('#68 document with application parent only', $$INSERT INTO documents(id,"attachmentApplicationId","documentTypeId") VALUES ('d1','app1','dt1')$$,'ok');
SELECT t('#68 document with attachment parent only', $$INSERT INTO documents(id,"attachmentId","documentTypeId") VALUES ('d2','A1','dt2')$$,'ok');
SELECT t('#68 document with BOTH parents rejected', $$INSERT INTO documents(id,"attachmentApplicationId","attachmentId","documentTypeId") VALUES ('x13','app1','A1','dt1')$$,'23514');
SELECT t('#68 document with NEITHER parent rejected', $$INSERT INTO documents(id,"documentTypeId") VALUES ('x14','dt1')$$,'23514');
SELECT t('#68 document without documentTypeId rejected (required FK)', $$INSERT INTO documents(id,"attachmentId") VALUES ('x15','A1')$$,'23502');
SELECT t('document version v1 current', $$INSERT INTO document_versions(id,"documentId","versionNumber","storageKey","originalFilename","mimeType","sizeBytes",sha256,"uploadedByUserId","isCurrent") VALUES ('dv1','d1',1,'key-1','a.pdf','application/pdf',100,'abc','u_student',true)$$,'ok');
SELECT t('#68 second CURRENT version of same document rejected', $$INSERT INTO document_versions(id,"documentId","versionNumber","storageKey","originalFilename","mimeType","sizeBytes",sha256,"uploadedByUserId","isCurrent") VALUES ('dv2','d1',2,'key-2','a.pdf','application/pdf',100,'abc','u_student',true)$$,'23505');
SELECT t('#68 supersede: v1 -> not current, v2 current allowed', $$UPDATE document_versions SET "isCurrent"=false WHERE id='dv1'; INSERT INTO document_versions(id,"documentId","versionNumber","storageKey","originalFilename","mimeType","sizeBytes",sha256,"uploadedByUserId","isCurrent") VALUES ('dv2','d1',2,'key-2','a.pdf','application/pdf',100,'abc','u_student',true)$$,'ok');
SELECT t('#71 duplicate storageKey rejected', $$INSERT INTO document_versions(id,"documentId","versionNumber","storageKey","originalFilename","mimeType","sizeBytes",sha256,"uploadedByUserId","isCurrent") VALUES ('dv3','d2',1,'key-1','a.pdf','application/pdf',100,'abc','u_student',false)$$,'23505');
SELECT t('#71 duplicate (documentId, versionNumber) rejected', $$INSERT INTO document_versions(id,"documentId","versionNumber","storageKey","originalFilename","mimeType","sizeBytes",sha256,"uploadedByUserId","isCurrent") VALUES ('dv4','d1',2,'key-4','a.pdf','application/pdf',100,'abc','u_student',false)$$,'23505');
SELECT t('#72 sizeBytes = 0 rejected', $$INSERT INTO document_versions(id,"documentId","versionNumber","storageKey","originalFilename","mimeType","sizeBytes",sha256,"uploadedByUserId","isCurrent") VALUES ('dv5','d2',1,'key-5','a.pdf','application/pdf',0,'abc','u_student',false)$$,'23514');

-- ---------- identity ----------
SELECT t('#71 duplicate OrganizationSupervisorProfile (user, org) rejected', $$INSERT INTO organization_supervisor_profiles(id,"userId","organizationId") VALUES ('osp_dup','u_osup','org1')$$,'23505');
SELECT t('#71 duplicate registrationNumber rejected', $$INSERT INTO student_profiles(id,"userId","registrationNumber") VALUES ('s_dup','u_admin','CIT-1')$$,'23505');
SELECT t('#71 duplicate email rejected', $$INSERT INTO users(id,email,"passwordHash",name,"updatedAt") VALUES ('u_dup','s@x.com','h','Dup',now())$$,'23505');
SELECT t('#62/#72 invitation ORG_SUPERVISOR without organization rejected', $$INSERT INTO invitations(id,email,role,"invitedByUserId","tokenHash","expiresAt") VALUES ('i1','n@x.com','ORGANIZATION_SUPERVISOR','u_admin','t1',now())$$,'23514');
SELECT t('#62/#72 invitation STUDENT-role WITH organization rejected', $$INSERT INTO invitations(id,email,role,"organizationId","invitedByUserId","tokenHash","expiresAt") VALUES ('i2','n@x.com','UNIVERSITY_SUPERVISOR','org1','u_admin','t2',now())$$,'23514');
SELECT t('#62/#72 invitation ORG_SUPERVISOR with organization accepted', $$INSERT INTO invitations(id,email,role,"organizationId","invitedByUserId","tokenHash","expiresAt") VALUES ('i3','n@x.com','ORGANIZATION_SUPERVISOR','org1','u_admin','t3',now())$$,'ok');
SELECT t('#62/#72 invitation UNIVERSITY_SUPERVISOR without organization accepted', $$INSERT INTO invitations(id,email,role,"invitedByUserId","tokenHash","expiresAt") VALUES ('i4','n2@x.com','UNIVERSITY_SUPERVISOR','u_admin','t4',now())$$,'ok');
SELECT t('#71 acceptedByUserId reused across invitations rejected', $$UPDATE invitations SET "acceptedByUserId"='u_student' WHERE id='i3'; UPDATE invitations SET "acceptedByUserId"='u_student' WHERE id='i4'$$,'23505');
SELECT t('#70/#71 refresh token rotation: same replacement twice rejected', $$INSERT INTO refresh_tokens(id,"userId","tokenHash","expiresAt","sessionExpiresAt") VALUES ('rt1','u_student','h1',now(),now()),('rt2','u_student','h2',now(),now()),('rt3','u_student','h3',now(),now()); UPDATE refresh_tokens SET "replacedById"='rt3' WHERE id='rt1'; UPDATE refresh_tokens SET "replacedById"='rt3' WHERE id='rt2'$$,'23505');

-- ---------- refresh-token integrity (#75, #77) ----------
SELECT t('#75 duplicate refresh-token hash rejected', $$INSERT INTO refresh_tokens(id,"userId","tokenHash","expiresAt","sessionExpiresAt") VALUES ('rt_d1','u_student','dup-hash',now(),now()),('rt_d2','u_student','dup-hash',now(),now())$$,'23505');
SELECT t('#77 token that outlives its session deadline rejected (CHECK)', $$INSERT INTO refresh_tokens(id,"userId","tokenHash","expiresAt","sessionExpiresAt") VALUES ('rt_c1','u_student','cap-1', now() + interval '10 days', now() + interval '5 days')$$,'23514');
SELECT t('#77 token expiring exactly at the session deadline accepted', $$INSERT INTO refresh_tokens(id,"userId","tokenHash","expiresAt","sessionExpiresAt") VALUES ('rt_c2','u_student','cap-2', now() + interval '5 days', now() + interval '5 days')$$,'ok');
SELECT t('#77 token expiring before the session deadline accepted', $$INSERT INTO refresh_tokens(id,"userId","tokenHash","expiresAt","sessionExpiresAt") VALUES ('rt_c3','u_student','cap-3', now() + interval '1 day', now() + interval '5 days')$$,'ok');
SELECT t('#77 sessionExpiresAt is required', $$INSERT INTO refresh_tokens(id,"userId","tokenHash","expiresAt") VALUES ('rt_c4','u_student','cap-4', now())$$,'23502');

-- ---------- outbox / audit / config ----------
SELECT t('outbox ok', $$INSERT INTO email_outbox(id,"toEmail","templateType",payload,"idempotencyKey") VALUES ('eo1','a@b.com','verify','{}','k1')$$,'ok');
SELECT t('#71 duplicate idempotencyKey rejected', $$INSERT INTO email_outbox(id,"toEmail","templateType",payload,"idempotencyKey") VALUES ('eo2','a@b.com','verify','{}','k1')$$,'23505');
SELECT t('#71 NULL idempotencyKey rejected (required)', $$INSERT INTO email_outbox(id,"toEmail","templateType",payload) VALUES ('eo3','a@b.com','verify','{}')$$,'23502');
SELECT t('#72 attempts = -1 rejected', $$INSERT INTO email_outbox(id,"toEmail","templateType",payload,"idempotencyKey",attempts) VALUES ('eo4','a@b.com','verify','{}','k4',-1)$$,'23514');
SELECT t('#72 status SENT without sentAt rejected', $$INSERT INTO email_outbox(id,"toEmail","templateType",payload,"idempotencyKey",status) VALUES ('eo5','a@b.com','verify','{}','k5','SENT')$$,'23514');
SELECT t('#69 audit log with arbitrary targetType/targetId (no FK) accepted', $$INSERT INTO audit_logs(id,"actorUserId",action,"targetType","targetId") VALUES ('al1','00000000-0000-0000-0000-000000000001','ATTACHMENT_ACTIVATED','Attachment','id-that-does-not-exist')$$,'ok');
SELECT t('#69 audit log with NULL actor rejected', $$INSERT INTO audit_logs(id,action,"targetType","targetId") VALUES ('al2','X','Attachment','1')$$,'23502');
SELECT t('#61/#72 singleton: second config row (id=2) rejected', $$INSERT INTO reporting_schedule_config(id,"periodLengthDays","updatedAt") VALUES (2,14,now())$$,'23514');
SELECT t('#61/#72 singleton: duplicate id=1 rejected', $$INSERT INTO reporting_schedule_config(id,"periodLengthDays","updatedAt") VALUES (1,14,now())$$,'23505');

-- ---------- referential actions (#73) ----------
-- PostgreSQL reports SQLSTATE 23001 for RESTRICT; NO ACTION reports 23503.
SELECT t('#73 RESTRICT: deleting a User that owns a StudentProfile fails', $$DELETE FROM users WHERE id='u_student'$$,'23001');
SELECT t('#73 RESTRICT: deleting an Attachment that has weekly logs fails', $$DELETE FROM attachments WHERE id='A1'$$,'23001');
SELECT t('#73 RESTRICT: deleting a Document with versions fails', $$DELETE FROM documents WHERE id='d1'$$,'23001');
SELECT t('#73 fixture: user with only tokens', $$INSERT INTO users(id,email,"passwordHash",name,"updatedAt") VALUES ('u_tok','tok@x.com','h','Tok',now()); INSERT INTO refresh_tokens(id,"userId","tokenHash","expiresAt","sessionExpiresAt") VALUES ('rt_t','u_tok','ht',now(),now()); INSERT INTO password_reset_tokens(id,"userId","tokenHash","expiresAt") VALUES ('prt_t','u_tok','hp',now()); INSERT INTO email_verification_tokens(id,"userId","tokenHash","expiresAt") VALUES ('evt_t','u_tok','hv',now())$$,'ok');
SELECT t('#73 CASCADE: deleting that User succeeds', $$DELETE FROM users WHERE id='u_tok'$$,'ok');
SELECT t('#73 CASCADE: its 3 token rows are gone', $$SELECT 1/(CASE WHEN (SELECT count(*) FROM refresh_tokens WHERE id='rt_t')+(SELECT count(*) FROM password_reset_tokens WHERE id='prt_t')+(SELECT count(*) FROM email_verification_tokens WHERE id='evt_t')=0 THEN 1 ELSE 0 END)$$,'ok');

\echo
SELECT count(*) AS total, count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM _results;
\echo '--- FAILURES (if any) ---'
SELECT n, name, 'expected '||expected||' got '||got AS detail FROM _results WHERE NOT pass ORDER BY n;
