/**
 * Verification runner — Batch B close-out.
 *
 * Reads VERIFY_DATABASE_URL from .env, deploys all migrations to the scratch
 * database, then runs verify-structure.sql and verify-behaviour.sql against it.
 *
 * Usage (from the backend directory):
 *   node prisma/verification/run-verification.mjs
 *
 * Requirements: pg package (already a project dependency).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import pg from "pg";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "../..");

// ---------------------------------------------------------------------------
// Load .env manually (dotenv is a dev dependency; avoid requiring it here)
// ---------------------------------------------------------------------------
function loadDotenv() {
  const envPath = resolve(root, ".env");
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotenv();

const url = process.env.VERIFY_DATABASE_URL;
if (!url) {
  console.error("VERIFY_DATABASE_URL is not set in .env");
  process.exit(1);
}

// Safety check: must point at verify_db, never test_db or production.
const parsed = new URL(url);
const dbName = decodeURIComponent(parsed.pathname.slice(1));
if (dbName !== "verify_db") {
  console.error(`Refusing to run verification against database "${dbName}". Expected "verify_db".`);
  process.exit(1);
}

console.log(`\nTarget database: ${dbName} on ${parsed.hostname}`);

// ---------------------------------------------------------------------------
// Step 1: deploy migrations
// ---------------------------------------------------------------------------
console.log("\n=== Step 1: prisma migrate deploy ===");
try {
  execSync("npx prisma migrate deploy", {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
    stdio: "inherit",
  });
} catch (err) {
  console.error("Migration deploy failed:", err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 2: run SQL verification scripts
// ---------------------------------------------------------------------------
const client = new pg.Client({ connectionString: url });
await client.connect();

async function runScript(label, filePath) {
  console.log(`\n=== ${label} ===`);
  const sql = readFileSync(filePath, "utf8");

  // verify-structure.sql is a single SELECT — run it directly.
  // verify-behaviour.sql uses psql meta-commands (\set, \echo) which the pg
  // driver cannot execute. Strip them and run the pure SQL statements.
  const stripped = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("\\"))
    .join("\n");

  try {
    const result = await client.query(stripped);
    // The last meaningful result is the SELECT from the CTE / _results table.
    const rows = Array.isArray(result) ? result.at(-1)?.rows : result.rows;
    if (!rows || rows.length === 0) {
      console.log("(no rows returned)");
      return true;
    }

    // Pretty-print
    const cols = Object.keys(rows[0]);
    const widths = cols.map((c) =>
      Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
    );
    const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
    const divider = widths.map((w) => "-".repeat(w)).join("  ");
    console.log(header);
    console.log(divider);
    for (const row of rows) {
      console.log(cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  "));
    }

    const failCol = cols.find((c) => c.toLowerCase() === "result" || c.toLowerCase() === "pass");
    if (failCol) {
      const failures = rows.filter((r) => {
        const v = String(r[failCol]);
        return v === "FAIL" || v === "false" || v === "f";
      });
      if (failures.length > 0) {
        console.error(`\n${failures.length} FAILURE(S) in ${label}`);
        return false;
      }
      console.log(`\nAll ${rows.length} check(s) PASSED.`);
    }
    return true;
  } catch (err) {
    console.error(`Error running ${label}:`, err.message);
    return false;
  }
}

const structureOk = await runScript(
  "verify-structure.sql",
  resolve(__dir, "verify-structure.sql"),
);

// verify-behaviour.sql uses a helper function and a serial table; run it as
// individual statements split on semicolons preceded by a newline, which is
// safe for this file's formatting.
console.log("\n=== verify-behaviour.sql ===");
const behaviourSql = readFileSync(resolve(__dir, "verify-behaviour.sql"), "utf8");
const behaviourStripped = behaviourSql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("\\"))
  .join("\n");

let behaviourOk = true;
try {
  await client.query(behaviourStripped);
  // Read results from the _results table that the script populates.
  const { rows } = await client.query(
    "SELECT n, name, expected, got, pass FROM _results ORDER BY n"
  );
  if (rows.length === 0) {
    console.log("(no results rows — script may not have run)");
    behaviourOk = false;
  } else {
    const failures = rows.filter((r) => !r.pass);
    const cols = ["n", "name", "expected", "got", "pass"];
    const widths = cols.map((c) =>
      Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
    );
    const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
    const divider = widths.map((w) => "-".repeat(w)).join("  ");
    console.log(header);
    console.log(divider);
    for (const row of rows) {
      const line = cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  ");
      if (!row.pass) console.error(line);
      else console.log(line);
    }
    const total = rows.length;
    const passed = rows.filter((r) => r.pass).length;
    console.log(`\nTotal: ${total}  Passed: ${passed}  Failed: ${failures.length}`);
    if (failures.length > 0) {
      console.error("\nFAILURES:");
      for (const f of failures) {
        console.error(`  [${f.n}] ${f.name} — expected ${f.expected}, got ${f.got}`);
      }
      behaviourOk = false;
    } else {
      console.log("All behaviour checks PASSED.");
    }
  }
} catch (err) {
  console.error("Error running verify-behaviour.sql:", err.message);
  behaviourOk = false;
}

await client.end();

console.log("\n=== Summary ===");
console.log(`verify-structure.sql : ${structureOk ? "PASS" : "FAIL"}`);
console.log(`verify-behaviour.sql : ${behaviourOk ? "PASS" : "FAIL"}`);

if (!structureOk || !behaviourOk) process.exit(1);
