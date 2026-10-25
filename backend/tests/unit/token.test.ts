import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { createTokenService } from "../../src/modules/auth/token";
import { SECRET, caught } from "./helpers";

const tokens = createTokenService(SECRET);

describe("access token service (Decision #51)", () => {
  it("round-trips the user id", () => {
    expect(tokens.verify(tokens.sign("user-1"))).toEqual({ userId: "user-1" });
  });

  it("carries identity only: sub, iat, exp — no roles, status or profile data", () => {
    const payload = jwt.decode(tokens.sign("user-1")) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "sub"]);
  });

  it("expires after 15 minutes", () => {
    const p = jwt.decode(tokens.sign("u")) as { iat: number; exp: number };
    expect(p.exp - p.iat).toBe(15 * 60);
  });

  it("returns TOKEN_EXPIRED (401) for an expired token", () => {
    const expired = createTokenService(SECRET, -10).sign("u");
    const err = caught(() => tokens.verify(expired));
    expect(err).toMatchObject({ status: 401, code: "TOKEN_EXPIRED" });
  });

  it("rejects a token signed with a different secret", () => {
    const forged = createTokenService("another-secret-another-secret-another-123").sign("u");
    expect(caught(() => tokens.verify(forged))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("rejects a tampered payload", () => {
    const [h, , s] = tokens.sign("victim").split(".");
    const evilPayload = Buffer.from(JSON.stringify({ sub: "admin", exp: 9999999999 })).toString("base64url");
    expect(caught(() => tokens.verify(`${h}.${evilPayload}.${s}`))).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects an unsigned (alg: none) token", () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "admin" })}.`;
    expect(caught(() => tokens.verify(unsigned))).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a token using a different algorithm even with the right secret (algorithm is pinned)", () => {
    const hs512 = jwt.sign({}, SECRET, { algorithm: "HS512", subject: "u", expiresIn: 60 });
    expect(caught(() => tokens.verify(hs512))).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a validly signed token with no subject", () => {
    const noSub = jwt.sign({}, SECRET, { algorithm: "HS256", expiresIn: 60 });
    expect(caught(() => tokens.verify(noSub))).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects garbage", () => {
    expect(caught(() => tokens.verify("not-a-jwt"))).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(caught(() => tokens.verify(""))).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
