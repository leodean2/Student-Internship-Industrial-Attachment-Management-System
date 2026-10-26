import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/infrastructure/logger";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import { PrismaAuthRepository } from "../../src/modules/auth/auth.repository";
import { PrismaRefreshTokenRepository } from "../../src/modules/auth/refresh-token.repository";
import { DEFAULT_SESSION_CONFIG } from "../../src/modules/auth/session.config";
import { SessionService, hashToken } from "../../src/modules/auth/session.service";
import { createTokenService } from "../../src/modules/auth/token";

/**
 * Concurrency, atomicity, the session cap and chain revocation can only be proven against real PostgreSQL.
 * Requires TEST_DATABASE_URL -> disposable database with the baseline migration + prisma/constraints.sql.
 *
 * Time: the service reads the DATABASE clock (Decision #76), so tests cannot move it. They "travel in time" the way
 * production would experience it — by editing the recorded timestamps (backdating a rotation or a session deadline).
 */
const url = process.env.TEST_DATABASE_URL;
const USERS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "inactive"];

describe.skipIf(!url)("refresh-token sessions against PostgreSQL (Decisions #51/#52/#55/#75-#77)", () => {
  const run = randomUUID().slice(0, 8);
  const uid = (n: string) => `st-${run}-${n}`;
  const prisma = new PrismaClient({
    // A two-connection pool catches refreshes that need a second connection while holding a transaction.
    adapter: new PrismaPg({ connectionString: url!, max: 2 }),
  });
  const logger = createLogger("silent");
  const build = (repo = new PrismaRefreshTokenRepository(), config = DEFAULT_SESSION_CONFIG) =>
    new SessionService({
      repo,
      actors: new ActorContextService(new PrismaAuthRepository(prisma)),
      tokens: createTokenService("integration-secret-integration-secret-1234567"),
      runTx: prismaTxRunner(prisma, { timeout: 30_000 }),
      config,
      logger,
    });
  const svc = build();
  const rowsFor = (userId: string) => prisma.refreshToken.findMany({ where: { userId }, orderBy: { issuedAt: "asc" } });
  const activeFor = async (userId: string) => (await rowsFor(userId)).filter((r) => !r.revokedAt);
  const errOf = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected rejection"); }, (e) => e);
  /** Pretend `seconds` have passed since every rotation of this user's tokens. */
  const ageRotations = (userId: string, seconds: number) =>
    prisma.$executeRaw`UPDATE refresh_tokens SET "revokedAt" = "revokedAt" - make_interval(secs => ${seconds}) WHERE "userId" = ${userId} AND "replacedById" IS NOT NULL`;
  const reset = async (userId: string) => {
    await prisma.refreshToken.updateMany({ where: { userId }, data: { replacedById: null } });
    await prisma.refreshToken.deleteMany({ where: { userId } });
  };

  beforeAll(async () => {
    for (const n of USERS) {
      await prisma.user.create({ data: { id: uid(n), email: `${uid(n)}@example.test`, passwordHash: "x", name: n, status: "ACTIVE" } });
      await prisma.userRole.create({ data: { userId: uid(n), role: "STUDENT" } });
    }
  });

  afterAll(async () => {
    const ids = USERS.map(uid);
    await prisma.refreshToken.updateMany({ where: { userId: { in: ids } }, data: { replacedById: null } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("rotation persists correctly: old token revoked and linked to its successor, raw token never stored", async () => {
    const { token } = await svc.startSession(uid("a"));
    const r = await svc.refresh(token);
    const rows = await rowsFor(uid("a"));
    expect(rows).toHaveLength(2);
    const old = rows.find((x) => x.tokenHash === hashToken(token))!;
    const next = rows.find((x) => x.tokenHash === hashToken(r.refreshToken))!;
    expect(old.revokedAt).not.toBeNull();
    expect(old.replacedById).toBe(next.id);
    expect(next.revokedAt).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(r.refreshToken);
  });

  it("the database refuses two rows with the same token hash (#75)", async () => {
    const { token } = await svc.startSession(uid("a"));
    const future = new Date(Date.now() + 86_400_000);
    const dup = await errOf(prisma.refreshToken.create({ data: { userId: uid("a"), tokenHash: hashToken(token), expiresAt: future, sessionExpiresAt: future } }));
    expect(dup.code).toBe("P2002");
  });

  it("the service takes its time from the database clock (#76): rotation timestamps match DB time, not just the app's", async () => {
    const { token } = await svc.startSession(uid("i"));
    await svc.refresh(token);
    const [dRow] = await prisma.$queryRaw<{ delta: number }[]>`
      SELECT abs(extract(epoch FROM (now() AT TIME ZONE 'UTC') - max("revokedAt")))::float AS delta FROM refresh_tokens WHERE "userId" = ${uid("i")}`;
    // The verification query may arrive several seconds after the remote Neon transaction commits.
    expect(dRow!.delta).toBeLessThan(30);
  });

  it("CONCURRENCY: parallel refreshes of one token — exactly one wins, the rest get 409, no orphan tokens", async () => {
    for (let round = 0; round < 6; round++) {
      const userId = uid("b");
      await reset(userId);
      const { token } = await svc.startSession(userId);

      const results = await Promise.allSettled(Array.from({ length: 8 }, () => svc.refresh(token)));
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      console.error(results.map((r) =>
        r.status === "rejected"
          ? {
              status: r.status,
              name: r.reason?.name,
              code: r.reason?.code,
              appStatus: r.reason?.status,
              message: r.reason?.message,
            }
          : { status: r.status },
      ));
      expect(won, `round ${round}: exactly one request may rotate the token`).toHaveLength(1);
      expect(lost).toHaveLength(7);
      for (const l of lost) expect(l.reason).toMatchObject({ status: 409, code: "CONFLICT" });
      expect(await rowsFor(userId), `round ${round}: no orphan tokens`).toHaveLength(2);
      expect(await activeFor(userId), `round ${round}: one live token`).toHaveLength(1);
    }
  });

  it("the old token can never succeed again: every sequential replay inside the window is a 409 and creates nothing", async () => {
    const userId = uid("g");
    const replaySvc = build(new PrismaRefreshTokenRepository(), {
      ...DEFAULT_SESSION_CONFIG,
      reuseGraceSeconds: 120,
    });
    const { token } = await svc.startSession(userId);
    await replaySvc.refresh(token);
    for (let i = 0; i < 10; i++) expect(await errOf(replaySvc.refresh(token))).toMatchObject({ status: 409 });
    expect(await rowsFor(userId)).toHaveLength(2);
    expect(await activeFor(userId)).toHaveLength(1);
  });

  it("ATOMICITY: if rotation fails after the new token was inserted, the insert is rolled back", async () => {
    class FailsAfterInsert extends PrismaRefreshTokenRepository {
      override async markRotated(): Promise<boolean> { throw new Error("simulated crash mid-rotation"); }
    }
    const failing = build(new FailsAfterInsert());
    const { token } = await svc.startSession(uid("c"));
    const before = await rowsFor(uid("c"));
    await errOf(failing.refresh(token));
    const after = await rowsFor(uid("c"));
    expect(after).toHaveLength(before.length);
    expect(after.find((r) => r.tokenHash === hashToken(token))!.revokedAt).toBeNull();
    expect((await svc.refresh(token)).refreshToken).toBeTruthy();
  });

  it("REUSE after the grace window revokes the entire live chain in the database", async () => {
    const userId = uid("d");
    const { token: t0 } = await svc.startSession(userId);
    let t = t0;
    for (let i = 0; i < 3; i++) t = (await svc.refresh(t)).refreshToken;
    expect(await activeFor(userId)).toHaveLength(1);
    await ageRotations(userId, 60); // the rotations happened a minute ago
    expect(await errOf(svc.refresh(t0))).toMatchObject({ status: 401 });
    expect(await activeFor(userId)).toHaveLength(0);
    expect(await errOf(svc.refresh(t))).toMatchObject({ status: 401 });
  });

  it("the grace window is measured from the recorded rotation time: 5 s ago is a 409, 11 s ago is theft", async () => {
    const userId = uid("h");
    const { token } = await svc.startSession(userId);
    await svc.refresh(token);
    await ageRotations(userId, 5);
    expect(await errOf(svc.refresh(token))).toMatchObject({ status: 409 });
    expect(await activeFor(userId)).toHaveLength(1);
    await ageRotations(userId, 6); // now 11 s
    expect(await errOf(svc.refresh(token))).toMatchObject({ status: 401 });
    expect(await activeFor(userId)).toHaveLength(0);
  });

  it("REUSE revokes only its own chain, not another session of the same user", async () => {
    const userId = uid("e");
    const a = await svc.startSession(userId);
    const b = await svc.startSession(userId);
    await svc.refresh(a.token);
    await ageRotations(userId, 60);
    await errOf(svc.refresh(a.token));
    const live = await activeFor(userId);
    expect(live).toHaveLength(1);
    expect(live[0]!.tokenHash).toBe(hashToken(b.token));
  });

  it("SESSION CAP: every token in a chain carries the same sessionExpiresAt, 30 days out (#77)", async () => {
    const userId = uid("f");
    await reset(userId);
    let { token } = await svc.startSession(userId);
    for (let i = 0; i < 4; i++) token = (await svc.refresh(token)).refreshToken;
    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.sessionExpiresAt.getTime())).size).toBe(1);
    const days = (rows[0]!.sessionExpiresAt.getTime() - rows[0]!.issuedAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
    // the same data-integrity query verify-structure.sql runs
    const [nRow] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM refresh_tokens a JOIN refresh_tokens b ON a."replacedById" = b.id WHERE a."sessionExpiresAt" <> b."sessionExpiresAt"`;
    expect(Number(nRow!.n)).toBe(0);
  });

  it("SESSION CAP: near the deadline the new token is capped at it, and still inherits it unchanged", async () => {
    const userId = uid("f");
    await reset(userId);
    const { token } = await svc.startSession(userId);
    // two days of session left: the 7-day token lifetime must not overshoot the deadline
    await prisma.$executeRaw`UPDATE refresh_tokens SET "sessionExpiresAt" = now() + interval '2 days', "expiresAt" = now() + interval '2 days' WHERE "userId" = ${userId}`;
    const r = await svc.refresh(token);
    const next = (await rowsFor(userId)).find((x) => x.tokenHash === hashToken(r.refreshToken))!;
    expect(next.expiresAt.getTime()).toBe(next.sessionExpiresAt.getTime());
    expect(r.refreshMaxAgeSeconds).toBeGreaterThan(2 * 86_400 - 60);
    expect(r.refreshMaxAgeSeconds).toBeLessThanOrEqual(2 * 86_400);
  });

  it("SESSION CAP: once the deadline passes the session cannot be refreshed and its token is revoked", async () => {
    const userId = uid("f");
    await reset(userId);
    const { token } = await svc.startSession(userId);
    await prisma.$executeRaw`UPDATE refresh_tokens SET "sessionExpiresAt" = now() - interval '1 second', "expiresAt" = now() - interval '1 second' WHERE "userId" = ${userId}`;
    expect(await errOf(svc.refresh(token))).toMatchObject({ status: 401 });
    expect(await activeFor(userId)).toHaveLength(0);
  });

  it("SESSION CAP: the database itself refuses a token that outlives its session (CHECK)", async () => {
    const now = Date.now();
    const err = await errOf(prisma.refreshToken.create({
      data: { userId: uid("a"), tokenHash: `cap-${run}`, expiresAt: new Date(now + 10 * 86_400_000), sessionExpiresAt: new Date(now + 5 * 86_400_000) },
    }));
    expect(String(err.message)).toMatch(/ck_refresh_token_within_session|check constraint/i);
  });

  it("a deactivated account cannot refresh, and nothing is written", async () => {
    const userId = uid("inactive");
    const { token } = await svc.startSession(userId);
    await prisma.user.update({ where: { id: userId }, data: { status: "DEACTIVATED" } });
    expect(await errOf(svc.refresh(token))).toMatchObject({ status: 401, code: "ACCOUNT_INACTIVE" });
    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
    expect(rows[0]!.replacedById).toBeNull();
  });

  it("logout with a just-rotated token ends the live session in the database", async () => {
    const userId = uid("a");
    await prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
    const { token: stale } = await svc.startSession(userId);
    const live = await svc.refresh(stale);
    await svc.logout(stale);
    expect(await activeFor(userId)).toHaveLength(0);
    expect(await errOf(svc.refresh(live.refreshToken))).toMatchObject({ status: 401 });
  });

  it("logout and revokeAllSessions work against the real database", async () => {
    const userId = uid("i");
    await prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
    const a = await svc.startSession(userId); await svc.startSession(userId); await svc.startSession(userId);
    await svc.logout(a.token);
    expect(await activeFor(userId)).toHaveLength(2);
    expect(await svc.revokeAllSessions(userId)).toBe(2);
    expect(await activeFor(userId)).toHaveLength(0);
    expect(await errOf(svc.refresh(a.token))).toMatchObject({ status: 401 });
  });
});
