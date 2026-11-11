import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createLogger } from "../../src/infrastructure/logger";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import { PrismaAuthRepository } from "../../src/modules/auth/auth.repository";
import { PrismaCredentialsRepository } from "../../src/modules/auth/credentials.repository";
import { LoginThrottle } from "../../src/modules/auth/login-throttle";
import { LoginService } from "../../src/modules/auth/login.service";
import { DEFAULT_SESSION_CONFIG } from "../../src/modules/auth/session.config";
import { PrismaRefreshTokenRepository } from "../../src/modules/auth/refresh-token.repository";
import { SessionService } from "../../src/modules/auth/session.service";
import { createTokenService } from "../../src/modules/auth/token";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { getDummyHash, hashPassword, verifyPassword } from "../../src/modules/auth/password";
import { PrismaInvitationRepository } from "../../src/modules/invitations/invitation.repository";
import { InvitationService, type InvitationServiceDeps } from "../../src/modules/invitations/invitation.service";
import { PrismaOutboxRepository } from "../../src/modules/outbox/outbox.repository";

const connectionString = process.env.TEST_DATABASE_URL;
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const email = (label: string) => `accept-${run}-${label}@example.test`;
const invitationIds: string[] = [];
const userIds: string[] = [];
const adminId = randomUUID();
const password = "integration-password-123";
const secret = "integration-secret-integration-secret-1234567";
const corsOrigin = "http://localhost:5173";
const actor: ActorContext = {
  userId: adminId,
  status: "ACTIVE",
  roles: new Set(["ADMIN"]),
  profileIds: { organizationSupervisor: [] },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe.skipIf(!connectionString)("invitation acceptance against PostgreSQL", () => {
  let prisma: PrismaClient;
  let pool2Prisma: PrismaClient;
  let service: InvitationService;
  let app: ReturnType<typeof createApp>;
  let bearer: string;
  const query = <T>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params);
  const execute = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const build = (overrides: Partial<InvitationServiceDeps> = {}, client = prisma) =>
    new InvitationService({
      repo: new PrismaInvitationRepository(),
      audit: new PrismaAuditRepository(),
      outbox: new PrismaOutboxRepository(),
      appBaseUrl: "https://app.example.test",
      runTx: prismaTxRunner(client, { timeout: 30_000 }),
      ...overrides,
    });

  async function createInvitation(label: string) {
    const target = email(label);
    const created = await service.create(actor, { email: target, role: "UNIVERSITY_SUPERVISOR" });
    invitationIds.push(created.invitationId);
    const [outbox] = await query<{ payload: { acceptanceUrl: string } }>(
      `SELECT o.payload
       FROM invitations i
       JOIN email_outbox o ON o."idempotencyKey" = 'invitation-created:' || i."tokenHash"
       WHERE i.id = $1`,
      created.invitationId,
    );
    if (!outbox) throw new Error("Invitation outbox row was not created.");
    const token = new URL(outbox.payload.acceptanceUrl).searchParams.get("token");
    if (!token) throw new Error("Invitation acceptance URL did not contain a token.");
    return { invitationId: created.invitationId, email: target, token };
  }

  beforeAll(async () => {
    if (!connectionString) return;
    const target = new URL(connectionString);
    if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
      throw new Error("Refusing to run invitation acceptance integration tests outside test_db.");
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 4 }) });
    const pool2Url = new URL(connectionString);
    pool2Url.searchParams.set("application_name", `invitation-acceptance-pool2-${run}`);
    pool2Prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pool2Url.toString(), max: 2 }) });
    await execute(
      `INSERT INTO users (id, email, "passwordHash", name, status, "updatedAt")
       VALUES ($1, $2, 'integration-only', 'Integration Admin', 'ACTIVE', now())`,
      adminId,
      email("admin"),
    );
    await execute(
      `INSERT INTO user_roles ("id", "userId", role) VALUES ($1, $2, 'ADMIN')`,
      randomUUID(),
      adminId,
    );
    service = build();
    const tokens = createTokenService(secret);
    const actors = new ActorContextService(new PrismaAuthRepository(prisma));
    const sessions = new SessionService({
      repo: new PrismaRefreshTokenRepository(),
      actors,
      tokens,
      runTx: prismaTxRunner(prisma),
      config: DEFAULT_SESSION_CONFIG,
      logger: createLogger("silent"),
    });
    const login = new LoginService({
      credentials: new PrismaCredentialsRepository(prisma),
      actors,
      sessions,
      tokens,
      throttle: new LoginThrottle({
        config: { perEmailLimit: 1000, perIpLimit: 1000, perEmailGlobalLimit: 1000, windowMs: 15 * 60_000 },
      }),
      passwords: { verify: verifyPassword, dummyHash: getDummyHash },
      refreshTtlSeconds: DEFAULT_SESSION_CONFIG.refreshTtlSeconds,
      logger: createLogger("silent"),
    });
    app = createApp({
      logger: createLogger("silent"),
      corsOrigins: [corsOrigin],
      tokens,
      actors,
      sessions,
      login,
      cookie: { name: "refresh_token", path: "/api/v1/auth", sameSite: "strict", secure: true },
      invitations: service,
    });
    bearer = `Bearer ${tokens.sign(adminId)}`;
  });

  afterAll(async () => {
    if (!prisma) return;
    await execute(`DELETE FROM audit_logs WHERE "targetId" = ANY($1::text[])`, invitationIds);
    await execute(`DELETE FROM email_outbox WHERE "toEmail" LIKE $1`, `accept-${run}-%`);
    await execute(`DELETE FROM invitations WHERE id = ANY($1::text[])`, invitationIds);
    await execute(`DELETE FROM refresh_tokens WHERE "userId" = ANY($1::text[])`, userIds);
    await execute(`DELETE FROM university_supervisor_profiles WHERE "userId" = ANY($1::text[])`, userIds);
    await execute(`DELETE FROM user_roles WHERE "userId" = ANY($1::text[])`, userIds);
    await execute(`DELETE FROM user_roles WHERE "userId" = $1`, adminId);
    await execute(`DELETE FROM users WHERE id = ANY($1::text[])`, [...userIds, adminId]);
    await pool2Prisma.$disconnect();
    await prisma.$disconnect();
  });

  it("creates an ACTIVE user, role, profile, claim, and audit atomically; password is hashed", async () => {
    const invitation = await createInvitation("success");
    const result = await service.accept({
      token: invitation.token,
      password,
      name: "Integration Supervisor",
      staffId: "STAFF-42",
      title: "Associate Professor",
      ip: "198.51.100.42",
    });
    userIds.push(result.userId);

    expect(result).toEqual({
      userId: expect.any(String),
      email: invitation.email,
      role: "UNIVERSITY_SUPERVISOR",
    });
    const [user] = await query<{ status: string; passwordHash: string }>(
      `SELECT status, "passwordHash" FROM users WHERE id = $1`,
      result.userId,
    );
    expect(user?.status).toBe("ACTIVE");
    expect(user?.passwordHash).not.toBe(password);
    expect(await verifyPassword(password, user!.passwordHash)).toBe(true);

    const [profile] = await query<{ staffId: string; title: string }>(
      `SELECT "staffId", title FROM university_supervisor_profiles WHERE "userId" = $1`,
      result.userId,
    );
    expect(profile).toEqual({ staffId: "STAFF-42", title: "Associate Professor" });
    const [claim] = await query<{ acceptedByUserId: string; acceptedAt: Date }>(
      `SELECT "acceptedByUserId", "acceptedAt" FROM invitations WHERE id = $1`,
      invitation.invitationId,
    );
    expect(claim?.acceptedByUserId).toBe(result.userId);
    expect(claim?.acceptedAt).toBeInstanceOf(Date);
    expect(await query(
      `SELECT id FROM audit_logs WHERE "targetId" = $1 AND action = 'INVITATION_ACCEPTED' AND "actorUserId" = $2`,
      invitation.invitationId,
      result.userId,
    )).toHaveLength(1);
  }, 30_000);

  it("serializes five concurrent accepts with a two-connection pool; password hashing precedes transactions", async () => {
    const invitation = await createInvitation("concurrent-five");
    const hashStarted = deferred();
    const releaseHashing = deferred();
    let transactionStarts = 0;
    const pool2Service = build({
      runTx: async (fn) => {
        transactionStarts++;
        return prismaTxRunner(pool2Prisma, { timeout: 30_000 })(fn);
      },
      hashPassword: async (plain) => {
        hashStarted.resolve();
        await releaseHashing.promise;
        return hashPassword(plain);
      },
    }, pool2Prisma);
    const accepts = Array.from({ length: 5 }, (_, index) => pool2Service.accept({
      token: invitation.token,
      password,
      name: "Concurrent Supervisor",
      staffId: null,
      title: null,
      ip: `198.51.100.${43 + index}`,
    }));
    await hashStarted.promise;
    expect(transactionStarts).toBe(0);
    releaseHashing.resolve();
    const results = await Promise.allSettled(accepts);
    const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.accept>>> =>
      result.status === "fulfilled");
    const losers = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const loser of losers) expect(loser.reason).toMatchObject({ status: 404, code: "NOT_FOUND" });
    userIds.push(successful[0]!.value.userId);
    expect(transactionStarts).toBe(5);
    expect(await query(`SELECT id FROM users WHERE email = $1`, invitation.email)).toHaveLength(1);
    expect(await query(
      `SELECT id FROM audit_logs WHERE "targetId" = $1 AND action = 'INVITATION_ACCEPTED'`,
      invitation.invitationId,
    )).toHaveLength(1);
  }, 60_000);

  it("returns 409 for an account created after invitation issuance without claiming it", async () => {
    const invitation = await createInvitation("existing-account");
    const existingUserId = randomUUID();
    userIds.push(existingUserId);
    await execute(
      `INSERT INTO users (id, email, "passwordHash", name, status, "updatedAt")
       VALUES ($1, $2, 'integration-only', 'Existing User', 'ACTIVE', now())`,
      existingUserId,
      invitation.email,
    );
    await expect(service.accept({
      token: invitation.token,
      password,
      name: "Duplicate Account",
      staffId: null,
      title: null,
      ip: "198.51.100.44",
    })).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    const [row] = await query<{ acceptedByUserId: string | null }>(
      `SELECT "acceptedByUserId" FROM invitations WHERE id = $1`,
      invitation.invitationId,
    );
    expect(row?.acceptedByUserId).toBeNull();
  }, 30_000);

  it("returns the same 404 for unknown, accepted, cancelled, and expired tokens", async () => {
    const accepted = await createInvitation("uniform-accepted");
    const acceptedAccount = await service.accept({
      token: accepted.token,
      password,
      name: "Accepted Supervisor",
      staffId: null,
      title: null,
      ip: "198.51.100.70",
    });
    userIds.push(acceptedAccount.userId);

    const cancelled = await createInvitation("uniform-cancelled");
    await service.cancel(actor, cancelled.invitationId);

    const expired = await createInvitation("uniform-expired");
    await execute(
      `UPDATE invitations SET "expiresAt" = clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second' WHERE id = $1`,
      expired.invitationId,
    );

    const attempts = [
      service.accept({ token: "unknown-token", password, name: "Name", staffId: null, title: null, ip: "198.51.100.71" }),
      service.accept({ token: accepted.token, password, name: "Name", staffId: null, title: null, ip: "198.51.100.72" }),
      service.accept({ token: cancelled.token, password, name: "Name", staffId: null, title: null, ip: "198.51.100.73" }),
      service.accept({ token: expired.token, password, name: "Name", staffId: null, title: null, ip: "198.51.100.74" }),
    ];
    const outcomes = await Promise.all(attempts.map(async (attempt) => {
      try {
        await attempt;
        return null;
      } catch (error) {
        return error;
      }
    }));
    expect(outcomes.every((error) =>
      error && typeof error === "object" && "status" in error && "code" in error &&
      error.status === 404 && error.code === "NOT_FOUND")).toBe(true);
    expect(outcomes.map((error) => error instanceof Error ? error.message : null))
      .toEqual(Array(4).fill("The requested resource was not found."));
  }, 60_000);

  it("runs invitation creation, acceptance, cancellation, and administrative retrieval through HTTP", async () => {
    const created = await request(app).post("/api/v1/invitations")
      .set("Authorization", bearer)
      .send({ email: email("http-accepted"), role: "UNIVERSITY_SUPERVISOR" });
    expect(created.status).toBe(201);
    invitationIds.push(created.body.invitationId);
    expect(created.body).toEqual({
      invitationId: expect.any(String),
      email: email("http-accepted"),
      role: "UNIVERSITY_SUPERVISOR",
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(created.body)).not.toMatch(/token|hash/i);
    const [outbox] = await query<{ payload: { acceptanceUrl: string } }>(
      `SELECT o.payload
       FROM invitations i
       JOIN email_outbox o ON o."idempotencyKey" = 'invitation-created:' || i."tokenHash"
       WHERE i.id = $1`,
      created.body.invitationId,
    );
    expect(outbox).toBeDefined();

    const accepted = await request(app).post("/api/v1/invitations/accept")
      .set("Origin", corsOrigin)
      .send({ token: new URL(outbox!.payload.acceptanceUrl).searchParams.get("token"), password, name: "HTTP Supervisor" });
    expect(accepted.status).toBe(201);
    userIds.push(accepted.body.userId);
    expect(accepted.body).toEqual({
      userId: expect.any(String),
      email: email("http-accepted"),
      role: "UNIVERSITY_SUPERVISOR",
    });
    expect(JSON.stringify(accepted.body)).not.toMatch(/token|hash/i);

    const signedIn = await request(app).post("/api/v1/auth/login")
      .set("Origin", corsOrigin)
      .send({ email: email("http-accepted"), password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({
      accessToken: expect.any(String),
      tokenType: "Bearer",
      expiresIn: expect.any(Number),
    });
    const me = await request(app).get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${signedIn.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      userId: accepted.body.userId,
      roles: ["UNIVERSITY_SUPERVISOR"],
    });

    const listed = await request(app).get("/api/v1/invitations")
      .query({ email: email("http-accepted") })
      .set("Authorization", bearer);
    expect(listed.status).toBe(200);
    expect(listed.body.data[0]).toMatchObject({
      id: created.body.invitationId,
      status: "ACCEPTED",
      acceptedAt: expect.any(String),
    });
    expect(JSON.stringify(listed.body)).not.toMatch(/tokenHash|acceptedByUserId|raw.invitation.token/i);
    const retrieved = await request(app).get(`/api/v1/invitations/${created.body.invitationId}`)
      .set("Authorization", bearer);
    expect(retrieved.status).toBe(200);
    expect(retrieved.body.status).toBe("ACCEPTED");

    const toCancel = await request(app).post("/api/v1/invitations")
      .set("Authorization", bearer)
      .send({ email: email("http-cancelled"), role: "UNIVERSITY_SUPERVISOR" });
    expect(toCancel.status).toBe(201);
    invitationIds.push(toCancel.body.invitationId);
    const cancelled = await request(app).patch(`/api/v1/invitations/${toCancel.body.invitationId}/cancel`)
      .set("Authorization", bearer);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("CANCELLED");
    const [cancelOutbox] = await query<{ payload: { acceptanceUrl: string } }>(
      `SELECT o.payload
       FROM invitations i
       JOIN email_outbox o ON o."idempotencyKey" = 'invitation-created:' || i."tokenHash"
       WHERE i.id = $1`,
      toCancel.body.invitationId,
    );
    const rejected = await request(app).post("/api/v1/invitations/accept")
      .set("Origin", corsOrigin)
      .send({ token: new URL(cancelOutbox!.payload.acceptanceUrl).searchParams.get("token"), password, name: "HTTP Supervisor" });
    expect(rejected.status).toBe(404);
    expect(rejected.body.error).toMatchObject({ code: "NOT_FOUND", message: "The requested resource was not found." });
  }, 90_000);

  it("rolls back the newly created user and profile when the conditional claim fails", async () => {
    const invitation = await createInvitation("lost-claim");
    class FailingClaimRepository extends PrismaInvitationRepository {
      override async claim(): Promise<boolean> {
        return false;
      }
    }
    const failing = build({
      repo: new FailingClaimRepository(),
    });
    await expect(failing.accept({
      token: invitation.token,
      password,
      name: "Rolled Back Supervisor",
      staffId: "ROLLBACK",
      title: null,
      ip: "198.51.100.45",
    })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await query(`SELECT id FROM users WHERE email = $1`, invitation.email)).toHaveLength(0);
    expect(await query(`SELECT id FROM university_supervisor_profiles WHERE "staffId" = 'ROLLBACK'`)).toHaveLength(0);
    const [row] = await query<{ acceptedByUserId: string | null }>(
      `SELECT "acceptedByUserId" FROM invitations WHERE id = $1`,
      invitation.invitationId,
    );
    expect(row?.acceptedByUserId).toBeNull();
  }, 30_000);
});
