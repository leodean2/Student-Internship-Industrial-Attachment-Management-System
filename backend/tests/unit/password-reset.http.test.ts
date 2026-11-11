import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { PasswordResetService, PASSWORD_RESET_ACCEPTED_MESSAGE } from "../../src/modules/auth/password-reset.service";
import type { PasswordResetUserRecord, PasswordResetUserRepository } from "../../src/modules/auth/password-reset.service";
import type { PasswordResetTokenRepository } from "../../src/modules/auth/password-reset-token.repository";
import type { OutboxEnqueuer } from "../../src/modules/email-outbox/outbox.repository";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import { ORIGIN, buildTestApp } from "./helpers";

const tx = {} as Tx;
const runTx: TxRunner = async (fn) => fn(tx);

const ACTIVE_USER: PasswordResetUserRecord = { userId: "usr-1", email: "active@test.example", status: "ACTIVE" };
const VALID_PASSWORD = "new-secure-password-123";

function makeService(overrides: {
  user?: PasswordResetUserRecord | null;
  consumeResult?: { userId: string } | null;
} = {}) {
  const userRecord = overrides.user !== undefined ? overrides.user : ACTIVE_USER;
  const consumeResult = overrides.consumeResult !== undefined ? overrides.consumeResult : { userId: ACTIVE_USER.userId };

  const users: PasswordResetUserRepository = {
    findByEmail: async () => userRecord,
    findById: async () => userRecord,
    updatePassword: async () => undefined,
  };
  const tokens: PasswordResetTokenRepository = {
    insert: async () => ({ expiresAt: new Date(Date.now() + 3_600_000) }),
    consume: async () => consumeResult,
    invalidateAllForUser: async () => undefined,
  };
  const outbox: OutboxEnqueuer = { enqueue: async () => ({ created: true }) };

  return new PasswordResetService({
    users,
    tokens,
    outbox,
    audit: { record: async () => undefined },
    sessions: { revokeAllSessionsInTransaction: async () => 0 },
    appBaseUrl: "http://localhost:5173",
    runTx,
    hashPassword: async (p) => `hashed:${p}`,
  });
}

function buildApp(passwordReset: PasswordResetService) {
  const ctx = buildTestApp();
  return createApp({
    logger: ctx.logger,
    corsOrigins: [ORIGIN],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    passwordReset,
  });
}

const REQUEST_PATH = "/api/v1/auth/request-password-reset";
const CONFIRM_PATH = "/api/v1/auth/confirm-password-reset";
const HEADERS = { Origin: ORIGIN };

// ── §2: Generic request response ─────────────────────────────────────────────

describe("POST /auth/request-password-reset: generic response (C2 §2)", () => {
  it("returns 202 with the generic message for an unknown email", async () => {
    const app = buildApp(makeService({ user: null }));
    const res = await request(app).post(REQUEST_PATH).set(HEADERS).send({ email: "nobody@example.test" });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
  });

  it("returns 202 with the same generic message for an ACTIVE account", async () => {
    const app = buildApp(makeService());
    const res = await request(app).post(REQUEST_PATH).set(HEADERS).send({ email: ACTIVE_USER.email });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
  });

  it("returns 202 with the same generic message for a PENDING_VERIFICATION account", async () => {
    const app = buildApp(makeService({ user: { ...ACTIVE_USER, status: "PENDING_VERIFICATION" } }));
    const res = await request(app).post(REQUEST_PATH).set(HEADERS).send({ email: ACTIVE_USER.email });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
  });

  it("returns 202 with the same generic message for a DEACTIVATED account", async () => {
    const app = buildApp(makeService({ user: { ...ACTIVE_USER, status: "DEACTIVATED" } }));
    const res = await request(app).post(REQUEST_PATH).set(HEADERS).send({ email: ACTIVE_USER.email });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
  });

  it("returns 400 for a missing email field", async () => {
    const app = buildApp(makeService());
    const res = await request(app).post(REQUEST_PATH).set(HEADERS).send({});
    expect(res.status).toBe(400);
  });

  it("returns 403 when Origin header is missing", async () => {
    const app = buildApp(makeService());
    const res = await request(app).post(REQUEST_PATH).send({ email: ACTIVE_USER.email });
    expect(res.status).toBe(403);
  });
});

// ── Confirm reset ─────────────────────────────────────────────────────────────

