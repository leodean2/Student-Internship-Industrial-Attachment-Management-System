export interface SessionConfig {
  /**
   * Lifetime of each refresh token, counted from the moment it is issued (Decision #51: ~7 days).
   * Because every rotation issues a fresh token, this is also the IDLE limit: a session unused for this long ends.
   */
  refreshTtlSeconds: number;
  /** Absolute session lifetime from the moment the session starts; never extended by rotation (Decision #77: 30 days). */
  absoluteSessionSeconds: number;
  /**
   * Replaying a token that was rotated at most this many seconds ago is treated as a benign race
   * (two tabs refreshing together) and answered with 409 — it does NOT revoke the session.
   * Replaying it later is treated as possible theft and revokes the live session.
   */
  reuseGraceSeconds: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  refreshTtlSeconds: 7 * 24 * 60 * 60,
  absoluteSessionSeconds: 30 * 24 * 60 * 60,
  reuseGraceSeconds: 10,
};

export interface CookieConfig {
  name: string;
  /** Scoped to the auth endpoints so the cookie is not sent with every API call. */
  path: string;
  /** Decision #55: Strict where deployment permits. Cross-site deployments need Lax/None (see README). */
  sameSite: "strict" | "lax" | "none";
  secure: boolean;
}
// Max-Age is not configured here: it is the remaining life of the specific token being issued (shorter near the session cap).
