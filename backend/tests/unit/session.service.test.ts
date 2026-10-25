import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/infrastructure/logger";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import { hashToken } from "../../src/modules/auth/session.service";
import { FakeClock, FakeRefreshTokenRepository, SECRET, buildSessionService, captureLogs, caughtAsync, seededRepo } from "./helpers";

function setup() {
  const users = seededRepo();
  const clock = new FakeClock();
  const tokenRepo = new FakeRefreshTokenRepository(clock);
  const logs = captureLogs();
  const svc = buildSessionService(tokenRepo, new ActorContextService(users), createLogger("info", logs.stream));
  return { users, tokenRepo, clock, logs, svc };
}
const WEEK = 7 * 24 * 3600;
const DAY = 24 * 3600;
const SESSION = 30 * DAY;

describe("session start", () => {
  it("stores only the SHA-256 hash of the refresh token, never the raw value", async () => {
    const { svc, tokenRepo, clock } = setup();
    const { token, expiresAt } = await svc.startSession("stu");
    const [row] = [...tokenRepo.rows.values()];
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify([...tokenRepo.rows.values()])).not.toContain(token);
    expect(expiresAt.getTime() - clock.now.getTime()).toBe(WEEK * 1000);
    expect(token.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
  });
});

describe("rotation (Decision #51/#55: single use, replace on every use)", () => {
  it("issues a new access token + a new refresh token and marks the old one rotated", async () => {
    const { svc, tokenRepo, clock } = setup();
    const { token } = await svc.startSession("stu");
    clock.advanceSeconds(60);
    const r = await svc.refresh(token);

    expect(jwt.verify(r.accessToken, SECRET, { algorithms: ["HS256"] })).toMatchObject({ sub: "stu" });
    expect(r.accessExpiresInSeconds).toBe(900);
    expect(r.refreshToken).not.toBe(token);
    expect(r.refreshExpiresAt.getTime() - clock.now.getTime()).toBe(WEEK * 1000);

    const rows = [...tokenRepo.rows.values()];
    expect(rows).toHaveLength(2);
    const old = rows.find((x) => x.tokenHash === hashToken(token))!;
    const next = rows.find((x) => x.tokenHash === hashToken(r.refreshToken))!;
    expect(old.revokedAt).toEqual(clock.now);
    expect(old.replacedById).toBe(next.id);
    expect(next.revokedAt).toBeNull();
    expect(tokenRepo.active("stu")).toHaveLength(1);
  });

  it("allows continuous rotation through a chain", async () => {
    const { svc, clock } = setup();
    let { token } = await svc.startSession("stu");
    for (let i = 0; i < 5; i++) { clock.advanceSeconds(900); token = (await svc.refresh(token)).refreshToken; }
    expect((await svc.refresh(token)).refreshToken).toBeTruthy();
  });

  it("replaying a just-rotated token (inside the grace window) is a 409 and revokes NOTHING", async () => {
    const { svc, tokenRepo } = setup();
    const { token } = await svc.startSession("stu");
    const first = await svc.refresh(token);
    const err = await caughtAsync(() => svc.refresh(token)); // e.g. a second tab, a moment later
    expect(err).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(tokenRepo.active("stu")).toHaveLength(1);
    expect((await svc.refresh(first.refreshToken)).refreshToken).toBeTruthy(); // winner's session still works
  });

  it("replaying a rotated token AFTER the grace window is 401 and revokes the live session", async () => {
    const { svc, tokenRepo, clock, logs } = setup();
    const { token } = await svc.startSession("stu");
    const live = await svc.refresh(token);
    clock.advanceSeconds(11);
    const err = await caughtAsync(() => svc.refresh(token)); // stolen-token replay
    expect(err).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(tokenRepo.active("stu")).toHaveLength(0);
    expect(await caughtAsync(() => svc.refresh(live.refreshToken))).toMatchObject({ status: 401 });
    const warn = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg.includes("reuse detected"));
    expect(warn).toMatchObject({ userId: "stu", revokedTokens: 1 });
    expect(logs.text()).not.toContain(token);
    expect(logs.text()).not.toContain(live.refreshToken);
  });

  it("replaying the OLDEST token of a long chain revokes every descendant", async () => {
    const { svc, tokenRepo, clock } = setup();
    const { token: t0 } = await svc.startSession("stu");
    let t = t0;
    for (let i = 0; i < 4; i++) { clock.advanceSeconds(60); t = (await svc.refresh(t)).refreshToken; }
    expect(tokenRepo.active("stu")).toHaveLength(1);
    clock.advanceSeconds(60);
    await caughtAsync(() => svc.refresh(t0));
    expect(tokenRepo.active("stu")).toHaveLength(0);
    expect([...tokenRepo.rows.values()].every((r) => r.revokedAt)).toBe(true);
  });

  it("a replay revokes only that session family — other sessions of the user and other users are untouched", async () => {
    const { svc, tokenRepo, clock } = setup();
    const a = await svc.startSession("stu");
    const b = await svc.startSession("stu"); // a second device
    const other = await svc.startSession("adm");
    const aLive = await svc.refresh(a.token);
    clock.advanceSeconds(60);
    await caughtAsync(() => svc.refresh(a.token));
    expect(tokenRepo.active("stu")).toHaveLength(1); // device b survives
    expect(tokenRepo.active("adm")).toHaveLength(1);
    expect((await svc.refresh(b.token)).refreshToken).toBeTruthy();
    expect((await svc.refresh(other.token)).refreshToken).toBeTruthy();
    expect(await caughtAsync(() => svc.refresh(aLive.refreshToken))).toMatchObject({ status: 401 });
  });
});

