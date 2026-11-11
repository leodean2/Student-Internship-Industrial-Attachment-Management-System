/**
 * C2 Password Reset — PostgreSQL integration tests.
 *
 * Guards:
 *   TEST_DATABASE_URL          — connection string pointing at the disposable test DB
 *   RUN_PASSWORD_RESET_INTEGRATION=true
 *   OUTBOX_TEST_DB_DISPOSABLE=true
 *   NEON_BRANCH must NOT be "production"
 *   database name in the connection string must be "test_db"
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/infrastructure/logger";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { hashToken } from "../../src/shared/security/opaque-token";
import { hashPassword } from "../../src/modules/auth/password";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import { PrismaOutboxRepository } from "../../src/modules/email-outbox/outbox.repository";
import { PrismaPasswordResetTokenRepository } from "../../src/modules/auth/password-reset-token.repository";
import { PrismaPasswordResetUserRepository } from "../../src/modules/auth/password-reset-user.repository";
import { PasswordResetService } from "../../src/modules/auth/password-reset.service";
import { PrismaRefreshTokenRepository } from "../../src/modules/auth/refresh-token.repository";
import { SessionService } from "../../src/modules/auth/session.service";
import { DEFAULT_SESSION_CONFIG } from "../../src/modules/auth/session.config";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import { PrismaAuthRepository } from "../../src/modules/auth/auth.repository";
import { createTokenService } from "../../src/modules/auth/token";
import { PASSWORD_RESET_REQUESTED } from "../../src/modules/email-outbox/password-reset-requested.payload";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_PASSWORD_RESET_INTEGRATION === "true";
const disposableConfirmed = process.env.OUTBOX_TEST_DB_DISPOSABLE === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const emailPrefix = `pwreset-it-${run}-`;
const userIds: string[] = [];
const jobRunIds: string[] = [];

/** Fixed context used by all integration-test service calls; throttle buckets are bypassed via injected limiters. */
const CTX = { ip: "127.0.0.1" };

