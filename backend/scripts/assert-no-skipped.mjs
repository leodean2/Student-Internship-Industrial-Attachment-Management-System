import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("Usage: node scripts/assert-no-skipped.mjs <vitest-json-report>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const {
  numTotalTests,
  numPassedTests,
  numFailedTests,
  numPendingTests,
  numTodoTests = 0,
} = report;

console.log(
  JSON.stringify({
    total: numTotalTests,
    passed: numPassedTests,
    failed: numFailedTests,
    skipped: numPendingTests,
    todo: numTodoTests,
  }),
);

if (
  numFailedTests > 0 ||
  numPendingTests > 0 ||
  numTodoTests > 0 ||
  numPassedTests !== numTotalTests
) {
  console.error(
    "Integration run is not fully green: failed, skipped or todo tests exist. Check the env flags for every suite.",
  );
  process.exit(1);
}
