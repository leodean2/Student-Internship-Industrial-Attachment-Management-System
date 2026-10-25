import { defineConfig } from "vitest/config";
// Database-backed tests. Require TEST_DATABASE_URL pointing at a disposable
// database that already has the baseline migration + prisma/constraints.sql applied.
export default defineConfig({
  test: { include: ["tests/integration/**/*.test.ts"], environment: "node", fileParallelism: false },
});