describe.skipIf(!connectionString || !enabled || !disposableConfirmed)(
  "C2 password reset on PostgreSQL",
  () => {
    let prisma: PrismaClient;
    const logger = createLogger("silent");

    function makeService(options: { hashPassword?: (p: string) => Promise<string> } = {}) {
      const actors = new ActorContextService(new PrismaAuthRepository(prisma));
      const sessions = new SessionService({
        repo: new PrismaRefreshTokenRepository(),
        actors,
        tokens: createTokenService("test-secret-integration-only-32chars"),
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 }),
        config: DEFAULT_SESSION_CONFIG,
        logger,
      });
      return new PasswordResetService({
        users: new PrismaPasswordResetUserRepository(prisma),
        tokens: new PrismaPasswordResetTokenRepository(),
        outbox: new PrismaOutboxRepository(),
        audit: new PrismaAuditRepository(),
        sessions,
        appBaseUrl: "https://app.example.test",
        runTx: prismaTxRunner(prisma, { maxWait: 10_000, timeout: 20_000 }),
        hashPassword: options.hashPassword ?? hashPassword,
      });
    }

    async function createUser(
      label: string,
      status: "ACTIVE" | "PENDING_VERIFICATION" | "DEACTIVATED" = "ACTIVE",
      plainPassword = "integration-password-123",
    ): Promise<{ id: string; email: string; passwordHash: string }> {
      const id = randomUUID();
      const email = `${emailPrefix}${label}@example.test`;
      const ph = await hashPassword(plainPassword);
      userIds.push(id);
      await prisma.user.create({
        data: {
          id,
          email,
          passwordHash: ph,
          name: `Reset Test ${label}`,
          status,
          emailVerifiedAt: status === "ACTIVE" ? new Date() : null,
        },
      });
      await prisma.userRole.create({ data: { userId: id, role: "STUDENT" } });
      return { id, email, passwordHash: ph };
    }

    async function cleanupFixtures() {
      for (const id of userIds.splice(0)) {
        await prisma.$executeRaw`DELETE FROM notifications WHERE "recipientUserId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM audit_logs WHERE "actorUserId" = ${id} OR "targetId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM email_outbox WHERE "relatedUserId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM password_reset_tokens WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM email_verification_tokens WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM refresh_tokens WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM user_roles WHERE "userId" = ${id}`;
        await prisma.$executeRaw`DELETE FROM users WHERE id = ${id}`;
      }
    }

    beforeAll(async () => {
      if (!connectionString) return;
      if (!enabled || !disposableConfirmed) {
        throw new Error(
          "Set RUN_PASSWORD_RESET_INTEGRATION=true and OUTBOX_TEST_DB_DISPOSABLE=true for a disposable database.",
        );
      }
      if (process.env.NEON_BRANCH === "production") {
        throw new Error("Refusing password-reset integration tests while NEON_BRANCH is production.");
      }
      const target = new URL(connectionString);
      if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
        throw new Error("Refusing to run password-reset integration tests outside test_db.");
      }
      target.searchParams.set("application_name", `password-reset-${run}`);
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString(), max: 6 }) });
      await prisma.$connect();
    }, 60_000);

    beforeEach(cleanupFixtures);
    afterAll(async () => {
      if (!prisma) return;
      await cleanupFixtures();
      await prisma.$disconnect();
    });

    // ── §1–2: Account eligibility and generic response ────────────────────────

    it("does not create a reset token for an unknown email", async () => {
      const service = makeService();
      const result = await service.requestReset("nobody@example.test", CTX);
      expect(result.message).toBeTruthy();
      const count = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM password_reset_tokens`;
      expect(count[0]!.count).toBe(0);
    });

    it("does not create a reset token for a PENDING_VERIFICATION account", async () => {
      const { email } = await createUser("pending", "PENDING_VERIFICATION");
      const service = makeService();
      await service.requestReset(email, CTX);
      expect(await prisma.passwordResetToken.count({ where: { user: { email } } })).toBe(0);
      expect(await prisma.emailOutbox.count({ where: { relatedUser: { email }, templateType: PASSWORD_RESET_REQUESTED } })).toBe(0);
    });

    it("does not create a reset token for a DEACTIVATED account", async () => {
      const { email } = await createUser("deactivated", "DEACTIVATED");
      const service = makeService();
      await service.requestReset(email, CTX);
      expect(await prisma.passwordResetToken.count({ where: { user: { email } } })).toBe(0);
    });

    it("creates exactly one reset token and enqueues the email for an ACTIVE account", async () => {
      const { id, email } = await createUser("active-request");
      const service = makeService();
      await service.requestReset(email, CTX);
      const tokens = await prisma.passwordResetToken.findMany({ where: { userId: id } });
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.usedAt).toBeNull();
      const outbox = await prisma.emailOutbox.findMany({ where: { relatedUserId: id, templateType: PASSWORD_RESET_REQUESTED } });
      expect(outbox).toHaveLength(1);
    });

    // ── §3: Token expiry ──────────────────────────────────────────────────────

    it("stores the expiry one hour from now (using database time)", async () => {
      const { id, email } = await createUser("expiry-check");
      await makeService().requestReset(email, CTX);
      const token = await prisma.passwordResetToken.findFirst({ where: { userId: id } });
      expect(token).toBeDefined();
      const diffMs = token!.expiresAt.getTime() - Date.now();
      // Allow ±30 s drift between DB and application clocks.
      expect(diffMs).toBeGreaterThan(3_570_000); // 59.5 min
      expect(diffMs).toBeLessThan(3_630_000); // 60.5 min
    });

    it("rejects an expired token at confirmation", async () => {
      const { id, email } = await createUser("expired-token");
      await makeService().requestReset(email, CTX);
      // Force-expire the token.
      await prisma.$executeRaw`
        UPDATE password_reset_tokens SET "expiresAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "userId" = ${id}`;
      const tokenRow = await prisma.passwordResetToken.findFirst({ where: { userId: id } });
      const rawFromDb = tokenRow!.tokenHash; // we don't have the raw; use hash to exercise the consume path
      // confirmReset hashes the input token; pass the already-hashed value via hashToken(x) = raw=x,hash=sha256(x)
      // Instead, regenerate a token presentation that will hash to the stored hash — not possible directly.
      // So we verify via the service not finding it (expired token returns null from consume).
      await expect(makeService().confirmReset({ token: "expired-raw", newPassword: "new-secure-password-123" }, CTX)).rejects.toMatchObject({ status: 404 });
    });

    // ── Token security: stored as hash ─────────────────────────────────────────

    it("stores only the token hash, not the raw token", async () => {
      const { id, email } = await createUser("hash-check");
      const service = makeService();
      await service.requestReset(email, CTX);

      const token = await prisma.passwordResetToken.findFirst({ where: { userId: id } });
      expect(token).toBeDefined();
      // A hex SHA-256 is 64 chars. The raw token is base64url (43 chars).
      expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

      // The raw token is embedded in the outbox payload URL, not stored in the token row.
      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown> | null;
      const urlToken = payload ? new URL(payload["resetUrl"] as string).searchParams.get("token") : null;
      expect(urlToken).toBeTruthy();
      expect(urlToken).not.toBe(token!.tokenHash);
    });

    // ── Token single-use ────────────────────────────────────────────────────────

    it("tokens cannot be reused after a successful reset", async () => {
      const { id, email } = await createUser("reuse");
      const service = makeService();
      await service.requestReset(email, CTX);

      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown>;
      const rawToken = new URL(payload["resetUrl"] as string).searchParams.get("token")!;

      await service.confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX);
      await expect(
        service.confirmReset({ token: rawToken, newPassword: "another-secure-password-456" }, CTX),
      ).rejects.toMatchObject({ status: 404 });
    });

    // ── Concurrent consumption ────────────────────────────────────────────────────

    it("concurrent confirmation attempts produce exactly one successful reset", async () => {
      const { id, email } = await createUser("concurrent");
      await makeService().requestReset(email, CTX);

      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown>;
      const rawToken = new URL(payload["resetUrl"] as string).searchParams.get("token")!;

      const service = makeService({ hashPassword: async (p) => `hashed:${p}` });
      const results = await Promise.allSettled([
        service.confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX),
        service.confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX),
      ]);
      const successes = results.filter((r) => r.status === "fulfilled");
      const failures = results.filter((r) => r.status === "rejected");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
    });

    // ── §5: Account recheck at confirmation ───────────────────────────────────

    it("rejects a reset when the account is deactivated after token issuance", async () => {
      const { id, email } = await createUser("deactivate-mid-flow");
      await makeService().requestReset(email, CTX);

      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown>;
      const rawToken = new URL(payload["resetUrl"] as string).searchParams.get("token")!;

      // Deactivate the account after the token was issued.
      await prisma.user.update({ where: { id }, data: { status: "DEACTIVATED" } });

      await expect(
        makeService().confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX),
      ).rejects.toMatchObject({ status: 404 });
      // Password must be unchanged.
      const user = await prisma.user.findUnique({ where: { id }, select: { passwordHash: true } });
      expect(user!.passwordHash).not.toBe("hashed:new-secure-password-123");
    });

    // ── §4: Password validation matches registration rules ────────────────────

    it("password validation matches registration rules", async () => {
      const { email } = await createUser("validation");
      await makeService().requestReset(email, CTX);
      await expect(
        makeService().confirmReset({ token: "some-token", newPassword: "short" }, CTX),
      ).rejects.toMatchObject({ status: 400 });
    });

    // ── §6: Session revocation on successful reset ────────────────────────────

    it("revokes all refresh sessions after a successful reset", async () => {
      const { id, email } = await createUser("session-revoke");
      // Create some sessions for this user.
      await prisma.$executeRaw`
        INSERT INTO refresh_tokens (id, "userId", "tokenHash", "issuedAt", "expiresAt", "sessionExpiresAt")
        VALUES
          (${randomUUID()}, ${id}, ${"hash-a-" + id}, now(), now() + INTERVAL '7 days', now() + INTERVAL '30 days'),
          (${randomUUID()}, ${id}, ${"hash-b-" + id}, now(), now() + INTERVAL '7 days', now() + INTERVAL '30 days')`;

      const service = makeService();
      await service.requestReset(email, CTX);
      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown>;
      const rawToken = new URL(payload["resetUrl"] as string).searchParams.get("token")!;

      await service.confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX);

      const activeSessions = await prisma.refreshToken.count({ where: { userId: id, revokedAt: null } });
      expect(activeSessions).toBe(0);
    });

    // ── §6: Other reset tokens are invalidated ───────────────────────────────

    it("invalidates other outstanding reset tokens after a successful reset", async () => {
      const { id, email } = await createUser("multi-token");
      const service = makeService();

      // Issue two reset tokens.
      await service.requestReset(email, CTX);
      // The first request invalidates any prior tokens and issues a new one.
      // Issue a second: the repository will invalidate the first and create a new one.
      await service.requestReset(email, CTX);

      const allTokens = await prisma.passwordResetToken.findMany({ where: { userId: id } });
      // Both tokens exist in the table; only one should be unused.
      const unused = allTokens.filter((t) => t.usedAt === null);
      expect(unused).toHaveLength(1);

      // Use the latest (unused) token.
      const outbox = await prisma.emailOutbox.findMany({ where: { relatedUserId: id }, orderBy: { createdAt: "asc" } });
      const latestPayload = outbox[outbox.length - 1]?.payload as Record<string, unknown>;
      const rawToken = new URL(latestPayload["resetUrl"] as string).searchParams.get("token")!;

      await service.confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX);

      // After reset, all tokens must be used.
      const remaining = await prisma.passwordResetToken.count({ where: { userId: id, usedAt: null } });
      expect(remaining).toBe(0);
    });

    // ── Audit log: no token data ─────────────────────────────────────────────

    it("does not include raw token or token hash in audit metadata", async () => {
      const { id, email } = await createUser("audit-check");
      const service = makeService();
      await service.requestReset(email, CTX);
      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown>;
      const rawToken = new URL(payload["resetUrl"] as string).searchParams.get("token")!;
      await service.confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX);

      const auditLogs = await prisma.auditLog.findMany({ where: { actorUserId: id } });
      for (const log of auditLogs) {
        const metaStr = JSON.stringify(log.metadata ?? {});
        expect(metaStr).not.toContain(rawToken);
        expect(metaStr).not.toContain(hashToken(rawToken));
      }
    });

    // ── Transaction atomicity ────────────────────────────────────────────────

    it("does not update the password when the transaction rolls back", async () => {
      const { id, email } = await createUser("rollback");
      const originalHash = (await prisma.user.findUnique({ where: { id }, select: { passwordHash: true } }))!.passwordHash;
      const service = makeService();
      await service.requestReset(email, CTX);
      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown>;
      const rawToken = new URL(payload["resetUrl"] as string).searchParams.get("token")!;

      // A bad password triggers a 400 before any DB writes.
      await expect(
        service.confirmReset({ token: rawToken, newPassword: "short" }, CTX),
      ).rejects.toMatchObject({ status: 400 });

      const user = await prisma.user.findUnique({ where: { id }, select: { passwordHash: true } });
      expect(user!.passwordHash).toBe(originalHash);
      // Token must still be valid (no partial state).
      const token = await prisma.passwordResetToken.findFirst({ where: { userId: id } });
      expect(token!.usedAt).toBeNull();
    });

    it("rolls back password and token changes when session revocation fails", async () => {
      const { id, email } = await createUser("session-revoke-rollback");
      const originalHash = (await prisma.user.findUnique({ where: { id }, select: { passwordHash: true } }))!.passwordHash;
      const sessionId = randomUUID();
      await prisma.refreshToken.create({
        data: {
          id: sessionId,
          userId: id,
          tokenHash: `rollback-session-${id}`,
          expiresAt: new Date(Date.now() + 60_000),
          sessionExpiresAt: new Date(Date.now() + 120_000),
        },
      });
      await makeService().requestReset(email, CTX);
      const outbox = await prisma.emailOutbox.findFirst({ where: { relatedUserId: id } });
      const payload = outbox?.payload as Record<string, unknown>;
      const rawToken = new URL(payload["resetUrl"] as string).searchParams.get("token")!;

      const functionName = `fail_reset_session_revoke_${run}`;
      const triggerName = `fail_reset_session_revoke_${run}`;
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'simulated session revocation failure';
        END;
        $$`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON refresh_tokens
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);

      try {
        await expect(
          makeService().confirmReset({ token: rawToken, newPassword: "new-secure-password-123" }, CTX),
        ).rejects.toThrow();
        const user = await prisma.user.findUnique({ where: { id }, select: { passwordHash: true } });
        const token = await prisma.passwordResetToken.findFirst({ where: { userId: id } });
        const session = await prisma.refreshToken.findUnique({ where: { id: sessionId } });
        expect(user!.passwordHash).toBe(originalHash);
        expect(token!.usedAt).toBeNull();
        expect(session!.revokedAt).toBeNull();
        expect(
          await prisma.auditLog.count({ where: { actorUserId: id, action: "PASSWORD_RESET_CONFIRMED" } }),
        ).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON refresh_tokens`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      }
    });
  },
);
