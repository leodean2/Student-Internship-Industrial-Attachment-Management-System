import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { hashPassword } from "./password";
import { checkPassword } from "./password-policy";
import { mintOpaqueToken, hashToken } from "../../shared/security/opaque-token";
import { normalizeEmail } from "../../shared/validation/email";
import { Errors } from "../../shared/errors";
import { AttemptLimiter } from "../../shared/security/attempt-limiter";
import { createThrottleKeyer, type ThrottleKeyer } from "../../shared/throttle-key";
import type { AuditRepository } from "../audit/audit.repository";
import type { OutboxEnqueuer } from "../email-outbox/outbox.repository";
import { enqueuePasswordResetRequested } from "../email-outbox/password-reset-requested.producer";
import { enqueuePasswordChanged } from "../email-outbox/password-changed.producer";
import type { PasswordResetTokenRepository } from "./password-reset-token.repository";

export const PASSWORD_RESET_ACCEPTED_MESSAGE =
  "If that email address has an active account, a password-reset link is on its way.";

const INVALID_TOKEN_MESSAGE = "This password-reset link is invalid or has expired.";

/** Per-IP, per-window limits (C2 §2). */
export const PASSWORD_RESET_REQUEST_LIMIT = 10;
export const PASSWORD_RESET_CONFIRM_LIMIT = 10;
export const PASSWORD_RESET_WINDOW_MS = 15 * 60 * 1000;

/** Per-email limit: default 3 requests per hour (C2 decision §3). Configurable via PASSWORD_RESET_EMAIL_LIMIT_PER_HOUR. */
export const DEFAULT_PASSWORD_RESET_EMAIL_LIMIT = 3;
export const PASSWORD_RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface PasswordResetUserRecord {
  userId: string;
  email: string;
  status: "PENDING_VERIFICATION" | "ACTIVE" | "DEACTIVATED";
}

export interface PasswordResetUserRepository {
  findByEmail(email: string): Promise<PasswordResetUserRecord | null>;
  findById(tx: Tx, userId: string): Promise<PasswordResetUserRecord | null>;
  updatePassword(tx: Tx, userId: string, passwordHash: string): Promise<void>;
}

export interface PasswordResetServiceDeps {
  users: PasswordResetUserRepository;
  tokens: PasswordResetTokenRepository;
  outbox: OutboxEnqueuer;
  audit: AuditRepository;
  sessions: { revokeAllSessionsInTransaction(tx: Tx, userId: string): Promise<number> };
  appBaseUrl: string;
  runTx: TxRunner;
  hashPassword?: (plain: string) => Promise<string>;
  requestThrottle?: Pick<AttemptLimiter, "acquire">;
  confirmThrottle?: Pick<AttemptLimiter, "acquire">;
  /** Per-email request limiter. Defaults to DEFAULT_PASSWORD_RESET_EMAIL_LIMIT per PASSWORD_RESET_EMAIL_WINDOW_MS. */
  requestEmailThrottle?: Pick<AttemptLimiter, "acquire">;
  /** Configurable per-email limit (overrides DEFAULT_PASSWORD_RESET_EMAIL_LIMIT when no requestEmailThrottle is given). */
  emailLimitPerHour?: number;
  /** Keyer for HMAC-hashed throttle keys. Defaults to a random per-process key. */
  throttleKeyer?: ThrottleKeyer;
}

export interface RequestContext {
  readonly ip: string;
}

export class PasswordResetService {
  private readonly hashPw: (plain: string) => Promise<string>;
  private readonly requestThrottle: Pick<AttemptLimiter, "acquire">;
  private readonly confirmThrottle: Pick<AttemptLimiter, "acquire">;
  private readonly requestEmailThrottle: Pick<AttemptLimiter, "acquire">;
  private readonly throttleKeyer: ThrottleKeyer;

  constructor(private readonly deps: PasswordResetServiceDeps) {
    this.hashPw = deps.hashPassword ?? hashPassword;
    this.requestThrottle =
      deps.requestThrottle ??
      new AttemptLimiter({ limit: PASSWORD_RESET_REQUEST_LIMIT, windowMs: PASSWORD_RESET_WINDOW_MS });
    this.confirmThrottle =
      deps.confirmThrottle ??
      new AttemptLimiter({ limit: PASSWORD_RESET_CONFIRM_LIMIT, windowMs: PASSWORD_RESET_WINDOW_MS });
    this.requestEmailThrottle =
      deps.requestEmailThrottle ??
      new AttemptLimiter({
        limit: deps.emailLimitPerHour ?? DEFAULT_PASSWORD_RESET_EMAIL_LIMIT,
        windowMs: PASSWORD_RESET_EMAIL_WINDOW_MS,
      });
    this.throttleKeyer = deps.throttleKeyer ?? createThrottleKeyer();
  }

