import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { LoginThrottle } from "../../src/modules/auth/login-throttle";
import { LoginService } from "../../src/modules/auth/login.service";
import { DEFAULT_SESSION_CONFIG } from "../../src/modules/auth/session.config";
import { ORIGIN, SYSTEM_ID, buildTestApp } from "./helpers";

const PATH = "/api/v1/auth/login";
const PASSWORD = "correct-horse-battery";
const ACCOUNTS: Record<string, string> = {
  "stu@example.test": "stu",
  "gone@example.test": "deactivated",
  "new@example.test": "pending",
  "system@internal.invalid": SYSTEM_ID,
};

function build(trustProxyHops?: number) {
  const ctx = buildTestApp();
  const throttleClock = { now: 1_000_000 };
  const login = new LoginService({
    credentials: {
      findByEmail: async (email) => {
        const userId = ACCOUNTS[email];
        return userId ? { userId, passwordHash: `hash:${PASSWORD}` } : null;
      },
    },
    actors: ctx.actors,
    sessions: ctx.sessions,
    tokens: ctx.tokens,
    throttle: new LoginThrottle({ now: () => throttleClock.now }),
    passwords: { verify: async (plain, hash) => hash === `hash:${plain}`, dummyHash: async () => "dummy" },
    refreshTtlSeconds: DEFAULT_SESSION_CONFIG.refreshTtlSeconds,
    logger: ctx.logger,
  });
  const app = createApp({
    logger: ctx.logger,
    corsOrigins: [ORIGIN],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    login,
    trustProxyHops,
  });
  return { ...ctx, app, throttleClock };
}

const creds = (over: object = {}) => ({ email: "stu@example.test", password: PASSWORD, ...over });
const attempt = (app: Express, body: unknown, headers: Record<string, string> = {}) =>
  request(app).post(PATH).set({ Origin: ORIGIN, ...headers }).send(body as object);
const setCookies = (res: request.Response): string[] => (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
const refreshTokenOf = (res: request.Response): string => /refresh_token=([^;]+)/.exec(setCookies(res)[0] ?? "")?.[1] ?? "";

describe("POST /api/v1/auth/login: success", () => {
  it("returns an access token in the body and a hardened refresh cookie, uncached", async () => {
    const { app } = build();
    const res = await attempt(app, creds());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: expect.any(String), tokenType: "Bearer", expiresIn: 900 });
    expect(res.headers["cache-control"]).toBe("no-store");
    const cookie = setCookies(res)[0]!;
    expect(cookie).toMatch(/^refresh_token=[A-Za-z0-9_-]{43,};/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/v1/auth", "Max-Age=604800"]) expect(cookie).toContain(attr);
  });

  it("login -> /me -> refresh -> logout -> refresh is refused", async () => {
    const { app } = build();
    const res = await attempt(app, creds());
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe("stu");

    const refreshed = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", `refresh_token=${refreshTokenOf(res)}`);
    expect(refreshed.status).toBe(200);
    const live = refreshTokenOf(refreshed);
    const out = await request(app).post("/api/v1/auth/logout").set("Origin", ORIGIN).set("Cookie", `refresh_token=${live}`);
    expect(out.status).toBe(204);
    const after = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", `refresh_token=${live}`);
    expect(after.status).toBe(401);
  });

  it("trims and lower-cases the email", async () => {
    const { app } = build();
    expect((await attempt(app, creds({ email: "  STU@Example.Test " }))).status).toBe(200);
  });
});

