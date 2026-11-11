import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(backendRoot, ".env") });

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for verified integration tests.");
if (process.env.OUTBOX_TEST_DB_DISPOSABLE !== "true") {
  throw new Error("Set OUTBOX_TEST_DB_DISPOSABLE=true to confirm the integration database is disposable.");
}
if (process.env.NEON_BRANCH !== "test") {
  throw new Error("Refusing verified integration tests unless NEON_BRANCH=test.");
}

const databaseUrl = new URL(connectionString);
if (decodeURIComponent(databaseUrl.pathname.slice(1)) !== "test_db") {
  throw new Error("Refusing verified integration tests outside the test_db database.");
}
if (databaseUrl.hostname.includes("-pooler")) {
  throw new Error("Use a direct TEST_DATABASE_URL for PostgreSQL integration tests.");
}

for (const name of [
  "RUN_EMAIL_OUTBOX_INTEGRATION",
  "RUN_PASSWORD_RESET_INTEGRATION",
  "RUN_STUDENT_REGISTRATION_CLEANUP_INTEGRATION",
  "RUN_ACCOUNT_DEACTIVATION_INTEGRATION",
  "RUN_INVITATION_MANAGEMENT_INTEGRATION",
]) {
  process.env[name] = "true";
}

const reportDir = mkdtempSync(resolve(tmpdir(), "student-integration-report-"));
const reportPath = resolve(reportDir, "integration-report.json");
const vitestPath = resolve(backendRoot, "node_modules", "vitest", "vitest.mjs");
const assertPath = resolve(backendRoot, "scripts", "assert-no-skipped.mjs");
const testFilters = process.argv.slice(2);

try {
  const testResult = spawnSync(
    process.execPath,
    [
      vitestPath,
      "run",
      ...testFilters,
      "--config",
      "vitest.integration.config.mts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
    { cwd: backendRoot, env: process.env, stdio: "inherit" },
  );
  if (testResult.error) throw testResult.error;

  const assertion = spawnSync(process.execPath, [assertPath, reportPath], {
    cwd: backendRoot,
    stdio: "inherit",
  });
  if (assertion.error) throw assertion.error;

  process.exitCode = testResult.status || assertion.status || 0;
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
