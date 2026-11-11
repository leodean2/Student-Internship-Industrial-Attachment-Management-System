/**
 * One-off cleanup: removes orphaned session-integration-test fixture users from test_db.
 * These rows were left behind by an interrupted test run. Safe to delete: they have no
 * student_profiles rows, no audit rows, and are not referenced by any FK from outside the
 * session test fixture set.
 */
import "dotenv/config";
import pg from "pg";

const connectionString = process.env.verify_database_url ?? process.env.VERIFY_DATABASE_URL;
if (!connectionString) throw new Error("verify_database_url is not configured");

const target = new URL(connectionString);
if (
  target.hostname !== "ep-mute-shape-b4nqm7fb.c-6.us-east-2.aws.neon.tech" ||
  target.pathname !== "/test_db"
) {
  throw new Error("Refusing to operate: target is not the confirmed test_db database.");
}

const IDS = [
  "st-6a64aa81-a", "st-6a64aa81-b", "st-6a64aa81-c", "st-6a64aa81-d", "st-6a64aa81-e",
  "st-6a64aa81-f", "st-6a64aa81-g", "st-6a64aa81-h", "st-6a64aa81-i", "st-6a64aa81-inactive",
];

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query("BEGIN");

  // Safety: refuse if any audit rows reference these users as actor or target.
  const audit = await client.query(
    `SELECT count(*)::int AS n FROM audit_logs WHERE "actorUserId" = ANY($1) OR "targetId" = ANY($1)`,
    [IDS],
  );
  if (audit.rows[0].n > 0) throw new Error(`${audit.rows[0].n} audit rows exist for these users — refusing`);

  // Safety: these users must have no student_profiles rows.
  const profiles = await client.query(
    `SELECT count(*)::int AS n FROM student_profiles WHERE "userId" = ANY($1)`,
    [IDS],
  );
  if (profiles.rows[0].n > 0) throw new Error(`${profiles.rows[0].n} student_profiles rows exist — refusing`);

  const r1 = await client.query(`DELETE FROM refresh_tokens WHERE "userId" = ANY($1)`, [IDS]);
  const r2 = await client.query(`DELETE FROM user_roles WHERE "userId" = ANY($1)`, [IDS]);
  const r3 = await client.query(`DELETE FROM users WHERE id = ANY($1)`, [IDS]);

  console.log(JSON.stringify({ refresh_tokens: r1.rowCount, user_roles: r2.rowCount, users: r3.rowCount }));

  await client.query("COMMIT");
  console.log("Cleanup committed.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
