import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import { InvitationService } from "../../src/modules/invitations/invitation.service";
import { ORIGIN, buildTestApp } from "./helpers";

const PATH = "/api/v1/invitations";

function build() {
  const ctx = buildTestApp();
  const stored: { email: string; tokenHash: string }[] = [];
  const outbox: { payload: { acceptanceUrl: string } }[] = [];
  const acceptedUsers: { email: string; passwordHash: string; name: string }[] = [];
  const acceptedProfiles: { staffId: string | null; title: string | null }[] = [];
  const audits: { action: string; targetId: string }[] = [];
  const now = new Date("2026-11-06T10:00:00.000Z");
  const listingRecord = {
    id: "inv-1",
    email: "jane@example.test",
    role: "UNIVERSITY_SUPERVISOR",
    organizationId: null,
    invitedByUserId: "adm",
    acceptedByUserId: null,
    createdAt: new Date("2026-11-06T09:00:00.000Z"),
    expiresAt: new Date("2026-11-13T10:00:00.000Z"),
    acceptedAt: null,
    revokedAt: null,
  };
  const whereCalls: unknown[] = [];
  const tx = {
    $queryRaw: async () => [{ now }],
  } as unknown as Tx;
  const runTx: TxRunner = (fn) => fn(tx);
  const invitations = new InvitationService({
    repo: {
      accountExists: async (_tx, email) => email === "taken@example.test",
      findBlocking: async (_tx, email) =>
        email === "pending@example.test" ? "PENDING" : email === "accepted@example.test" ? "ACCEPTED" : null,
      findByTokenHash: async () => ({ id: "inv-1", email: "jane@example.test", role: "UNIVERSITY_SUPERVISOR" }),
      findEmailById: async () => "jane@example.test",
      findLifecycleForUpdate: async () => ({ status: "PENDING" }),
      insertUser: async (_tx, data) => { acceptedUsers.push(data); },
      insertRole: async () => undefined,
      insertUniversitySupervisorProfile: async (_tx, data) => { acceptedProfiles.push(data); },
      claim: async () => true,
      cancel: async () => new Date("2026-11-06T10:05:00.000Z"),
      findMany: async (_tx, where, skip, take) => {
        whereCalls.push({ where, skip, take, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        return [listingRecord];
      },
      count: async (_tx, where) => {
        whereCalls.push(where);
        return 1;
      },
      findAdminById: async (_tx, id) => id === listingRecord.id ? listingRecord : null,
      insert: async (_tx, data) => {
        stored.push({ email: data.email, tokenHash: data.tokenHash });
        return {
          createdAt: new Date("2026-11-06T10:00:00.000Z"),
          expiresAt: new Date("2026-11-13T10:00:00.000Z"),
        };
      },
    },
    audit: { record: async (_tx, event) => { audits.push({ action: event.action, targetId: event.targetId }); } },
    outbox: {
      enqueue: async (_tx, message) => {
        outbox.push({ payload: message.payload as { acceptanceUrl: string } });
        return { created: true };
      },
    },
    appBaseUrl: "https://app.example.test",
    runTx,
    acquireLock: async () => undefined,
    hashPassword: async () => "test-password-hash",
  });
  const app = createApp({
    logger: ctx.logger,
    corsOrigins: [ORIGIN],
    tokens: ctx.tokens,
    actors: ctx.actors,
    sessions: ctx.sessions,
    cookie: ctx.cookie,
    invitations,
  });
  const as = (userId: string) => ({ Authorization: `Bearer ${ctx.tokens.sign(userId)}` });
  return { ...ctx, app, stored, outbox, acceptedUsers, acceptedProfiles, audits, whereCalls, as };
}

const body = (overrides: object = {}) => ({
  email: "jane@example.test",
  role: "UNIVERSITY_SUPERVISOR",
  ...overrides,
});

const acceptBody = (overrides: object = {}) => ({
  token: "raw-invitation-token",
  password: "a secure password",
  name: "Jane Supervisor",
  ...overrides,
});

describe("POST /api/v1/invitations", () => {
  it("returns exactly invitationId, email, role, and expiresAt to an Admin", async () => {
    const { app, as } = build();
    const response = await request(app).post(PATH).set(as("adm")).send(body());
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      invitationId: expect.any(String),
      email: "jane@example.test",
      role: "UNIVERSITY_SUPERVISOR",
      expiresAt: "2026-11-13T10:00:00.000Z",
    });

  });

  it("never returns the raw token, its hash, or a URL", async () => {
    const { app, as, stored, outbox } = build();
    const response = await request(app).post(PATH).set(as("adm")).send(body());
    const everything = JSON.stringify(response.body) + JSON.stringify(response.headers);
    const token = new URL(outbox[0]!.payload.acceptanceUrl).searchParams.get("token")!;
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(stored[0]!.tokenHash);
    expect(everything).not.toMatch(/https?:\/\//);
  });

  it("normalizes the email in the response", async () => {
    const { app, as } = build();
    const response = await request(app).post(PATH).set(as("adm"))
      .send(body({ email: "  Jane@Example.TEST " }));
    expect(response.status).toBe(201);
    expect(response.body.email).toBe("jane@example.test");
  });

  it("returns 401 without a token and 403 for non-admin before body validation", async () => {
    const { app, as, stored } = build();
    expect((await request(app).post(PATH).send(body())).status).toBe(401);
    const forbidden = await request(app).post(PATH).set(as("stu")).send(body());
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    expect((await request(app).post(PATH).set(as("stu")).send({ nonsense: true })).status).toBe(403);
    expect(stored).toHaveLength(0);
  });

  it.each([
    ["STUDENT role", { role: "STUDENT" }],
    ["ORGANIZATION_SUPERVISOR role", { role: "ORGANIZATION_SUPERVISOR" }],
    ["ADMIN role", { role: "ADMIN" }],
    ["unknown field", { organizationId: "org-1" }],
    ["invalid email", { email: "nope" }],
  ])("returns 400 VALIDATION_ERROR for %s without echoing submitted values", async (_label, overrides) => {
    const { app, as, stored } = build();
    const response = await request(app).post(PATH).set(as("adm")).send(body(overrides));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("org-1");
    expect(stored).toHaveLength(0);
  });

  it("returns 409 for an existing account, pending invitation, and accepted invitation", async () => {
    const { app, as } = build();
    for (const email of ["taken@example.test", "pending@example.test", "accepted@example.test"]) {
      const response = await request(app).post(PATH).set(as("adm")).send(body({ email }));
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONFLICT");
    }
  });

  it("is not mounted when no invitation service is configured", async () => {
    const { app } = buildTestApp();
    expect((await request(app).post(PATH).send(body())).status).toBe(404);
  });
});

describe("POST /api/v1/invitations/accept", () => {
  it("requires an allowed Origin before validating the body", async () => {
    const { app } = build();
    expect((await request(app).post(`${PATH}/accept`).send({ invalid: true })).status).toBe(403);
    expect((await request(app).post(`${PATH}/accept`).set("Origin", "https://foreign.example").send(acceptBody())).status)
      .toBe(403);
  });

  describe("administrative invitation management", () => {
    it("lists only the documented fields with status and pagination, never token data", async () => {
      const { app, as, whereCalls } = build();
      const response = await request(app).get(PATH)
        .query({ page: 2, limit: 5, status: "PENDING", email: "  JANE@EXAMPLE.TEST " })
        .set(as("adm"));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: [{
          id: "inv-1",
          email: "jane@example.test",
          role: "UNIVERSITY_SUPERVISOR",
          organizationId: null,
          invitedByUserId: "adm",
          createdAt: "2026-11-06T09:00:00.000Z",
          expiresAt: "2026-11-13T10:00:00.000Z",
          acceptedAt: null,
          revokedAt: null,
          status: "PENDING",
        }],
        pagination: { page: 2, limit: 5, total: 1, totalPages: 1 },
      });
      expect(JSON.stringify(response.body)).not.toMatch(/tokenHash|acceptedByUserId|token/);
      expect(whereCalls[0]).toMatchObject({
        where: {
          AND: [
            { acceptedByUserId: null, revokedAt: null, expiresAt: { gt: expect.any(Date) } },
            { email: "jane@example.test" },
          ],
        },
        skip: 5,
        take: 5,
      });
      expect(whereCalls[1]).toEqual((whereCalls[0] as { where: unknown }).where);
      expect(response.headers["cache-control"]).toContain("no-store");
    });

    it("retrieves a single safe invitation record and returns 404 for an unknown id", async () => {
      const { app, as } = build();
      const response = await request(app).get(`${PATH}/inv-1`).set(as("adm"));
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("PENDING");
      expect(JSON.stringify(response.body)).not.toMatch(/tokenHash|acceptedByUserId|token/);
      expect((await request(app).get(`${PATH}/missing`).set(as("adm"))).status).toBe(404);
    });

    it("cancels a pending invitation and returns no secret fields", async () => {
      const { app, as, audits } = build();
      const response = await request(app).patch(`${PATH}/inv-1/cancel`).set(as("adm"));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        invitationId: "inv-1",
        status: "CANCELLED",
        revokedAt: "2026-11-06T10:05:00.000Z",
      });
      expect(audits).toEqual([{ action: "INVITATION_CANCELLED", targetId: "inv-1" }]);
    });

    it("requires an admin for list, retrieval, and cancellation", async () => {
      const { app, as } = build();
      for (const response of [
        await request(app).get(PATH),
        await request(app).get(`${PATH}/inv-1`),
        await request(app).patch(`${PATH}/inv-1/cancel`),
      ]) expect(response.status).toBe(401);
      for (const response of [
        await request(app).get(PATH).set(as("stu")),
        await request(app).get(`${PATH}/inv-1`).set(as("stu")),
        await request(app).patch(`${PATH}/inv-1/cancel`).set(as("stu")),
      ]) expect(response.status).toBe(403);
    });

    it("rejects malformed pagination and unknown query fields", async () => {
      const { app, as } = build();
      for (const query of [{ page: 0 }, { limit: 101 }, { status: "UNKNOWN" }, { extra: "secret" }]) {
        const response = await request(app).get(PATH).query(query).set(as("adm"));
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(response.body)).not.toContain("secret");
      }
    });
  });

  it("does not charge validation errors against the token-guess throttle", async () => {
    const { app } = build();
    for (let attempt = 0; attempt < 11; attempt++) {
      const invalid = await request(app).post(`${PATH}/accept`).set("Origin", ORIGIN).send(acceptBody({ name: "" }));
      expect(invalid.status).toBe(400);
    }
    const valid = await request(app).post(`${PATH}/accept`).set("Origin", ORIGIN).send(acceptBody());
    expect(valid.status).toBe(201);
  });

  it("creates an account and returns only userId, email, and role", async () => {
    const { app, acceptedUsers, acceptedProfiles } = build();
    const response = await request(app).post(`${PATH}/accept`).set("Origin", ORIGIN).send(acceptBody({
      name: "  Jane\u0301 Supervisor ",
      staffId: "  STAFF-1 ",
      title: "  Associate Professor ",
    }));
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      userId: expect.any(String),
      email: "jane@example.test",
      role: "UNIVERSITY_SUPERVISOR",
    });
    expect(JSON.stringify(response.body)).not.toContain("token");
    expect(acceptedUsers[0]).toMatchObject({
      name: "Jané Supervisor",
      email: "jane@example.test",
      passwordHash: "test-password-hash",
    });
    expect(acceptedProfiles[0]).toMatchObject({ staffId: "STAFF-1", title: "Associate Professor" });
  });

  it.each([
    ["short password", { password: "too-short" }],
    ["empty name", { name: "  " }],
    ["empty optional staff id", { staffId: "" }],
    ["too-long staff id", { staffId: "x".repeat(65) }],
    ["unknown field", { role: "ADMIN" }],
  ])("returns 400 for invalid acceptance %s", async (_label, overrides) => {
    const { app } = build();
    const response = await request(app).post(`${PATH}/accept`).set("Origin", ORIGIN).send(acceptBody(overrides));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
