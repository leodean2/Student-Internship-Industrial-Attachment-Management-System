import request from "supertest";
import { describe, expect, it } from "vitest";
import { ORIGIN, buildTestApp } from "./helpers";

const cookieOf = (token: string) => `refresh_token=${token}`;
const setCookies = (res: request.Response): string[] => (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];

async function session(opts: Parameters<typeof buildTestApp>[1] = {}, user = "stu") {
  const ctx = buildTestApp(undefined, opts);
  const { token } = await ctx.sessions.startSession(user);
  return { ...ctx, token };
}

describe("POST /api/v1/auth/refresh", () => {
  it("rejects a missing or foreign Origin with 403 — and does not consume the token", async () => {
    const { app, token } = await session();
    for (const origin of [undefined, "https://evil.example.com"]) {
      const req = request(app).post("/api/v1/auth/refresh").set("Cookie", cookieOf(token));
      if (origin) req.set("Origin", origin);
      const res = await req;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
    const ok = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(ok.status).toBe(200); // token was untouched by the rejected attempts
  });

  it("is POST-only", async () => {
    const { app, token } = await session();
    const res = await request(app).get("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(res.status).toBe(404);
  });

  it("returns 401 when there is no refresh cookie", async () => {
    const { app } = await session();
    const res = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rotates: returns an access token in the body and a NEW refresh token in an httpOnly cookie", async () => {
    const { app, token } = await session();
    const res = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: expect.any(String), tokenType: "Bearer", expiresIn: 900 });
    expect(res.headers["cache-control"]).toBe("no-store");
    const [c] = setCookies(res);
    expect(c).toMatch(/^refresh_token=[A-Za-z0-9_-]{43,};/);
    expect(c).not.toContain(token);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/v1/auth", "Max-Age=604800"]) expect(c).toContain(attr);
    // the new access token authenticates
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe("stu");
  });

  it("honours the configured cookie attributes (SameSite, Secure)", async () => {
    const cross = await session({ cookie: { sameSite: "none", secure: true } });
    const a = await request(cross.app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(cross.token));
    expect(setCookies(a)[0]).toContain("SameSite=None");
    const dev = await session({ cookie: { sameSite: "lax", secure: false } });
    const b = await request(dev.app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(dev.token));
    expect(setCookies(b)[0]).toContain("SameSite=Lax");
    expect(setCookies(b)[0]).not.toContain("Secure");
  });

  it("a replay inside the grace window is 409 and does NOT clear the cookie (it could delete the winner's new one)", async () => {
    const { app, token } = await session();
    await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    const res = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(setCookies(res)).toHaveLength(0);
  });

  it("a replay after the grace window is 401 and clears the dead cookie", async () => {
    const { app, token, clock } = await session();
    await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    clock.advanceSeconds(11);
    const res = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(res.status).toBe(401);
    expect(setCookies(res)[0]).toMatch(/refresh_token=;.*Max-Age=0/);
  });

  it("an invalid token is 401 and clears the cookie; a deactivated account gets ACCOUNT_INACTIVE", async () => {
    const { app, repo, token } = await session();
    const bad = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf("garbage"));
    expect(bad.status).toBe(401);
    expect(setCookies(bad)[0]).toContain("Max-Age=0");
    repo.setStatus("stu", "DEACTIVATED");
    const res = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("the cookie's Max-Age is the remaining life of that token, so it shrinks near the session cap", async () => {
    const { app, token, clock } = await session();
    let current = token;
    for (const days of [6, 6, 6, 6]) {
      clock.advanceSeconds(days * 86400);
      const r = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(current));
      expect(r.status).toBe(200);
      current = /refresh_token=([^;]+)/.exec(setCookies(r)[0]!)![1]!;
      if (days === 6 && clock.now.getTime() - new Date("2026-01-01T00:00:00Z").getTime() >= 24 * 86400 * 1000) {
        expect(setCookies(r)[0]).toContain(`Max-Age=${6 * 86400}`); // day 24: only 6 days of session remain
      }
    }
  });

  it("replays inside the grace window never yield a token or a cookie, however many times they are sent", async () => {
    const { app, token } = await session();
    await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
      expect(r.status).toBe(409);
      expect(r.body.accessToken).toBeUndefined();
      expect(setCookies(r)).toHaveLength(0);
    }
  });

  it("never writes the refresh token or the cookie header to the logs", async () => {
    const { app, token, logs } = await session();
    const res = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    const newToken = /refresh_token=([^;]+)/.exec(setCookies(res)[0]!)![1]!;
    expect(logs.text()).not.toContain(token);
    expect(logs.text()).not.toContain(newToken);
    expect(logs.text().toLowerCase()).not.toContain("cookie");
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("revokes the session, clears the cookie and returns 204", async () => {
    const { app, token } = await session();
    const out = await request(app).post("/api/v1/auth/logout").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(out.status).toBe(204);
    expect(setCookies(out)[0]).toMatch(/refresh_token=;.*Max-Age=0/);
    const after = await request(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", cookieOf(token));
    expect(after.status).toBe(401);
  });

  it("is idempotent without a cookie, but still enforces the Origin check", async () => {
    const { app } = await session();
    expect((await request(app).post("/api/v1/auth/logout").set("Origin", ORIGIN)).status).toBe(204);
    expect((await request(app).post("/api/v1/auth/logout")).status).toBe(403);
  });
});
