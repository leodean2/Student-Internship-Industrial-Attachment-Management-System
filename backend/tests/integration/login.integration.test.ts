import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createLogger } from "../../src/infrastructure/logger";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import { PrismaAuthRepository } from "../../src/modules/auth/auth.repository";
import { PrismaCredentialsRepository } from "../../src/modules/auth/credentials.repository";
import { LoginThrottle } from "../../src/modules/auth/login-throttle";
import { LoginService } from "../../src/modules/auth/login.service";
import { getDummyHash, hashPassword, verifyPassword } from "../../src/modules/auth/password";
import { PrismaRefreshTokenRepository } from "../../src/modules/auth/refresh-token.repository";
import { DEFAULT_SESSION_CONFIG } from "../../src/modules/auth/session.config";
import { SessionService } from "../../src/modules/auth/session.service";
import { createTokenService } from "../../src/modules/auth/token";

/**
 * login -> refresh -> logout through the REAL stack against PostgreSQL, with real bcrypt hashes.
 * Requires TEST_DATABASE_URL -> a disposable database with the baseline migration + prisma/constraints.sql applied
 * (the latter seeds the SYSTEM user this test relies on).
 */
const url = process.env.TEST_DATABASE_URL;
const SYSTEM_ID = "00000000-0000-0000-0000-000000000001";
const ORIGIN = "https://app.example.com";

describe.skipIf(!url)("login against PostgreSQL (login slice)", () => {
  const run = randomUUID().slice(0, 8);
  const id = (n: string) => `lg-${run}-${n}`;
  const email = (n: string) => `${id(n)}@example.test`;
  const PASSWORD = `pw-${randomUUID()}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  const logger = createLogger("silent");
  const tokens = createTokenService("integration-secret-integration-secret-1234567");
  const actors = new ActorContextService(new PrismaAuthRepository(prisma));
  const sessions = new SessionService({
    repo: new PrismaRefreshTokenRepository(),
    actors,
    tokens,
    runTx: prismaTxRunner(prisma),
    config: DEFAULT_SESSION_CONFIG,
    logger,
  });
  const cookie = { name: "refresh_token", path: "/api/v1/auth", sameSite: "strict" as const, secure: true };
  const login = new LoginService({
    credentials: new PrismaCredentialsRepository(prisma),
    actors,
    sessions,
    tokens,
    // generous limits: throttling is covered by the unit and HTTP tests, and must not make this suite flaky
    throttle: new LoginThrottle({ config: { perEmailLimit: 1000, perIpLimit: 1000, windowMs: 15 * 60_000 } }),
    passwords: { verify: verifyPassword, dummyHash: getDummyHash },
    refreshTtlSeconds: DEFAULT_SESSION_CONFIG.refreshTtlSeconds,
    logger,
  });
  const app = createApp({ logger, corsOrigins: [ORIGIN], tokens, actors, sessions, cookie, login });

  const post = (path: string, body?: object, cookieValue?: string) => {
    const req = request(app).post(path).set("Origin", ORIGIN);
    if (cookieValue) req.set("Cookie", `refresh_token=${cookieValue}`);
    return body ? req.send(body) : req;
  };
  const tokenOf = (res: request.Response) => /refresh_token=([^;]+)/.exec(String((res.headers["set-cookie"] as unknown as string[])?.[0] ?? ""))?.[1] ?? "";
  const rowsFor = (userId: string) => prisma.refreshToken.findMany({ where: { userId } });

  beforeAll(async () => {
    const passwordHash = await hashPassword(PASSWORD);
    for (const [n, status] of [["ok", "ACTIVE"], ["inactive", "DEACTIVATED"]] as const) {
      await prisma.user.create({ data: { id: id(n), email: email(n), passwordHash, name: n, status } });
      await prisma.userRole.create({ data: { userId: id(n), role: "STUDENT" } });
    }
  });

  afterAll(async () => {
    const ids = [id("ok"), id("inactive")];
    await prisma.refreshToken.updateMany({ where: { userId: { in: ids } }, data: { replacedById: null } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("stores the password as a cost-12 bcrypt hash, never the plaintext", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: id("ok") } });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it("login -> /me -> refresh -> logout -> refresh refused, with only hashes persisted", async () => {
    const res = await post("/api/v1/auth/login", { email: email("ok"), password: PASSWORD });
    expect(res.status).toBe(200);
    const first = tokenOf(res);
    expect(first.length).toBeGreaterThanOrEqual(43);

    const rows = await rowsFor(id("ok"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(first); // the raw token is never stored
    const days = (rows[0]!.sessionExpiresAt.getTime() - rows[0]!.issuedAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);

    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(id("ok"));
    expect(me.body.roles).toEqual(["STUDENT"]);

    const refreshed = await post("/api/v1/auth/refresh", undefined, first);
    expect(refreshed.status).toBe(200);
    const live = tokenOf(refreshed);
    expect((await post("/api/v1/auth/logout", undefined, live)).status).toBe(204);
    expect((await post("/api/v1/auth/refresh", undefined, live)).status).toBe(401);
  });

  it("a wrong password and an unknown email are the same 401 and create no session", async () => {
    const before = (await rowsFor(id("ok"))).length;
    const wrong = await post("/api/v1/auth/login", { email: email("ok"), password: "wrong-password" });
    const unknown = await post("/api/v1/auth/login", { email: email("nobody"), password: "wrong-password" });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Invalid email or password." });
    }
    expect((await rowsFor(id("ok"))).length).toBe(before);
  });

  it("a deactivated account with the correct password is ACCOUNT_INACTIVE and gets no session", async () => {
    const res = await post("/api/v1/auth/login", { email: email("inactive"), password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
    expect(await rowsFor(id("inactive"))).toHaveLength(0);
  });

  it("the seeded SYSTEM user can never log in and gets no session", async () => {
    const res = await post("/api/v1/auth/login", { email: "system@internal.invalid", password: "!" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
    expect(await prisma.refreshToken.count({ where: { userId: SYSTEM_ID } })).toBe(0);
  });
});
