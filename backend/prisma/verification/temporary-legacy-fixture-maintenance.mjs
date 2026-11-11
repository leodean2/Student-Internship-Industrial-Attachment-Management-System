import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";
import { spawnSync } from "node:child_process";

const connectionString = process.env.verify_database_url ?? process.env.VERIFY_DATABASE_URL;
if (!connectionString) throw new Error("verify_database_url is not configured");

const target = new URL(connectionString);
if (
  target.hostname !== "ep-mute-shape-b4nqm7fb.c-6.us-east-2.aws.neon.tech" ||
  target.pathname !== "/test_db"
) {
  throw new Error("Refusing to operate: the configured target is not the confirmed test_db database.");
}

const mode = process.argv[2];
if (mode === "status" || mode === "deploy") {
  const result = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", mode === "status" ? "status" : "deploy"],
    {
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        DATABASE_URL_UNPOOLED: connectionString,
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (mode === "integration") {
  const result = spawnSync(
    "npm",
    [
      "run",
      "test:integration",
      "--",
      "tests/integration/student-profile-registration.integration.test.ts",
      "tests/integration/registration-review.integration.test.ts",
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: connectionString,
        RUN_EMAIL_OUTBOX_INTEGRATION: "true",
        OUTBOX_TEST_DB_DISPOSABLE: "true",
      },
      shell: true,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (mode === "verify") {
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    const structureSql = readFileSync("prisma/verification/verify-structure.sql", "utf8");
    const { rows: checks } = await client.query(structureSql);
    const failures = checks.filter(({ result }) => result !== "PASS");
    const checkConstraint = checks.find(({ label }) => label === "7. CHECK constraints");
    console.log(JSON.stringify({ structural_checks: checks.length, failures, checkConstraint }, null, 2));
    if (failures.length > 0 || Number(checkConstraint?.actual) !== 34) {
      throw new Error("Structural verification did not meet the expected checks.");
    }

    const invariant = await client.query(`
      SELECT u.id
      FROM users u
      JOIN user_roles r ON r."userId" = u.id AND r.role = 'STUDENT'
      LEFT JOIN student_profiles p ON p."userId" = u.id
      WHERE u.status = 'ACTIVE'
        AND (u."emailVerifiedAt" IS NULL OR p."registrationStatus" IS DISTINCT FROM 'CONFIRMED')
    `);
    console.log(JSON.stringify({ active_student_invariant_violations: invariant.rows }, null, 2));
    if (invariant.rowCount !== 0) throw new Error("Active-student invariant violations were found.");
  } finally {
    client.release();
    await pool.end();
  }

  const diff = spawnSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "diff",
      "--from-url",
      connectionString,
      "--to-schema-datamodel",
      "prisma/schema.prisma",
      "--exit-code",
    ],
    { stdio: "inherit" },
  );
  if (diff.error) throw diff.error;
  if (diff.status !== 0) throw new Error(`Prisma schema drift check failed with exit code ${diff.status}.`);
} else if (mode === "rehearse" || mode === "commit") {
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  const deleted = {};

  const remove = async (label, sql, values = []) => {
    const result = await client.query(sql, values);
    deleted[label] = result.rowCount;
    return result.rows;
  };
  const expectOnly = (label, actualIds, expectedIds) => {
    const actual = [...actualIds].sort();
    const expected = [...expectedIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label} did not match the known verification fixtures: ${JSON.stringify(actual)}`);
    }
  };

  try {
    await client.query("BEGIN");
    const { rows: profiles } = await client.query(`
      SELECT id, "registrationNumber", "userId"
      FROM student_profiles
      WHERE "registrationNumber" IN ('CIT-1', 'CIT-2')
      ORDER BY id
      FOR UPDATE
    `);
    expectOnly("legacy profiles", profiles.map(({ id }) => id), ["s1", "s2"]);
    expectOnly(
      "legacy registration numbers",
      profiles.map(({ registrationNumber }) => registrationNumber),
      ["CIT-1", "CIT-2"],
    );
    expectOnly("legacy users", profiles.map(({ userId }) => userId), ["u_student", "u_student2"]);
    const profileIds = profiles.map(({ id }) => id);
    const userIds = profiles.map(({ userId }) => userId);

    const { rows: applications } = await client.query(
      `SELECT id, "studentId", "createdById" FROM attachment_applications
       WHERE "studentId" = ANY($1::text[]) OR "createdById" = ANY($2::text[])`,
      [profileIds, userIds],
    );
    expectOnly(
      "application fixture ids",
      applications.map(({ id }) => id),
      ["app1", "app2", "app3", "app4", "app5", "app6"],
    );
    if (applications.some(({ studentId }) => !profileIds.includes(studentId))) {
      throw new Error("A target user's application belongs to a different student; refusing cleanup.");
    }
    const applicationIds = applications.map(({ id }) => id);

    const { rows: attachments } = await client.query(
      `SELECT id, "studentId", "applicationId", "previousAttachmentId" FROM attachments
       WHERE "studentId" = ANY($1::text[]) OR "applicationId" = ANY($2::text[])`,
      [profileIds, applicationIds],
    );
    expectOnly("attachment fixture ids", attachments.map(({ id }) => id), ["A1", "A2", "A3", "A4"]);
    if (attachments.some(({ studentId }) => !profileIds.includes(studentId))) {
      throw new Error("An attachment associated with the fixture set belongs to a different student.");
    }
    const attachmentIds = attachments.map(({ id }) => id);

    const { rows: documents } = await client.query(
      `SELECT id FROM documents
       WHERE "attachmentApplicationId" = ANY($1::text[]) OR "attachmentId" = ANY($2::text[])`,
      [applicationIds, attachmentIds],
    );
    expectOnly("document fixture ids", documents.map(({ id }) => id), ["d1", "d2"]);
    const documentIds = documents.map(({ id }) => id);

    const { rows: documentVersions } = await client.query(
      `SELECT id, "documentId" FROM document_versions
       WHERE "documentId" = ANY($1::text[]) OR "uploadedByUserId" = ANY($2::text[])`,
      [documentIds, userIds],
    );
    expectOnly("document-version fixture ids", documentVersions.map(({ id }) => id), ["dv1", "dv2"]);
    if (documentVersions.some(({ documentId }) => !documentIds.includes(documentId))) {
      throw new Error("A target student's document version belongs to a different document.");
    }

    const { rows: finalEvaluations } = await client.query(
      `SELECT id, "supersededByFinalEvaluationId" FROM final_evaluations
       WHERE "attachmentId" = ANY($1::text[])`,
      [attachmentIds],
    );
    expectOnly("final-evaluation fixture ids", finalEvaluations.map(({ id }) => id), ["fe1", "fe2"]);
    const finalEvaluationIds = finalEvaluations.map(({ id }) => id);

    const { rows: industryEvaluations } = await client.query(
      `SELECT id FROM industry_evaluations WHERE "attachmentId" = ANY($1::text[])`,
      [attachmentIds],
    );
    expectOnly("industry-evaluation fixture ids", industryEvaluations.map(({ id }) => id), ["ie1"]);
    const industryEvaluationIds = industryEvaluations.map(({ id }) => id);

    const { rows: weeklyLogs } = await client.query(
      `SELECT id FROM weekly_logs WHERE "attachmentId" = ANY($1::text[])`,
      [attachmentIds],
    );
    expectOnly("weekly-log fixture ids", weeklyLogs.map(({ id }) => id), ["wl1", "wl2"]);
    const weeklyLogIds = weeklyLogs.map(({ id }) => id);

    const auditRows = await client.query(
      `SELECT id FROM audit_logs
       WHERE "actorUserId" = ANY($1::text[])
          OR ("targetType" = 'StudentProfile' AND "targetId" = ANY($2::text[]))
          OR ("targetType" = 'User' AND "targetId" = ANY($1::text[]))`,
      [userIds, profileIds],
    );
    if (auditRows.rowCount !== 0) throw new Error("Audit references exist; refusing to remove them.");

    await remove(
      "final_evaluation_ratings",
      `DELETE FROM final_evaluation_ratings WHERE "finalEvaluationId" = ANY($1::text[])`,
      [finalEvaluationIds],
    );
    await remove(
      "final_evaluations_superseded",
      `DELETE FROM final_evaluations
       WHERE id = ANY($1::text[]) AND "supersededByFinalEvaluationId" IS NOT NULL`,
      [finalEvaluationIds],
    );
    await remove(
      "final_evaluations",
      `DELETE FROM final_evaluations WHERE "attachmentId" = ANY($1::text[])`,
      [attachmentIds],
    );
    await remove(
      "industry_evaluation_ratings",
      `DELETE FROM industry_evaluation_ratings WHERE "industryEvaluationId" = ANY($1::text[])`,
      [industryEvaluationIds],
    );
    await remove(
      "industry_evaluation_versions",
      `DELETE FROM industry_evaluation_versions WHERE "industryEvaluationId" = ANY($1::text[])`,
      [industryEvaluationIds],
    );
    await remove(
      "industry_evaluations",
      `DELETE FROM industry_evaluations WHERE id = ANY($1::text[])`,
      [industryEvaluationIds],
    );
    await remove(
      "weekly_log_versions",
      `DELETE FROM weekly_log_versions WHERE "weeklyLogId" = ANY($1::text[])`,
      [weeklyLogIds],
    );
    await remove("weekly_logs", `DELETE FROM weekly_logs WHERE id = ANY($1::text[])`, [weeklyLogIds]);
    await remove(
      "supervision_visits",
      `DELETE FROM supervision_visits WHERE "attachmentId" = ANY($1::text[])`,
      [attachmentIds],
    );
    await remove(
      "termination_records",
      `DELETE FROM termination_records WHERE "attachmentId" = ANY($1::text[])`,
      [attachmentIds],
    );
    await remove(
      "document_versions",
      `DELETE FROM document_versions WHERE id = ANY($1::text[])`,
      [documentVersions.map(({ id }) => id)],
    );
    await remove("documents", `DELETE FROM documents WHERE id = ANY($1::text[])`, [documentIds]);

    const remainingPreviousLinks = await client.query(
      `SELECT id FROM attachments
       WHERE "previousAttachmentId" = ANY($1::text[])
         AND id <> ALL($1::text[])`,
      [attachmentIds],
    );
    if (remainingPreviousLinks.rowCount !== 0) {
      throw new Error("An attachment outside the fixture set points to a fixture attachment; refusing cleanup.");
    }
    await remove(
      "attachments_with_predecessor",
      `DELETE FROM attachments WHERE id = ANY($1::text[]) AND "previousAttachmentId" IS NOT NULL`,
      [attachmentIds],
    );
    await remove("attachments", `DELETE FROM attachments WHERE id = ANY($1::text[])`, [attachmentIds]);
    await remove(
      "attachment_applications",
      `DELETE FROM attachment_applications WHERE id = ANY($1::text[])`,
      [applicationIds],
    );
    await remove("user_roles", `DELETE FROM user_roles WHERE "userId" = ANY($1::text[])`, [userIds]);
    const { rows: refreshTokens } = await client.query(
      `SELECT id, "replacedById" FROM refresh_tokens WHERE "userId" = ANY($1::text[])`,
      [userIds],
    );
    const remainingTokens = new Map(refreshTokens.map((token) => [token.id, token.replacedById]));
    while (remainingTokens.size > 0) {
      const leaf = [...remainingTokens.entries()].find(
        ([id]) => ![...remainingTokens.values()].includes(id),
      );
      if (!leaf) throw new Error("Refresh-token references form a cycle; refusing cleanup.");
      const [id] = leaf;
      await remove(`refresh_token_${id}`, `DELETE FROM refresh_tokens WHERE id = $1`, [id]);
      remainingTokens.delete(id);
    }
    await remove("password_reset_tokens", `DELETE FROM password_reset_tokens WHERE "userId" = ANY($1::text[])`, [
      userIds,
    ]);
    await remove(
      "email_verification_tokens",
      `DELETE FROM email_verification_tokens WHERE "userId" = ANY($1::text[])`,
      [userIds],
    );
    await remove(
      "invitations",
      `DELETE FROM invitations WHERE "acceptedByUserId" = ANY($1::text[]) OR "invitedByUserId" = ANY($1::text[])`,
      [userIds],
    );
    await remove("email_outbox", `DELETE FROM email_outbox WHERE "relatedUserId" = ANY($1::text[])`, [userIds]);
    await remove("notifications", `DELETE FROM notifications WHERE "recipientUserId" = ANY($1::text[])`, [userIds]);
    await remove("student_profiles", `DELETE FROM student_profiles WHERE id = ANY($1::text[])`, [profileIds]);
    await remove("users", `DELETE FROM users WHERE id = ANY($1::text[])`, [userIds]);

    const leftovers = await client.query(`
      SELECT count(*)::int AS count FROM student_profiles
      WHERE "registrationNumber" IN ('CIT-1', 'CIT-2')
    `);
    if (leftovers.rows[0].count !== 0) throw new Error("Legacy student profiles remain after fixture cleanup.");

    if (mode === "commit") {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    console.log(JSON.stringify({ mode, profiles: profileIds, users: userIds, deleted }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
} else {
  throw new Error("Use one of: status, rehearse, commit, deploy, integration, verify.");
}
