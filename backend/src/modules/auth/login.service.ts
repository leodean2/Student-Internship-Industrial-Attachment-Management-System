import { AppError, Errors } from "../../shared/errors";
import type { LoginThrottle } from "./login-throttle";

/** The one message for every credential failure: unknown email and wrong password are indistinguishable. */
export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";

export interface CredentialRecord {
  userId: string;
  passwordHash: string;
}

/** Narrow views of the collaborators, so the service is testable with plain fakes (the real classes satisfy them). */
export interface LoginDeps {
  credentials: { findByEmail(email: string): Promise<CredentialRecord | null> };
  /** ActorContextService: throws ACCOUNT_INACTIVE for a non-ACTIVE account, UNAUTHENTICATED for a user with no role. */
  actors: { load(userId: string): Promise<unknown> };
  sessions: { startSession(userId: string): Promise<{ token: string; expiresAt: Date }> };
  tokens: { sign(userId: string): string; readonly ttlSeconds: number };
  throttle: LoginThrottle;
  passwords: {
    verify(plain: string, hash: string): Promise<boolean>;
    /** A valid hash at the same cost as real ones; compared against when the email is unknown. */
    dummyHash(): Promise<string>;
  };
  /** Lifetime of a freshly issued refresh token (seconds); the cookie's Max-Age. */
  refreshTtlSeconds: number;
  logger: { warn(obj: object, msg: string): void };
}

export interface LoginInput {
  email: string; // already trimmed + lower-cased by the request schema
  password: string;
  ip: string;
}

export interface LoginResult {
  accessToken: string;
  accessExpiresInSeconds: number;
  refreshToken: string;
  refreshMaxAgeSeconds: number;
}

export class LoginService {
  private readonly deps: LoginDeps;

  constructor(deps: LoginDeps) {
    this.deps = deps;
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const { credentials, actors, sessions, tokens, throttle, passwords, logger, refreshTtlSeconds } = this.deps;

    // 1. Reserve an attempt BEFORE any password work (synchronous: this is what makes the limit race-free).
    const gate = throttle.acquire(input.ip, input.email);
    if (!gate.allowed) {
      logger.warn({ ip: input.ip }, "login rate limit exceeded"); // never the email or password
      throw Errors.rateLimited(gate.retryAfterSeconds);
    }
    const { permit } = gate;

    let rejected = false;
    try {
      // 2. Exactly one bcrypt comparison whether or not the account exists, so timing does not reveal it.
      const record = await credentials.findByEmail(input.email);
      const hash = record ? record.passwordHash : await passwords.dummyHash();
      const matches = await passwords.verify(input.password, hash);
      if (!record || !matches) {
        rejected = true; // stays counted as a failed attempt
        throw Errors.unauthenticated(INVALID_CREDENTIALS_MESSAGE);
      }

      // 3. Correct password. Load the actor BEFORE refunding the attempt.
      //    Decision #55: login must never disclose account state. All actor denials — ACCOUNT_INACTIVE
      //    (pending/deactivated) and UNAUTHENTICATED (role-less/SYSTEM sentinel) — return the same generic
      //    invalid-credentials response and count as failed attempts. Only unexpected errors (database down)
      //    propagate unchanged and are refunded, because they are not credential failures.
      //    Note: ACCOUNT_INACTIVE is allowed from /auth/me for a valid token (authenticate middleware),
      //    and only there — that path does not go through login.
      try {
        await actors.load(record.userId);
      } catch (error) {
        if (error instanceof AppError && (error.code === "ACCOUNT_INACTIVE" || error.code === "UNAUTHENTICATED")) {
          rejected = true;
          throw Errors.unauthenticated(INVALID_CREDENTIALS_MESSAGE);
        }
        throw error; // infrastructure errors: not a failed guess, refunded
      }
      permit.succeeded();

      // 4. Open the session. A new session's first token always has the full TTL (the 30-day cap is far longer).
      const session = await sessions.startSession(record.userId);
      return {
        accessToken: tokens.sign(record.userId),
        accessExpiresInSeconds: tokens.ttlSeconds,
        refreshToken: session.token,
        refreshMaxAgeSeconds: refreshTtlSeconds,
      };
    } finally {
      // Anything that is not a credential rejection (success, inactive account, infrastructure error) is not a
      // failed guess. No-op after succeeded().
      if (!rejected) permit.refund();
    }
  }
}
