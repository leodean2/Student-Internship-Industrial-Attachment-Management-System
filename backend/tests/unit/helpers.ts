import { Writable } from "node:stream";
import type { UserRoleName, UserStatus } from "@prisma/client";
import { createApp } from "../../src/app";
import { createLogger } from "../../src/infrastructure/logger";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import type { ActorRecord, AuthRepository } from "../../src/modules/auth/auth.repository";
import { createTokenService } from "../../src/modules/auth/token";
import type { RefreshTokenRecord, RefreshTokenRepository } from "../../src/modules/auth/refresh-token.repository";
import { DEFAULT_SESSION_CONFIG, type CookieConfig, type SessionConfig } from "../../src/modules/auth/session.config";
import { SessionService } from "../../src/modules/auth/session.service";

export const SECRET = "test-secret-test-secret-test-secret-123456";
export const SYSTEM_ID = "00000000-0000-0000-0000-000000000001";

/** In-memory stand-in for the database; mutable so tests can change state between requests. */
export class FakeAuthRepository implements AuthRepository {
  readonly users = new Map<string, ActorRecord>();
  async findActorRecordById(userId: string): Promise<ActorRecord | null> {
    const u = this.users.get(userId);
    return u ? structuredClone(u) : null;
  }
  put(partial: Partial<ActorRecord> & { id: string }): ActorRecord {
    const rec: ActorRecord = {
      status: "ACTIVE",
      roles: [],
      studentProfileId: null,
      universitySupervisorProfileId: null,
      adminProfileId: null,
      organizationSupervisorProfiles: [],
      ...partial,
    };
    this.users.set(rec.id, rec);
    return rec;
  }
  setRoles(id: string, roles: UserRoleName[]) { this.users.get(id)!.roles = roles; }
  setStatus(id: string, status: UserStatus) { this.users.get(id)!.status = status; }
}

export function seededRepo(): FakeAuthRepository {
  const repo = new FakeAuthRepository();
  repo.put({ id: "stu", roles: ["STUDENT"], studentProfileId: "sp1" });
  repo.put({ id: "adm", roles: ["ADMIN"], adminProfileId: "ap1" });
  repo.put({
    id: "multi",
    roles: ["UNIVERSITY_SUPERVISOR", "ORGANIZATION_SUPERVISOR"],
    universitySupervisorProfileId: "usp1",
    organizationSupervisorProfiles: [
      { id: "osp-a", organizationId: "org-a" },
      { id: "osp-b", organizationId: "org-b" },
    ],
  });
  repo.put({ id: "deactivated", status: "DEACTIVATED", roles: ["STUDENT"], studentProfileId: "sp2" });
  repo.put({ id: "pending", status: "PENDING_VERIFICATION", roles: ["STUDENT"], studentProfileId: "sp3" });
  repo.put({ id: SYSTEM_ID, roles: [] }); // seeded sentinel: ACTIVE, but holds no role (#69)
  return repo;
}

/** Captures structured log output so tests can assert on what is (and is not) logged. */
export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
  });
  return { stream, lines, text: () => lines.join("") };
}

export function buildTestApp(repo = seededRepo(), opts: { corsOrigins?: string[]; cookie?: Partial<CookieConfig> } = {}) {
  const logs = captureLogs();
  const logger = createLogger("info", logs.stream);
  const tokens = createTokenService(SECRET);
  const actors = new ActorContextService(repo);
  const clock = new FakeClock();
  const tokenRepo = new FakeRefreshTokenRepository(clock);
  const sessions = buildSessionService(tokenRepo, actors, logger);
  const cookie = { ...COOKIE, ...opts.cookie };
  const app = createApp({ logger, corsOrigins: opts.corsOrigins ?? [ORIGIN], tokens, actors, sessions, cookie });
  return { app, repo, tokens, actors, logs, logger, sessions, tokenRepo, clock, cookie };
}

/** Returns the thrown value so tests can assert on its properties (code/status). */
export function caught(fn: () => unknown): any {
  try { fn(); } catch (e) { return e; }
  throw new Error("expected function to throw");
}
export async function caughtAsync(fn: () => Promise<unknown>): Promise<any> {
  try { await fn(); } catch (e) { return e; }
  throw new Error("expected promise to reject");
}

// ---------------------------------------------------------------------------------------------
// Refresh-token fakes. The fake has the same CONDITIONAL-WRITE semantics as the Prisma repository,
// but no real concurrency: concurrent behaviour is proven in the integration tests against PostgreSQL.
// `now()` is the fake "database clock" — the single time source, as in production (Decision #76).
// ---------------------------------------------------------------------------------------------
export class FakeClock {
  constructor(public now = new Date("2026-01-01T00:00:00Z")) {}
  get = () => new Date(this.now);
  advanceSeconds(s: number) { this.now = new Date(this.now.getTime() + s * 1000); }
}

export interface FakeTokenRow extends RefreshTokenRecord { tokenHash: string }

export class FakeRefreshTokenRepository implements RefreshTokenRepository {
  readonly rows = new Map<string, FakeTokenRow>();
  private seq = 0;
  constructor(readonly clock: FakeClock = new FakeClock()) {}
  async now(_tx: unknown) { return this.clock.get(); }
  async findByHash(_tx: unknown, tokenHash: string) {
    const r = [...this.rows.values()].find((x) => x.tokenHash === tokenHash);
    return r ? { ...r } : null;
  }
  async create(_tx: unknown, d: { userId: string; tokenHash: string; expiresAt: Date; sessionExpiresAt: Date }) {
    // mirrors the database CHECK (expiresAt <= sessionExpiresAt)
    if (d.expiresAt > d.sessionExpiresAt) throw new Error("check constraint ck_refresh_token_within_session");
    const id = `rt-${++this.seq}`;
    this.rows.set(id, { id, userId: d.userId, tokenHash: d.tokenHash, expiresAt: d.expiresAt, sessionExpiresAt: d.sessionExpiresAt, revokedAt: null, replacedById: null });
    return { id };
  }
  async markRotated(_tx: unknown, oldId: string, newId: string, now: Date) {
    const r = this.rows.get(oldId);
    if (!r || r.revokedAt !== null || r.expiresAt <= now) return false;
    r.revokedAt = now; r.replacedById = newId; return true;
  }
  async revoke(_tx: unknown, id: string, now: Date) {
    const r = this.rows.get(id);
    if (!r || r.revokedAt) return false;
    r.revokedAt = now; return true;
  }
  async revokeAllForUser(_tx: unknown, userId: string, now: Date) {
    let n = 0;
    for (const r of this.rows.values()) if (r.userId === userId && !r.revokedAt) { r.revokedAt = now; n++; }
    return n;
  }
  async revokeChainFrom(_tx: unknown, startId: string, now: Date) {
    let n = 0; let id: string | null = startId;
    while (id) { const r = this.rows.get(id); if (!r) break; if (!r.revokedAt) { r.revokedAt = now; n++; } id = r.replacedById; }
    return n;
  }
  /** Test convenience: a user's unrevoked tokens. */
  active(userId: string) { return [...this.rows.values()].filter((r) => r.userId === userId && !r.revokedAt); }
}

export const COOKIE: CookieConfig = { name: "refresh_token", path: "/api/v1/auth", sameSite: "strict", secure: true };
export const ORIGIN = "https://app.example.com";

export function buildSessionService(repo: FakeRefreshTokenRepository, actors: ActorContextService, logger = createLogger("silent"), config: SessionConfig = DEFAULT_SESSION_CONFIG) {
  return new SessionService({ repo, actors, tokens: createTokenService(SECRET), runTx: (fn) => fn(undefined as never), config, logger });
}