  /**
   * Request a password-reset email. Returns the same generic message regardless of whether
   * the email exists or the account is eligible (C2 §2 — no account enumeration).
   * Throttled per IP; the same limit applies to all account states so the response is uniform.
   */
  async requestReset(rawEmail: string, context: RequestContext): Promise<{ message: string }> {
    // Throttle before any work. The same response is returned for all outcomes, so no refund:
    // a throttled response is indistinguishable from a successful one to the caller (C2 §2).
    const gate = this.requestThrottle.acquire(`password-reset-request:ip:${context.ip}`);
    if (!gate.allowed) throw Errors.rateLimited(gate.retryAfterSeconds);

    const email = normalizeEmail(rawEmail);

    // Per-email limit: applied to the normalized address, keyed as HMAC so the raw email never appears
    // in a bucket key. Applied regardless of account state to prevent mailbombing (C2 §3 decision).
    const emailGate = this.requestEmailThrottle.acquire(
      this.throttleKeyer.key("password-reset:email", email),
    );
    if (!emailGate.allowed) return { message: PASSWORD_RESET_ACCEPTED_MESSAGE }; // same generic ack, no 429
    const { users, tokens, outbox, audit, appBaseUrl, runTx } = this.deps;

    const record = await users.findByEmail(email);

    // Only ACTIVE accounts receive a reset email (C2 §1). All other states return the same message (C2 §2).
    if (record?.status === "ACTIVE") {
      const { raw, hash } = mintOpaqueToken();
      await runTx(async (tx) => {
        const { expiresAt } = await tokens.insert(tx, { userId: record.userId, tokenHash: hash });
        await enqueuePasswordResetRequested(outbox, tx, {
          toEmail: email,
          userId: record.userId,
          rawToken: raw,
          tokenHash: hash,
          expiresAt,
          appBaseUrl,
        });
        // No token or token hash in metadata (C2 §6).
        await audit.record(tx, {
          actorUserId: record.userId,
          action: "PASSWORD_RESET_REQUESTED",
          targetType: "User",
          targetId: record.userId,
          metadata: {},
        });
      });
    }

    // Refund is intentionally NOT called: an ineligible address must cost the same as an eligible one.
    return { message: PASSWORD_RESET_ACCEPTED_MESSAGE };
  }

  /**
   * Confirm a password reset with a valid token and a new password. Rechecks account state,
   * enforces token single-use, updates the password, invalidates outstanding reset tokens,
   * and revokes all refresh sessions — all in one transaction (C2 §5, §6).
   */
  async confirmReset(input: { token: string; newPassword: string }, context: RequestContext): Promise<void> {
    // Throttle before any crypto/DB work to bound token-guess attempts (C2 §2).
    const gate = this.confirmThrottle.acquire(`password-reset-confirm:ip:${context.ip}`);
    if (!gate.allowed) throw Errors.rateLimited(gate.retryAfterSeconds);

    const passwordCheck = checkPassword(input.newPassword);
    if (!passwordCheck.ok) {
      throw Errors.validation(undefined, "Password does not meet the requirements.");
    }

    const tokenHash = hashToken(input.token);
    const newHash = await this.hashPw(input.newPassword);
    const { users, tokens, outbox, audit, sessions, runTx } = this.deps;

    let succeeded = false;
    try {
      await runTx(async (tx) => {
        // Atomically consume the token; rejects if unknown, used, or expired (C2 §3, §6).
        const consumed = await tokens.consume(tx, tokenHash);
        if (!consumed) throw Errors.notFound(INVALID_TOKEN_MESSAGE);

        // Recheck account state at confirmation time (C2 §5).
        const user = await users.findById(tx, consumed.userId);
        if (!user || user.status !== "ACTIVE") {
          throw Errors.notFound(INVALID_TOKEN_MESSAGE);
        }

        // Update the password hash (C2 §4).
        await users.updatePassword(tx, user.userId, newHash);

        // Invalidate all other outstanding reset tokens (C2 §6).
        await tokens.invalidateAllForUser(tx, user.userId);

        // Session revocation is inside the transaction: cannot succeed after the password commits (C2 §6).
        await sessions.revokeAllSessionsInTransaction(tx, user.userId);

        // Password-changed security notice enqueued in the same transaction.
        await enqueuePasswordChanged(outbox, tx, {
          toEmail: user.email,
          userId: user.userId,
          resetEventKey: tokenHash,
        });

        // No raw token or hash in metadata (C2 §6).
        await audit.record(tx, {
          actorUserId: user.userId,
          action: "PASSWORD_RESET_CONFIRMED",
          targetType: "User",
          targetId: user.userId,
          metadata: {},
        });

        succeeded = true;
      });
    } finally {
      // Refund the throttle slot only on actual success; a bad token or inactive account still costs a slot.
      if (succeeded) gate.permit.refund();
    }
  }
}
