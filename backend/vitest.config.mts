import { defineConfig } from "vitest/config";
// Unit + HTTP-level tests. No database required.
export default defineConfig({
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
