import express from "express";
import request from "supertest";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createAuthenticate, requireRole } from "../../src/modules/auth/auth.middleware";
import { errorHandler, notFoundHandler } from "../../src/shared/http/error-handler";
import { requestContext } from "../../src/shared/http/request-context";
import { buildTestApp } from "./helpers";

/** A throwaway app that wires the real middleware around probe routes. */
function probeApp() {
  const ctx = buildTestApp();
  const authenticate = createAuthenticate({ tokens: ctx.tokens, actors: ctx.actors });
  const app = express();
  app.use(requestContext(ctx.logger));
  app.use(express.json());
  app.get("/admin-only", authenticate, requireRole("ADMIN"), (_req, res) => { res.json({ ok: true }); });
  app.get("/either", authenticate, requireRole("ADMIN", "ORGANIZATION_SUPERVISOR"), (_req, res) => { res.json({ ok: true }); });
  app.get("/guard-without-authenticate", requireRole("ADMIN"), (_req, res) => { res.json({ ok: true }); });
  app.get("/boom", () => { throw new Error("secret internal detail: db password is hunter2"); });
  app.get("/async-boom", async () => { throw new Error("secret async detail"); });
  app.post("/validate", (req) => { z.object({ email: z.string().email() }).parse(req.body); });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { ...ctx, app };
}

/** A3: protected route with a handler spy, to prove denied requests never reach the handler. */
function studentProbeApp() {
  const ctx = buildTestApp();
  const authenticate = createAuthenticate({ tokens: ctx.tokens, actors: ctx.actors });
  const handler = vi.fn((_req: express.Request, res: express.Response) => { res.json({ ok: true }); });
  const app = express();
  app.use(requestContext(ctx.logger));
  app.get("/student-only", authenticate, requireRole("STUDENT"), handler);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { ...ctx, app, handler };
}
const bearer = (t: string) => `Bearer ${t}`;

describe("requireRole — coarse role guard (Decision #50)", () => {
  it("returns 403 FORBIDDEN when the actor lacks the role", async () => {
    const { app, tokens } = probeApp();
    const res = await request(app).get("/admin-only").set("Authorization", bearer(tokens.sign("stu")));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("allows an actor holding the role", async () => {
    const { app, tokens } = probeApp();
    const res = await request(app).get("/admin-only").set("Authorization", bearer(tokens.sign("adm")));
    expect(res.status).toBe(200);
  });

  it("is any-of: a multi-role user needs only one matching role", async () => {
    const { app, tokens } = probeApp();
    const res = await request(app).get("/either").set("Authorization", bearer(tokens.sign("multi")));
    expect(res.status).toBe(200);
  });

  it("answers 401 (not 403) when no actor has been established", async () => {
    const { app } = probeApp();
    const res = await request(app).get("/guard-without-authenticate");
    expect(res.status).toBe(401);
  });

  it("authentication failures take precedence over role checks", async () => {
    const { app } = probeApp();
    const res = await request(app).get("/admin-only");
    expect(res.status).toBe(401);
  });
});

describe("error handling (Decision #55)", () => {
  it("returns 500 with a generic message and leaks no internal detail", async () => {
    const { app } = probeApp();
    for (const path of ["/boom", "/async-boom"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
      expect(res.body.error.message).toBe("An unexpected error occurred.");
      expect(JSON.stringify(res.body)).not.toMatch(/secret|hunter2|stack|at /i);
    }
  });

  it("logs the real error server-side with the request id", async () => {
    const { app, logs } = probeApp();
    const res = await request(app).get("/boom");
    const entry = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === "unhandled error");
    expect(entry.requestId).toBe(res.headers["x-request-id"]);
    expect(entry.err.message).toContain("secret internal detail");
  });

  it("maps Zod failures to 400 with field paths and messages — never the submitted values", async () => {
    const { app } = probeApp();
    const res = await request(app).post("/validate").send({ email: "super-secret-not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toEqual([{ path: "email", message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-not-an-email");
  });
});

describe("A3: protected student route — handler spy (C1-E)", () => {
  it("pending and deactivated students are denied before the handler runs", async () => {
    const { app, tokens, handler } = studentProbeApp();
    const pending = await request(app).get("/student-only").set("Authorization", `Bearer ${tokens.sign("pending")}`);
    expect(pending.status).toBe(401);
    expect(pending.body.error.code).toBe("ACCOUNT_INACTIVE");

    const deactivated = await request(app).get("/student-only").set("Authorization", `Bearer ${tokens.sign("deactivated")}`);
    expect(deactivated.status).toBe(401);
    expect(deactivated.body.error.code).toBe("ACCOUNT_INACTIVE");

    expect(handler).not.toHaveBeenCalled();
  });

  it("an active student gets through; an active non-student gets 403", async () => {
    const { app, tokens, handler } = studentProbeApp();
    const stu = await request(app).get("/student-only").set("Authorization", `Bearer ${tokens.sign("stu")}`);
    expect(stu.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    const adm = await request(app).get("/student-only").set("Authorization", `Bearer ${tokens.sign("adm")}`);
    expect(adm.status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1); // handler not called for the 403
  });
});
