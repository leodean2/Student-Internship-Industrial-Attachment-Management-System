import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { SECRET, SYSTEM_ID, buildTestApp } from "./helpers";

const bearer = (t: string) => `Bearer ${t}`;

describe("HTTP foundation", () => {
  it("serves /api/v1/health without authentication and sets a request id", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("applies security headers and does not advertise Express", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/v1/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows only listed CORS origins (strict allow-list, #55)", async () => {
    const { app } = buildTestApp();
    const ok = await request(app).get("/api/v1/health").set("Origin", "https://app.example.com");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const bad = await request(app).get("/api/v1/health").set("Origin", "https://evil.example.com");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns the uniform error body with a requestId matching the response header", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: "UNAUTHENTICATED", message: expect.any(String), requestId: res.headers["x-request-id"] },
    });
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 VALIDATION_ERROR for malformed JSON", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/v1/health").set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("authentication via GET /api/v1/auth/me (Decision #51)", () => {
  it.each([
    ["no Authorization header", undefined],
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
    ["Bearer with no token", "Bearer"],
    ["extra segments", "Bearer a b"],
    ["a garbage token", "Bearer not.a.jwt"],
  ])("rejects %s with 401 UNAUTHENTICATED", async (_label, header) => {
    const { app } = buildTestApp();
    const req = request(app).get("/api/v1/auth/me");
    if (header) req.set("Authorization", header);
    const res = await req;
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns 401 TOKEN_EXPIRED for an expired token", async () => {
    const { app } = buildTestApp();
    const expired = jwt.sign({}, SECRET, { algorithm: "HS256", subject: "stu", expiresIn: -5 });
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("returns the ActorContext for a valid token", async () => {
    const { app, tokens } = buildTestApp();
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(tokens.sign("stu")));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: "stu",
      status: "ACTIVE",
      roles: ["STUDENT"],
      profileIds: { student: "sp1", organizationSupervisor: [] },
    });
  });

  it("ignores roles claimed inside the token — authority comes from the database", async () => {
    const { app } = buildTestApp();
    const forged = jwt.sign({ roles: ["ADMIN"], status: "ACTIVE" }, SECRET, { algorithm: "HS256", subject: "stu", expiresIn: 60 });
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(forged));
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["STUDENT"]);
  });

  it("applies a role change on the very next request with the same token", async () => {
    const { app, repo, tokens } = buildTestApp();
    const auth = bearer(tokens.sign("stu"));
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).body.roles).toEqual(["STUDENT"]);
    repo.setRoles("stu", ["STUDENT", "ADMIN"]);
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).body.roles).toEqual(["ADMIN", "STUDENT"]);
    repo.setRoles("stu", ["STUDENT"]); // admin role removed: an old token must not keep administrative authority
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).body.roles).toEqual(["STUDENT"]);
  });

  it("blocks a deactivated account immediately, even with an unexpired token", async () => {
    const { app, repo, tokens } = buildTestApp();
    const auth = bearer(tokens.sign("stu"));
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).status).toBe(200);
    repo.setStatus("stu", "DEACTIVATED");
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", auth);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("rejects an account that has not been verified", async () => {
    const { app, tokens } = buildTestApp();
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(tokens.sign("pending")));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("rejects the SYSTEM sentinel even with a validly signed token (#69), same response as an unknown user", async () => {
    const { app, tokens } = buildTestApp();
    const sys = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(tokens.sign(SYSTEM_ID)));
    const ghost = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(tokens.sign("ghost")));
    expect(sys.status).toBe(401);
    expect(sys.body.error.code).toBe("UNAUTHENTICATED");
    expect(sys.body.error.code).toBe(ghost.body.error.code);
    expect(sys.body.error.message).toBe(ghost.body.error.message);
  });

  it("exposes multi-role users with every affiliation", async () => {
    const { app, tokens } = buildTestApp();
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(tokens.sign("multi")));
    expect(res.body.roles).toEqual(["ORGANIZATION_SUPERVISOR", "UNIVERSITY_SUPERVISOR"]);
    expect(res.body.profileIds.organizationSupervisor).toHaveLength(2);
  });
});

describe("logging never-log rules (Decision #55)", () => {
  it("logs requestId, method, route, status, duration and userId — but never the bearer token", async () => {
    const { app, tokens, logs } = buildTestApp();
    const token = tokens.sign("stu");
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(token));
    const text = logs.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("Bearer");
    const entry = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === "request completed");
    expect(entry).toMatchObject({
      requestId: res.headers["x-request-id"], method: "GET", status: 200, userId: "stu",
      roles: ["STUDENT"], path: "/api/v1/auth/me",
    });
    expect(entry.errorCode).toBeUndefined();
    expect(typeof entry.durationMs).toBe("number");
  });

  it("logs the FULL path and the error code for rejected requests (regression: baseUrl was lost on error paths)", async () => {
    const { app, logs } = buildTestApp();
    await request(app).get("/api/v1/auth/me");
    const entry = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === "request completed");
    expect(entry).toMatchObject({ method: "GET", path: "/api/v1/auth/me", status: 401, errorCode: "UNAUTHENTICATED" });
    expect(entry.userId).toBeUndefined();
  });

  it("logs the path of unknown routes with NOT_FOUND", async () => {
    const { app, logs } = buildTestApp();
    await request(app).get("/api/v1/nope");
    const entry = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === "request completed");
    expect(entry).toMatchObject({ path: "/api/v1/nope", status: 404, errorCode: "NOT_FOUND" });
  });

  it("strips the query string so secrets in URLs never reach the logs", async () => {
    const { app, logs } = buildTestApp();
    await request(app).get("/api/v1/health?token=super-secret-123&email=a@b.c");
    expect(logs.text()).not.toContain("super-secret-123");
    expect(logs.text()).not.toContain("a@b.c");
    const entry = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === "request completed");
    expect(entry.path).toBe("/api/v1/health");
  });

  it("redacts credential fields if a developer logs a whole object by mistake", () => {
    const { logger, logs } = buildTestApp();
    logger.info({ user: { password: "hunter2", passwordHash: "$2b$12$abc", refreshToken: "r-tok", name: "Ann" } }, "oops");
    const text = logs.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("$2b$12$abc");
    expect(text).not.toContain("r-tok");
    expect(text).toContain("Ann");
  });
});
