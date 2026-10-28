import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  JWT_ACCESS_SECRET: "x".repeat(40),
  CORS_ORIGIN: "http://localhost:5173",
};

describe("TRUST_PROXY_HOPS", () => {
  it("defaults to 0 (trust no forwarded address) and accepts a small count", () => {
    expect(loadEnv(valid).TRUST_PROXY_HOPS).toBe(0);
    expect(loadEnv({ ...valid, TRUST_PROXY_HOPS: "1" }).TRUST_PROXY_HOPS).toBe(1);
  });

  it("rejects negative, fractional, too-large and non-numeric values, naming the variable", () => {
    for (const bad of ["-1", "1.5", "6", "abc"]) {
      expect(() => loadEnv({ ...valid, TRUST_PROXY_HOPS: bad })).toThrow(/TRUST_PROXY_HOPS/);
    }
  });
});
