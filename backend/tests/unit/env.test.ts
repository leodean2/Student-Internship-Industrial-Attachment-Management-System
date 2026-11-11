import { describe, expect, it } from "vitest";
import { loadEnv, loadWorkerEnv, parseCorsOrigins } from "../../src/config/env";
import { caught } from "./helpers";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  JWT_ACCESS_SECRET: "x".repeat(40),
  CORS_ORIGIN: "http://localhost:5173",
};

describe("environment validation (fail fast at startup)", () => {
  it("accepts a valid configuration and applies defaults", () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      PORT: 4000,
      LOG_LEVEL: "info",
      APP_BASE_URL: "http://localhost:5173",
      EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT: 10,
      EMAIL_VERIFY_WINDOW_MS: 900_000,
    });
  });

  it("validates configurable verification failure throttles", () => {
    expect(() => loadEnv({ ...valid, EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT: "0" })).toThrow(
      /EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT/,
    );
    expect(() => loadEnv({ ...valid, EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT: "1001" })).toThrow(
      /EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT/,
    );
    expect(() => loadEnv({ ...valid, EMAIL_VERIFY_WINDOW_MS: "59999" })).toThrow(/EMAIL_VERIFY_WINDOW_MS/);
    expect(() => loadEnv({ ...valid, EMAIL_VERIFY_WINDOW_MS: "86400001" })).toThrow(/EMAIL_VERIFY_WINDOW_MS/);
    expect(loadEnv({
      ...valid,
      EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT: "5",
      EMAIL_VERIFY_WINDOW_MS: "3600000",
    })).toMatchObject({
      EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT: 5,
      EMAIL_VERIFY_WINDOW_MS: 3_600_000,
    });
  });

  it("requires an HTTPS application base URL in production", () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: "production" })).toThrow(/APP_BASE_URL is required in production/);
    expect(() => loadEnv({ ...valid, NODE_ENV: "production", APP_BASE_URL: "http://app.example.test" }))
      .toThrow(/APP_BASE_URL must use https in production/);
    expect(loadEnv({ ...valid, NODE_ENV: "production", APP_BASE_URL: "https://app.example.test" }).APP_BASE_URL)
      .toBe("https://app.example.test");
  });

  it("rejects malformed or non-http application base URLs", () => {
    expect(() => loadEnv({ ...valid, APP_BASE_URL: "not a URL" })).toThrow(/APP_BASE_URL/);
    expect(() => loadEnv({ ...valid, APP_BASE_URL: "javascript:alert\(1\)" })).toThrow(/APP_BASE_URL/);
  });

  describe("worker environment validation", () => {
    const workerEnv = { DATABASE_URL: "postgresql://localhost:5432/attachment_dev" };

    it("defaults to the local log provider and worker sizing values", () => {
      expect(loadWorkerEnv(workerEnv)).toMatchObject({
        NODE_ENV: "development",
        EMAIL_PROVIDER: "log",
        WORKER_BATCH_SIZE: 10,
        WORKER_CONCURRENCY: 5,
      });
    });

    it("rejects log mode in production", () => {
      expect(() => loadWorkerEnv({ ...workerEnv, NODE_ENV: "production" })).toThrow(/EMAIL_PROVIDER=log/);
    });

    it("requires Resend credentials and sender when Resend is selected", () => {
      expect(() => loadWorkerEnv({ ...workerEnv, EMAIL_PROVIDER: "resend" })).toThrow(/RESEND_API_KEY/);
      expect(() =>
        loadWorkerEnv({
          ...workerEnv,
          EMAIL_PROVIDER: "resend",
          RESEND_API_KEY: "api-key-secret",
        }),
      ).toThrow(/EMAIL_FROM/);
    });

    it("does not echo provider secrets in configuration errors", () => {
      let message = "";
      try {
        loadWorkerEnv({
          ...workerEnv,
          EMAIL_PROVIDER: "resend",
          RESEND_API_KEY: "provider-secret-value",
        });
      } catch (error) {
        if (error instanceof Error) message = error.message;
      }
      expect(message).toContain("EMAIL_FROM");
      expect(message).not.toContain("provider-secret-value");
    });
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
