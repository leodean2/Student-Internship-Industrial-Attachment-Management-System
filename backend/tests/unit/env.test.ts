import { describe, expect, it } from "vitest";
import { loadEnv, parseCorsOrigins } from "../../src/config/env";
import { caught } from "./helpers";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  JWT_ACCESS_SECRET: "x".repeat(40),
  CORS_ORIGIN: "http://localhost:5173",
};

describe("environment validation (fail fast at startup)", () => {
  it("accepts a valid configuration and applies defaults", () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ NODE_ENV: "development", PORT: 4000, LOG_LEVEL: "info" });
  });

  it("rejects a missing or too-short JWT secret, naming the variable", () => {
    expect(caught(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: undefined })).message).toContain("JWT_ACCESS_SECRET");
    expect(caught(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: "short" })).message).toContain("at least 32");
  });

  it("never echoes configuration VALUES in the error (secrets must not reach logs)", () => {
    const err = caught(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: "short-but-secret-value", PORT: "not-a-number" }));
    expect(err.message).not.toContain("short-but-secret-value");
    expect(err.message).not.toContain("not-a-number");
  });

  it("requires DATABASE_URL and CORS_ORIGIN", () => {
    const msg = caught(() => loadEnv({ JWT_ACCESS_SECRET: valid.JWT_ACCESS_SECRET })).message;
    expect(msg).toContain("DATABASE_URL");
    expect(msg).toContain("CORS_ORIGIN");
  });

  it("never accepts a wildcard CORS origin — requests are credentialed (Decision #78)", () => {
    expect(caught(() => loadEnv({ ...valid, CORS_ORIGIN: "*" })).message).toContain("never '*'");
    expect(caught(() => loadEnv({ ...valid, CORS_ORIGIN: "https://a.example, *" })).message).toContain("never '*'");
  });

  it("parses the comma-separated CORS allow-list", () => {
    expect(parseCorsOrigins(" https://a.example , https://b.example,, ")).toEqual(["https://a.example", "https://b.example"]);
  });
});
