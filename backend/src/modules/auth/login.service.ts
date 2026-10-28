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

      // 3. The password is right, so this is not a failed attempt. Only now may account state be revealed.
      permit.succeeded();
      try {
        await actors.load(record.userId); // ACCOUNT_INACTIVE for deactivated/unverified; UNAUTHENTICATED if role-less
      } catch (err) {
        if (err instanceof AppError && err.code === "UNAUTHENTICATED") {
          throw Errors.unauthenticated(INVALID_CREDENTIALS_MESSAGE); // e.g. the SYSTEM sentinel: never reveal why
        }
        throw err;
      }

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