describe("failures are uniform 401s", () => {
  it.each(["unknown token", "", "x".repeat(200)])("rejects %j", async (t) => {
    const { svc } = setup();
    expect(await caughtAsync(() => svc.refresh(t))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("rejects an expired token", async () => {
    const { svc, clock } = setup();
    const { token } = await svc.startSession("stu");
    clock.advanceSeconds(WEEK + 1);
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("an expired, an unknown and an explicitly-revoked token give the same error body", async () => {
    const { svc, clock } = setup();
    const expired = await svc.startSession("stu"); clock.advanceSeconds(WEEK + 1);
    const revoked = await svc.startSession("stu"); await svc.logout(revoked.token);
    const msgs = await Promise.all([expired.token, revoked.token, "nope"].map(async (t) => (await caughtAsync(() => svc.refresh(t))).message));
    expect(new Set(msgs).size).toBe(1);
  });

  it("a logged-out token is rejected and does not touch the user's other sessions", async () => {
    const { svc, tokenRepo } = setup();
    const a = await svc.startSession("stu"); const b = await svc.startSession("stu");
    await svc.logout(a.token);
    expect(await caughtAsync(() => svc.refresh(a.token))).toMatchObject({ status: 401 });
    expect(tokenRepo.active("stu")).toHaveLength(1);
    expect((await svc.refresh(b.token)).refreshToken).toBeTruthy();
  });

  it("refuses to refresh for a deactivated account and does NOT rotate the token", async () => {
    const { svc, users, tokenRepo } = setup();
    const { token } = await svc.startSession("stu");
    users.setStatus("stu", "DEACTIVATED");
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401, code: "ACCOUNT_INACTIVE" });
    expect(tokenRepo.rows.size).toBe(1);
    expect([...tokenRepo.rows.values()][0]!.replacedById).toBeNull();
  });

  it("refuses the SYSTEM sentinel even if it somehow holds a refresh token", async () => {
    const { svc } = setup();
    const { token } = await svc.startSession("00000000-0000-0000-0000-000000000001");
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });
});

describe("logout and mass revocation (Decision #51)", () => {
  it("logout is idempotent and silent about unknown or missing tokens", async () => {
    const { svc } = setup();
    await expect(svc.logout(undefined)).resolves.toBeUndefined();
    await expect(svc.logout("never-issued")).resolves.toBeUndefined();
    const { token } = await svc.startSession("stu");
    await svc.logout(token); await svc.logout(token);
  });

  it("logout with a token that was rotated moments ago still ends the LIVE session (second-tab case)", async () => {
    const { svc, tokenRepo } = setup();
    const { token: stale } = await svc.startSession("stu");
    const live = await svc.refresh(stale); // another tab rotated it first
    await svc.logout(stale);
    expect(tokenRepo.active("stu")).toHaveLength(0);
    expect(await caughtAsync(() => svc.refresh(live.refreshToken))).toMatchObject({ status: 401 });
  });

  it("logout ends only the session it belongs to, not the user's other devices", async () => {
    const { svc, tokenRepo } = setup();
    const a = await svc.startSession("stu"); const b = await svc.startSession("stu");
    await svc.logout(a.token);
    expect(tokenRepo.active("stu")).toHaveLength(1);
    expect((await svc.refresh(b.token)).refreshToken).toBeTruthy();
  });

  it("revokeAllSessions ends every session of one user and nobody else's", async () => {
    const { svc, tokenRepo } = setup();
    await svc.startSession("stu"); await svc.startSession("stu"); await svc.startSession("adm");
    expect(await svc.revokeAllSessions("stu")).toBe(2);
    expect(tokenRepo.active("stu")).toHaveLength(0);
    expect(tokenRepo.active("adm")).toHaveLength(1);
    expect(await svc.revokeAllSessions("stu")).toBe(0);
  });
});

describe("the old token can never refresh successfully a second time (Decision #76 clarification)", () => {
  it("every replay inside the grace window is a 409 that issues nothing and creates no tokens", async () => {
    const { svc, tokenRepo, clock } = setup();
    const { token } = await svc.startSession("stu");
    await svc.refresh(token);
    const rowsAfterWin = tokenRepo.rows.size;
    for (let i = 0; i < 10; i++) {
      clock.advanceSeconds(0.9); // 9 s in total — still inside the window
      expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 409 });
    }
    expect(tokenRepo.rows.size).toBe(rowsAfterWin);
    expect(tokenRepo.active("stu")).toHaveLength(1);
  });

  it("the window is measured from the recorded ROTATION time, not from when the token was issued", async () => {
    const { svc, clock } = setup();
    const { token } = await svc.startSession("stu");
    clock.advanceSeconds(3 * DAY); // an old token, long after issue...
    await svc.refresh(token);      // ...rotated just now
    clock.advanceSeconds(5);
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 409 }); // 5 s after rotation: grace
    clock.advanceSeconds(6);
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401 }); // 11 s after rotation: theft
  });

  it("the boundary is inclusive at exactly 10 s and strict after it", async () => {
    const a = setup(); const ta = (await a.svc.startSession("stu")).token; await a.svc.refresh(ta);
    a.clock.advanceSeconds(10);
    expect(await caughtAsync(() => a.svc.refresh(ta))).toMatchObject({ status: 409 });
    const b = setup(); const tb = (await b.svc.startSession("stu")).token; await b.svc.refresh(tb);
    b.clock.advanceSeconds(10.001);
    expect(await caughtAsync(() => b.svc.refresh(tb))).toMatchObject({ status: 401 });
  });
});