describe("POST /auth/confirm-password-reset", () => {
  it("returns 204 on a successful reset", async () => {
    const app = buildApp(makeService());
    const res = await request(app)
      .post(CONFIRM_PATH)
      .set(HEADERS)
      .send({ token: "valid-token", newPassword: VALID_PASSWORD });
    expect(res.status).toBe(204);
  });

  it("returns 404 for an invalid / consumed token", async () => {
    const app = buildApp(makeService({ consumeResult: null }));
    const res = await request(app)
      .post(CONFIRM_PATH)
      .set(HEADERS)
      .send({ token: "bad", newPassword: VALID_PASSWORD });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a password that is too short", async () => {
    const app = buildApp(makeService());
    const res = await request(app)
      .post(CONFIRM_PATH)
      .set(HEADERS)
      .send({ token: "valid", newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing token field", async () => {
    const app = buildApp(makeService());
    const res = await request(app)
      .post(CONFIRM_PATH)
      .set(HEADERS)
      .send({ newPassword: VALID_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a missing newPassword field", async () => {
    const app = buildApp(makeService());
    const res = await request(app)
      .post(CONFIRM_PATH)
      .set(HEADERS)
      .send({ token: "valid" });
    expect(res.status).toBe(400);
  });

  it("returns 403 when Origin header is missing", async () => {
    const app = buildApp(makeService());
    const res = await request(app)
      .post(CONFIRM_PATH)
      .send({ token: "valid", newPassword: VALID_PASSWORD });
    expect(res.status).toBe(403);
  });
});

// ── Per-email limit: uniform ack, no Retry-After ─────────────────────────────

describe("POST /auth/request-password-reset: per-email limit (C2 §3 decision)", () => {
  it("returns 202 with the same body and no Retry-After when the per-email limit is exhausted", async () => {
    const { PasswordResetService } = await import("../../src/modules/auth/password-reset.service");
    const service = new PasswordResetService({
      users: { findByEmail: async () => ACTIVE_USER, findById: async () => ACTIVE_USER, updatePassword: async () => undefined },
      tokens: {
        insert: async () => ({ expiresAt: new Date(Date.now() + 3_600_000) }),
        consume: async () => null,
        invalidateAllForUser: async () => undefined,
      },
      outbox: { enqueue: async () => ({ created: true }) },
      audit: { record: async () => undefined },
      sessions: { revokeAllSessionsInTransaction: async () => 0 },
      appBaseUrl: "http://localhost:5173",
      runTx,
      hashPassword: async (p) => `hashed:${p}`,
      // Inject an already-exhausted per-email throttle.
      requestEmailThrottle: { acquire: () => ({ allowed: false, retryAfterSeconds: 3600 }) },
    });
    const app = buildApp(service);

    const res = await request(app)
      .post(REQUEST_PATH)
      .set(HEADERS)
      .send({ email: ACTIVE_USER.email });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(res.headers["retry-after"]).toBeUndefined();
  });
});

// ── Proxy trust: per-IP throttle buckets are independent ─────────────────────

describe("POST /auth/request-password-reset: proxy-aware IP throttle", () => {
  it("exhausting one IP does not lock out a different IP", async () => {
    // Build a service with a tiny limit: 1 request per window per IP.
    const { AttemptLimiter } = await import("../../src/shared/security/attempt-limiter");
    const requestThrottle = new AttemptLimiter({ limit: 1, windowMs: 60_000 });

    const service = new PasswordResetService({
      users: { findByEmail: async () => null, findById: async () => null, updatePassword: async () => undefined },
      tokens: {
        insert: async () => ({ expiresAt: new Date(Date.now() + 3_600_000) }),
        consume: async () => null,
        invalidateAllForUser: async () => undefined,
      },
      outbox: { enqueue: async () => ({ created: true }) },
      audit: { record: async () => undefined },
      sessions: { revokeAllSessionsInTransaction: async () => 0 },
      appBaseUrl: "http://localhost:5173",
      runTx,
      hashPassword: async (p) => `hashed:${p}`,
      requestThrottle,
    });

    // createApp with one trusted proxy hop so X-Forwarded-For is respected.
    const ctx = buildTestApp();
    const app = createApp({
      logger: ctx.logger,
      corsOrigins: [ORIGIN],
      tokens: ctx.tokens,
      actors: ctx.actors,
      sessions: ctx.sessions,
      cookie: ctx.cookie,
      passwordReset: service,
      trustProxyHops: 1,
    });

    const IP_A = "203.0.113.7";
    const IP_B = "203.0.113.8";

    // First request from IP_A consumes its one slot.
    const r1 = await request(app)
      .post(REQUEST_PATH)
      .set({ ...HEADERS, "X-Forwarded-For": IP_A })
      .send({ email: "a@example.test" });
    expect(r1.status).toBe(202);

    // Second request from IP_A is now rate-limited.
    const r2 = await request(app)
      .post(REQUEST_PATH)
      .set({ ...HEADERS, "X-Forwarded-For": IP_A })
      .send({ email: "a@example.test" });
    expect(r2.status).toBe(429);

    // IP_B has its own bucket; it must still be served.
    const r3 = await request(app)
      .post(REQUEST_PATH)
      .set({ ...HEADERS, "X-Forwarded-For": IP_B })
      .send({ email: "b@example.test" });
    expect(r3.status).toBe(202);
  });
});
