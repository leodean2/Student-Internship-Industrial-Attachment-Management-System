import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createLogger } from "../../src/infrastructure/logger";
import { ActorContextService } from "../../src/modules/auth/actor-context.service";
import { PrismaAuthRepository } from "../../src/modules/auth/auth.repository";
import { createTokenService } from "../../src/modules/auth/token";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { PrismaRefreshTokenRepository } from "../../src/modules/auth/refresh-token.repository";
import { DEFAULT_SESSION_CONFIG } from "../../src/modules/auth/session.config";
import { SessionService } from "../../src/modules/auth/session.service";

/**
 * Runs the REAL repository + service + HTTP stack against PostgreSQL.
 * Requires TEST_DATABASE_URL -> a disposable database with the baseline migration AND
 * prisma/constraints.sql applied (the latter seeds the SYSTEM user this test relies on).
 */
const url = process.env.TEST_DATABASE_URL;
const SYSTEM_ID = "00000000-0000-0000-0000-000000000001";
const SECRET = "integration-secret-integration-secret-1234567";

describe.skipIf(!url)("auth against PostgreSQL (Decision #51)", () => {
  const run = randomUUID().slice(0, 8);
  const id = (n: string) => `it-${run}-${n}`;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  const repo = new PrismaAuthRepository(prisma);
  const tokens = createTokenService(SECRET);
  const actors = new ActorContextService(repo);
  const sessions = new SessionService({
    repo: new PrismaRefreshTokenRepository(), actors, tokens, runTx: prismaTxRunner(prisma),
    config: DEFAULT_SESSION_CONFIG, logger: createLogger("silent"),
  });
  const app = createApp({
    logger: createLogger("silent"),
    corsOrigins: [],
    tokens,
    actors,
    sessions,
    cookie: { name: "refresh_token", path: "/api/v1/auth", sameSite: "strict", secure: true },
  });
  const bearer = (userId: string) => `Bearer ${tokens.sign(userId)}`;
  const user = (n: string, extra: object = {}) =>
    prisma.user.create({ data: { id: id(n), email: `${id(n)}@example.test`, passwordHash: "x", name: n, ...extra } });

  beforeAll(async () => {
    await user("admin", { status: "ACTIVE" });
    await prisma.organization.createMany({
      data: [
        { id: id("orgA"), name: "Org A", proposedByUserId: id("admin") },
        { id: id("orgB"), name: "Org B", proposedByUserId: id("admin") },
      ],
    });
    await user("student", { status: "ACTIVE" });
    await prisma.userRole.create({ data: { userId: id("student"), role: "STUDENT" } });
    await prisma.studentProfile.create({ data: { id: id("sp"), userId: id("student"), registrationNumber: `REG-${run}` } });

    await user("multi", { status: "ACTIVE" });
    await prisma.userRole.createMany({
      data: [
        { userId: id("multi"), role: "UNIVERSITY_SUPERVISOR" },
        { userId: id("multi"), role: "ORGANIZATION_SUPERVISOR" },
      ],
    });
    await prisma.universitySupervisorProfile.create({ data: { id: id("usp"), userId: id("multi") } });
    await prisma.organizationSupervisorProfile.createMany({
      data: [
        { id: id("ospA"), userId: id("multi"), organizationId: id("orgA") },
        { id: id("ospB"), userId: id("multi"), organizationId: id("orgB") },
      ],
    });

    await user("deactivated", { status: "DEACTIVATED" });
    await prisma.userRole.create({ data: { userId: id("deactivated"), role: "STUDENT" } });
    await user("pending"); // default status PENDING_VERIFICATION
    await prisma.userRole.create({ data: { userId: id("pending"), role: "STUDENT" } });
  });

  afterAll(async () => {
    const users = { in: ["admin", "student", "multi", "deactivated", "pending"].map(id) };
    await prisma.organizationSupervisorProfile.deleteMany({ where: { userId: users } });
    await prisma.universitySupervisorProfile.deleteMany({ where: { userId: users } });
    await prisma.studentProfile.deleteMany({ where: { userId: users } });
    await prisma.userRole.deleteMany({ where: { userId: users } });
    await prisma.organization.deleteMany({ where: { id: { in: [id("orgA"), id("orgB")] } } });
    await prisma.user.deleteMany({ where: { id: users } });
    await prisma.$disconnect();
  });

  it("repository returns roles and profiles for a student", async () => {
    const rec = await repo.findActorRecordById(id("student"));
    expect(rec).toMatchObject({
      id: id("student"), status: "ACTIVE", roles: ["STUDENT"], studentProfileId: id("sp"),
      universitySupervisorProfileId: null, adminProfileId: null, organizationSupervisorProfiles: [],
    });
  });

  it("repository returns one affiliation row per organization for a multi-role supervisor (#43/#62)", async () => {
    const rec = await repo.findActorRecordById(id("multi"));
    expect([...rec!.roles].sort()).toEqual(["ORGANIZATION_SUPERVISOR", "UNIVERSITY_SUPERVISOR"]);
    expect(rec!.universitySupervisorProfileId).toBe(id("usp"));
    expect([...rec!.organizationSupervisorProfiles].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: id("ospA"), organizationId: id("orgA") },
      { id: id("ospB"), organizationId: id("orgB") },
    ]);
  });

  it("repository returns null for an unknown user", async () => {
    expect(await repo.findActorRecordById(id("does-not-exist"))).toBeNull();
  });

  it("the seeded SYSTEM user exists, is ACTIVE, and holds NO role (#69)", async () => {
    const rec = await repo.findActorRecordById(SYSTEM_ID);
    expect(rec, "SYSTEM user missing — apply prisma/constraints.sql").not.toBeNull();
    expect(rec!.status).toBe("ACTIVE");
    expect(rec!.roles).toEqual([]);
  });

  it("GET /auth/me returns the ActorContext built from the database", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(id("multi")));
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["ORGANIZATION_SUPERVISOR", "UNIVERSITY_SUPERVISOR"]);
    expect(res.body.profileIds.universitySupervisor).toBe(id("usp"));
    expect(res.body.profileIds.organizationSupervisor).toHaveLength(2);
  });

  it("rejects deactivated and unverified accounts with ACCOUNT_INACTIVE", async () => {
    for (const n of ["deactivated", "pending"]) {
      const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(id(n)));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
    }
  });

  it("rejects a validly signed token for the SYSTEM user (#69)", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", bearer(SYSTEM_ID));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("applies a role change in the database on the very next request, same token", async () => {
    const auth = bearer(id("student"));
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).body.roles).toEqual(["STUDENT"]);
    await prisma.userRole.create({ data: { userId: id("student"), role: "ADMIN" } });
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).body.roles).toEqual(["ADMIN", "STUDENT"]);
    await prisma.userRole.delete({ where: { userId_role: { userId: id("student"), role: "ADMIN" } } });
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).body.roles).toEqual(["STUDENT"]);
  });

  it("applies deactivation in the database immediately, same unexpired token", async () => {
    const auth = bearer(id("student"));
    expect((await request(app).get("/api/v1/auth/me").set("Authorization", auth)).status).toBe(200);
    await prisma.user.update({ where: { id: id("student") }, data: { status: "DEACTIVATED" } });
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", auth);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
    await prisma.user.update({ where: { id: id("student") }, data: { status: "ACTIVE" } });
  });
});