describe("absolute session lifetime (Decision #77)", () => {
  it("starts a 30-day session whose first token lasts 7 days", async () => {
    const { svc, tokenRepo, clock } = setup();
    await svc.startSession("stu");
    const [row] = [...tokenRepo.rows.values()];
    expect(row!.sessionExpiresAt.getTime() - clock.now.getTime()).toBe(SESSION * 1000);
    expect(row!.expiresAt.getTime() - clock.now.getTime()).toBe(WEEK * 1000);
  });

  it("every token in a rotation chain carries the SAME session deadline — rotation never resets it", async () => {
    const { svc, tokenRepo, clock } = setup();
    let { token } = await svc.startSession("stu");
    const deadline = [...tokenRepo.rows.values()][0]!.sessionExpiresAt.getTime();
    for (let i = 0; i < 4; i++) { clock.advanceSeconds(5 * DAY); token = (await svc.refresh(token)).refreshToken; }
    const rows = [...tokenRepo.rows.values()];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.sessionExpiresAt.getTime()))).toEqual(new Set([deadline]));
  });

  it("a token issued near the cap expires AT the cap, not 7 days later", async () => {
    const { svc, tokenRepo, clock } = setup();
    let { token } = await svc.startSession("stu");
    for (const days of [6, 6, 6, 5]) { clock.advanceSeconds(days * DAY); token = (await svc.refresh(token)).refreshToken; } // day 23
    clock.advanceSeconds(DAY);                                                     // day 24
    const last = await svc.refresh(token);                                          // 6 days of session left
    const row = [...tokenRepo.rows.values()].find((r) => !r.revokedAt)!;
    expect(row.expiresAt.getTime()).toBe(row.sessionExpiresAt.getTime());
    expect(last.refreshMaxAgeSeconds).toBe(6 * DAY); // the cookie lives exactly as long as the token
  });

  it("a session refreshed every 6 days still ends at day 30", async () => {
    const { svc, clock } = setup();
    let { token } = await svc.startSession("stu");
    for (const day of [6, 12, 18, 24]) { clock.advanceSeconds(6 * DAY); token = (await svc.refresh(token)).refreshToken; expect(clock.now.getTime() - new Date("2026-01-01T00:00:00Z").getTime()).toBe(day * DAY * 1000); }
    clock.advanceSeconds(6 * DAY); // day 30 = the deadline
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("an expired session is ended: the token is revoked and cannot be retried", async () => {
    const { svc, tokenRepo, clock } = setup();
    const { token } = await svc.startSession("stu");
    clock.advanceSeconds(WEEK + 1); // idle for longer than the 7-day token lifetime
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401 });
    expect(tokenRepo.active("stu")).toHaveLength(0);
  });

  it("the per-token lifetime is also the idle limit: a session left alone for 7 days ends", async () => {
    const { svc, clock } = setup();
    let { token } = await svc.startSession("stu");
    clock.advanceSeconds(2 * DAY); token = (await svc.refresh(token)).refreshToken;
    clock.advanceSeconds(WEEK + 1); // no activity for more than 7 days, well inside the 30-day cap
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401 });
  });

  it("defence in depth: a token whose own expiry somehow outlives its session is still refused after the session deadline", async () => {
    const { svc, tokenRepo, clock } = setup();
    const { token } = await svc.startSession("stu");
    // Simulate corruption the database CHECK normally forbids (e.g. a bad manual data fix): expiry beyond the deadline.
    const row = [...tokenRepo.rows.values()][0]!;
    row.expiresAt = new Date(row.sessionExpiresAt.getTime() + 10 * DAY * 1000);
    clock.advanceSeconds(SESSION + 1); // past the session deadline, but the token's own expiry is still in the future
    expect(await caughtAsync(() => svc.refresh(token))).toMatchObject({ status: 401 });
    expect(tokenRepo.active("stu")).toHaveLength(0);
  });

  it("sessions are independent: each has its own deadline, and one ending does not end another", async () => {
    const { svc, tokenRepo, clock } = setup();
    const a = await svc.startSession("stu");
    clock.advanceSeconds(20 * DAY);
    const b = await svc.startSession("stu"); // started 20 days later
    const rows = [...tokenRepo.rows.values()];
    expect(rows[1]!.sessionExpiresAt.getTime() - rows[0]!.sessionExpiresAt.getTime()).toBe(20 * DAY * 1000);
    expect(await caughtAsync(() => svc.refresh(a.token))).toMatchObject({ status: 401 }); // a's 7-day token expired
    expect((await svc.refresh(b.token)).refreshToken).toBeTruthy();
  });
});
