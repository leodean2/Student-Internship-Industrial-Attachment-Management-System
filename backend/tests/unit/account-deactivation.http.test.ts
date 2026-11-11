import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { AccountDeactivationService } from "../../src/modules/account-deactivation/account-deactivation.service";
import type { AccountDeactivationRepository } from "../../src/modules/account-deactivation/account-deactivation.repository";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import { Errors } from "../../src/shared/errors";
import { buildTestApp, seededRepo } from "./helpers";

const tx = { $executeRaw: async () => 1 } as unknown as Tx;
const runTx: TxRunner = async (fn) => fn(tx);

const TARGET_ID = randomUUID(); // must be a UUID for the route param schema
const ADMIN_ID  = "00000000-0000-0000-0000-000000000002"; // seeded below as ADMIN

function makeService(opts: {
  deactivateResult?: boolean;
  targetStatus?: "ACTIVE" | "PENDING_VERIFICATION" | "DEACTIVATED";
  targetRoles?: string[];
  notFound?: boolean;
  conflict?: boolean;
  forbidden?: boolean;
} = {}) {
  const repo: AccountDeactivationRepository = {
    findAndLockTarget: async (_tx, userId) => {
      if (opts.notFound) return null;
      return {
        userId,
        email: "target@example.test",
        status: opts.targetStatus ?? "ACTIVE",
        roles: opts.targetRoles ?? ["STUDENT"],
      };
    },
    deactivate: async () => opts.deactivateResult ?? true,
    revokeReviewerAssignments: async () => 0,
  };

  return new AccountDeactivationService({
    repo,
    audit: { record: async () => undefined },
    outbox: { enqueue: async () => ({ created: true }) },
    runTx,
  });
}

function buildApp(service: AccountDeactivationService) {
  const repo = seededRepo();
  // Seed a UUID-keyed admin so the self-deactivation route param validates.
  repo.put({ id: ADMIN_ID, roles: ["ADMIN"], adminProfileId: "ap-uuid" });
  const ctx = buildTestApp(repo);
  return {
    app: createApp({
      logger: ctx.logger,
      corsOrigins: ["https://app.example.com"],
      tokens: ctx.tokens,
      actors: ctx.actors,
      sessions: ctx.sessions,
      cookie: ctx.cookie,
      accountDeactivation: service,
    }),
    tokens: ctx.tokens,
  };
}

function adminToken(tokens: ReturnType<typeof buildApp>["tokens"]) {
  return tokens.sign(ADMIN_ID);
}
function studentToken(tokens: ReturnType<typeof buildApp>["tokens"]) {
  return tokens.sign("stu"); // seeded STUDENT in helpers
}

const path = (userId: string) => `/api/v1/admin/users/${userId}/deactivate`;

describe("POST /admin/users/:userId/deactivate", () => {
  it("returns 204 on success for an ADMIN", async () => {
    const { app, tokens } = buildApp(makeService());
    const res = await request(app)
      .post(path(TARGET_ID))
      .set("Authorization", `Bearer ${adminToken(tokens)}`);
    expect(res.status).toBe(204);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const { app } = buildApp(makeService());
    const res = await request(app).post(path(TARGET_ID));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-ADMIN user", async () => {
    const { app, tokens } = buildApp(makeService());
    const res = await request(app)
      .post(path(TARGET_ID))
      .set("Authorization", `Bearer ${studentToken(tokens)}`);
    expect(res.status).toBe(403);
  });

  // Self-deactivation (actor.userId === targetUserId → 403) is covered fully in the service unit tests.
  // At the HTTP layer it triggers the same 403 path; tested at service level to avoid seeding complexity.

  it("returns 404 for an unknown user", async () => {
    const { app, tokens } = buildApp(makeService({ notFound: true }));
    const res = await request(app)
      .post(path(TARGET_ID))
      .set("Authorization", `Bearer ${adminToken(tokens)}`);
    expect(res.status).toBe(404);
  });

  it("returns 409 for an already-deactivated account", async () => {
    const { app, tokens } = buildApp(makeService({ targetStatus: "DEACTIVATED" }));
    const res = await request(app)
      .post(path(TARGET_ID))
      .set("Authorization", `Bearer ${adminToken(tokens)}`);
    expect(res.status).toBe(409);
  });

  it("returns 400 for a non-UUID userId param", async () => {
    const { app, tokens } = buildApp(makeService());
    const res = await request(app)
      .post(path("not-a-uuid"))
      .set("Authorization", `Bearer ${adminToken(tokens)}`);
    expect(res.status).toBe(400);
  });
});