describe("POST /api/v1/auth/login: failures", () => {
  it("unknown email and wrong password are indistinguishable and set no cookie", async () => {
    const { app, tokenRepo } = build();
    const unknown = await attempt(app, creds({ email: "nobody@example.test" }));
    const wrong = await attempt(app, creds({ password: "wrong-password" }));
    for (const res of [unknown, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid email or password." });
      expect(setCookies(res)).toHaveLength(0);
    }
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    expect(tokenRepo.rows.size).toBe(0);
  });

  it("deactivated and unverified accounts: ACCOUNT_INACTIVE only with the correct password", async () => {
    const { app, tokenRepo } = build();
    for (const email of ["gone@example.test", "new@example.test"]) {
      const right = await attempt(app, creds({ email }));
      expect(right.status).toBe(401);
      expect(right.body.error.code).toBe("ACCOUNT_INACTIVE");
      const wrong = await attempt(app, creds({ email, password: "wrong-password" }));
      expect(wrong.body.error.code).toBe("UNAUTHENTICATED");
    }
    expect(tokenRepo.rows.size).toBe(0);
  });

  it("the role-less SYSTEM user cannot log in even with a 'correct' password and gets no session", async () => {
    const { app, tokenRepo } = build();
    const res = await attempt(app, creds({ email: "system@internal.invalid" }));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid email or password." });
    expect(tokenRepo.rows.size).toBe(0);
  });

  it("a missing or foreign Origin is a 403 and nothing is processed", async () => {
    const { app, tokenRepo } = build();
    expect((await request(app).post(PATH).send(creds())).status).toBe(403);
    expect((await request(app).post(PATH).set("Origin", "https://evil.example.com").send(creds())).status).toBe(403);
    expect(tokenRepo.rows.size).toBe(0);
  });

  it("rejects malformed bodies with a 400 that never echoes the submitted values", async () => {
    const { app } = build();
    const bodies: unknown[] = [
      {},
      { email: "stu@example.test" },
      { password: PASSWORD },
      { email: "not-an-email", password: "SuperSecretValue123" },
      { email: "stu@example.test", password: "" },
      { email: "stu@example.test", password: "x".repeat(257) },
      { email: "stu@example.test", password: PASSWORD, role: "ADMIN" }, // unknown field
    ];
    for (const body of bodies) {
      const res = await attempt(app, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(res.body)).not.toContain("SuperSecretValue123");
    }
  });

  it("rejects invalid JSON and a non-JSON body with a 400", async () => {
    const { app } = build();
    const bad = await request(app).post(PATH).set({ Origin: ORIGIN, "Content-Type": "application/json" }).send("{bad json");
    expect(bad.status).toBe(400);
    const text = await request(app).post(PATH).set({ Origin: ORIGIN, "Content-Type": "text/plain" }).send("email=a&password=b");
    expect(text.status).toBe(400);
  });
});

describe("POST /api/v1/auth/login: throttling", () => {
  it("the 11th failed attempt is a 429 with Retry-After, even with the correct password; it recovers after 15 minutes", async () => {
    const { app, throttleClock } = build();
    for (let i = 0; i < 10; i++) expect((await attempt(app, creds({ password: "wrong" }))).status).toBe(401);
    const blocked = await attempt(app, creds());
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBe("900");
    expect(setCookies(blocked)).toHaveLength(0);
    throttleClock.now += 15 * 60_000;
    expect((await attempt(app, creds())).status).toBe(200);
  });

  it("50 failures from one address with different emails exhaust the IP-wide budget", async () => {
    const { app } = build();
    for (let i = 0; i < 50; i++) expect((await attempt(app, creds({ email: `user${i}@example.test` }))).status).toBe(401);
    const res = await attempt(app, creds({ email: "fresh@example.test" }));
    expect(res.status).toBe(429);
  });

  it("ignores X-Forwarded-For by default, so spoofing it cannot dodge the throttle", async () => {
    const { app } = build(); // 0 trusted proxies
    for (let i = 0; i < 10; i++) await attempt(app, creds({ password: "wrong" }), { "X-Forwarded-For": `203.0.113.${i}` });
    const res = await attempt(app, creds(), { "X-Forwarded-For": "198.51.100.7" });
    expect(res.status).toBe(429);
  });

  it("with one trusted proxy each client address has its own budget", async () => {
    const { app } = build(1);
    for (let i = 0; i < 10; i++) await attempt(app, creds({ password: "wrong" }), { "X-Forwarded-For": "203.0.113.1" });
    expect((await attempt(app, creds(), { "X-Forwarded-For": "203.0.113.1" })).status).toBe(429);
    expect((await attempt(app, creds(), { "X-Forwarded-For": "203.0.113.2" })).status).toBe(200);
  });
});

describe("POST /api/v1/auth/login: logging", () => {
  it("never writes the password, the email or any issued token to the logs", async () => {
    const { app, logs } = build();
    await attempt(app, creds({ password: "wrong-but-secret" }));
    const ok = await attempt(app, creds());
    const text = logs.text();
    for (const secret of [PASSWORD, "wrong-but-secret", "stu@example.test", ok.body.accessToken, refreshTokenOf(ok)]) {
      expect(text).not.toContain(secret);
    }
  });
});
