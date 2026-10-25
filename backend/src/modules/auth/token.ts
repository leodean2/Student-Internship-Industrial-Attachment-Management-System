import jwt from "jsonwebtoken";
import { Errors } from "../../shared/errors";

/** Access-token lifetime from Decision #51 (15 minutes). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ALGORITHM = "HS256" as const;

export interface TokenService {
  /** Lifetime of tokens this service issues, in seconds. */
  readonly ttlSeconds: number;
  /** Issues an identity-only token: `sub` + `iat` + `exp`. No roles, no status, no profile data. */
  sign(userId: string): string;
  /** Verifies signature, algorithm and expiry; returns only the user id. */
  verify(token: string): { userId: string };
}

export function createTokenService(secret: string, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS): TokenService {
  return {
    ttlSeconds,
    sign(userId) {
      // Empty payload on purpose: authority comes from the database on every request (#51).
      return jwt.sign({}, secret, { algorithm: ALGORITHM, subject: userId, expiresIn: ttlSeconds });
    },

    verify(token) {
      let payload: jwt.JwtPayload | string;
      try {
        // Pin the algorithm: rejects `alg: none` and algorithm-confusion attempts.
        payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
      } catch (err) {
        if (err instanceof jwt.TokenExpiredError) throw Errors.tokenExpired();
        throw Errors.unauthenticated();
      }
      if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw Errors.unauthenticated();
      }
      return { userId: payload.sub };
    },
  };
}
