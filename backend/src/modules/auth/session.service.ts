import { createHash, randomBytes } from "node:crypto";
import type { Logger } from "../../infrastructure/logger";
import type { TxRunner } from "../../infrastructure/transaction";
import { Errors } from "../../shared/errors";
import type { ActorContextService } from "./actor-context.service";
import type { RefreshTokenRepository } from "./refresh-token.repository";
import type { SessionConfig } from "./session.config";
import type { TokenService } from "./token";

export const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");
const mint = () => {
  const raw = randomBytes(32).toString("base64url"); // 256 bits of entropy
  return { raw, hash: hashToken(raw) };
};
const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const earliest = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

export interface IssuedRefreshToken { token: string; expiresAt: Date }
export interface RefreshResult {
  accessToken: string;
  accessExpiresInSeconds: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  /** Remaining life of the NEW refresh token — what the cookie's Max-Age must be (shorter near the session cap). */
  refreshMaxAgeSeconds: number;
}

/** Thrown inside the transaction to roll back the speculative new token when the single-use guard is lost. */
class RotationConflict extends Error {}

type Outcome =
  | { kind: "rotated"; userId: string; token: string; expiresAt: Date; maxAgeSeconds: number }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "recent-reuse" }
  | { kind: "replayed"; userId: string; revoked: number };

export interface SessionServiceDeps {
  repo: RefreshTokenRepository;
  actors: ActorContextService;
  tokens: TokenService;
  runTx: TxRunner;
  config: SessionConfig;
  logger: Logger;
}

/**
 * Refresh-token sessions (Decisions #51, #55, #76, #77). Owns the transaction for each use case (#52).
 *
 * TIME: every comparison and every timestamp written uses repo.now(tx) — the database clock — never the
 * API process's clock (Decision #76). The grace window is measured from the recorded rotation time.
 *
 * Reuse policy (Decision #76):
 *  - token rotated <= reuseGraceSeconds ago  -> 409 CONFLICT, nothing revoked   (benign race, e.g. two tabs)
 *  - token rotated  > reuseGraceSeconds ago  -> 401, the live session (rest of the rotation chain) is revoked
 *  - token revoked without rotation (logout / deactivation / reset) -> 401, no further action
 *  A token that has been rotated can NEVER be rotated again: the old row is revoked in the same transaction that
 *  creates its successor, and the only code path that issues tokens requires `revokedAt IS NULL`.
 *
 * Session lifetime (Decision #77): the session deadline is fixed at start and copied unchanged by every
 * rotation; each token expires at min(now + refreshTtl, sessionExpiresAt). The per-token TTL doubles as the
 * 7-day idle limit. Presenting an expired token ends its session.
 */
export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /** Primitive for the future login flow: opens a session and returns the raw token (shown once). */
  async startSession(userId: string): Promise<IssuedRefreshToken> {
    const { repo, runTx, config } = this.deps;
    const { raw, hash } = mint();
    const expiresAt = await runTx(async (tx) => {
      const now = await repo.now(tx);
      const sessionExpiresAt = addSeconds(now, config.absoluteSessionSeconds);
      const tokenExpiresAt = earliest(addSeconds(now, config.refreshTtlSeconds), sessionExpiresAt);
      await repo.create(tx, { userId, tokenHash: hash, expiresAt: tokenExpiresAt, sessionExpiresAt });
      return tokenExpiresAt;
    });
    return { token: raw, expiresAt };
  }

  async refresh(presented: string): Promise<RefreshResult> {
    const { repo, actors, tokens, runTx, config, logger } = this.deps;
    const presentedHash = hashToken(presented);

    let outcome: Outcome;
    try {
      outcome = await runTx(async (tx): Promise<Outcome> => {
        const row = await repo.findByHash(tx, presentedHash);
        if (!row) return { kind: "invalid" };
        const now = await repo.now(tx);

        if (row.revokedAt) {
          if (!row.replacedById) return { kind: "revoked" };
          const secondsSinceRotation = (now.getTime() - row.revokedAt.getTime()) / 1000;
          if (secondsSinceRotation <= config.reuseGraceSeconds) return { kind: "recent-reuse" };
          const revoked = await repo.revokeChainFrom(tx, row.replacedById, now);
          return { kind: "replayed", userId: row.userId, revoked }; // returned, not thrown: the revocation must commit
        }

        if (row.expiresAt <= now || row.sessionExpiresAt <= now) {
          await repo.revokeChainFrom(tx, row.id, now); // an expired token ends its session (Decision #77)
          return { kind: "expired" };
        }

        // A deactivated / unverified / role-less account must not mint new access tokens (#51).
        // Throws ACCOUNT_INACTIVE or UNAUTHENTICATED; nothing has been written yet, so nothing to undo.
        await actors.load(row.userId);

        const next = mint();
        const expiresAt = earliest(addSeconds(now, config.refreshTtlSeconds), row.sessionExpiresAt);
        const created = await repo.create(tx, {
          userId: row.userId,
          tokenHash: next.hash,
          expiresAt,
          sessionExpiresAt: row.sessionExpiresAt, // inherited unchanged — the cap is never reset by a refresh
        });
        // The single-use guard. If a concurrent request already consumed this token, no row matches.
        if (!(await repo.markRotated(tx, row.id, created.id, now))) throw new RotationConflict();
        return {
          kind: "rotated",
          userId: row.userId,
          token: next.raw,
          expiresAt,
          maxAgeSeconds: Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
        };
      });
    } catch (err) {
      if (err instanceof RotationConflict) {
        throw Errors.conflict("The session was refreshed concurrently. Retry the request.");
      }
      throw err;
    }

    switch (outcome.kind) {
      case "rotated":
        return {
          accessToken: tokens.sign(outcome.userId),
          accessExpiresInSeconds: tokens.ttlSeconds,
          refreshToken: outcome.token,
          refreshExpiresAt: outcome.expiresAt,
          refreshMaxAgeSeconds: outcome.maxAgeSeconds,
        };
      case "recent-reuse":
        throw Errors.conflict("The session was refreshed concurrently. Retry the request.");
      case "replayed":
        logger.warn({ userId: outcome.userId, revokedTokens: outcome.revoked }, "refresh token reuse detected; session revoked");
        throw Errors.unauthenticated();
      default:
        throw Errors.unauthenticated(); // invalid | expired | revoked: deliberately indistinguishable
    }
  }

  /**
   * Logout ends the session the presented token belongs to: that token and everything after it in its rotation chain.
   * Revoking only the presented token would be wrong when it was rotated moments ago (e.g. a second tab): the live
   * session would survive a "successful" logout. Idempotent, and silent about whether the token was valid.
   */
  async logout(presented: string | undefined): Promise<void> {
    if (!presented) return;
    const hash = hashToken(presented);
    await this.deps.runTx(async (tx) => {
      const row = await this.deps.repo.findByHash(tx, hash);
      if (row) await this.deps.repo.revokeChainFrom(tx, row.id, await this.deps.repo.now(tx));
    });
  }

  /** For account deactivation and password reset (built in later slices): ends every session of a user (#51). */
  async revokeAllSessions(userId: string): Promise<number> {
    return this.deps.runTx(async (tx) => this.deps.repo.revokeAllForUser(tx, userId, await this.deps.repo.now(tx)));
  }
}
