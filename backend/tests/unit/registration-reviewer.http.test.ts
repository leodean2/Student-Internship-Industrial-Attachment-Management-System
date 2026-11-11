import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { ReviewerAssignment } from "../../src/modules/registration-reviewer/registration-reviewer.repository";
import type { RegistrationReviewerService } from "../../src/modules/registration-reviewer/registration-reviewer.service";
import { buildTestApp } from "./helpers";

const PATH = "/api/v1/admin/registration-reviewers";

function build() {
  const ctx = buildTestApp();
  const assignment: ReviewerAssignment = {
    id: "c1d10000-0000-4000-8000-000000000001",
    userId: "7d2b8c1e-3f4a-4b5c-8d6e-9f0a1b2c3d4e",
    departmentCode: "CIT",
    grantedByUserId: "adm",
    grantedAt: new Date("2026-11-09T10:00:00.000Z"),
    revokedAt: null,
    revokedByUserId: null,
  };
  const service = {
    grant: vi.fn(async () => assignment),
    list: vi.fn(async () => [assignment]),
    revoke: vi.fn(async () => undefined),
  } as unknown as RegistrationReviewerService;
  const app = createApp({
    logger: ctx.logger,
    corsOrigins: ["https://app.example.test"],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    registrationReviewers: service,
  });
  const as = (userId: string) => ({ Authorization: `Bearer ${ctx.tokens.sign(userId)}` });
  return { app, as, service, assignment };
}

describe("admin registration-reviewer routes", () => {
  it("authenticates and restricts grant/list/revoke operations to admins", async () => {
    const { app, as, service, assignment } = build();
    expect((await request(app).post(PATH).send({})).status).toBe(401);
    expect((await request(app).post(PATH).set(as("stu")).send({})).status).toBe(403);

    const created = await request(app)
      .post(PATH)
      .set(as("adm"))
      .send({ userId: assignment.userId, departmentCode: " cit " });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: assignment.id,
      userId: assignment.userId,
      departmentCode: "CIT",
      grantedByUserId: "adm",
      grantedAt: assignment.grantedAt.toISOString(),
      revokedAt: null,
    });
    expect(service.grant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "adm" }),
      { userId: assignment.userId, departmentCode: "CIT" },
    );

    const listed = await request(app).get(`${PATH}?active=true`).set(as("adm"));
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ userId: "adm" }), {
      active: true,
      limit: 50,
    });
    expect(listed.body.nextCursor).toBeNull();

    const revoked = await request(app).delete(`${PATH}/${assignment.id}`).set(as("adm"));
    expect(revoked.status).toBe(204);
    expect(service.revoke).toHaveBeenCalledWith(expect.objectContaining({ userId: "adm" }), assignment.id);
  });

  it("validates request bodies and assignment ids", async () => {
    const { app, as, service } = build();
    expect((await request(app).post(PATH).set(as("adm")).send({ userId: "bad", departmentCode: "CIT" })).status).toBe(
      400,
    );
    expect((await request(app).delete(`${PATH}/bad`).set(as("adm"))).status).toBe(400);
    expect(service.grant).not.toHaveBeenCalled();
    expect(service.revoke).not.toHaveBeenCalled();
  });

  it("returns a cursor only when a lookahead assignment exists", async () => {
    const { app, as, service, assignment } = build();
    const second = { ...assignment, id: "c1d10000-0000-4000-8000-000000000002" };
    vi.mocked(service.list).mockResolvedValueOnce([assignment, second]);

    const listed = await request(app).get(`${PATH}?limit=1`).set(as("adm"));
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.nextCursor).toBe(assignment.id);
  });
});
