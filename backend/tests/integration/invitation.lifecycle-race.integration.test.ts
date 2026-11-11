import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaTxRunner } from "../../src/infrastructure/transaction";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { PrismaInvitationRepository } from "../../src/modules/invitations/invitation.repository";
import { InvitationService, type InvitationServiceDeps } from "../../src/modules/invitations/invitation.service";
import { PrismaOutboxRepository } from "../../src/modules/outbox/outbox.repository";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_INVITATION_MANAGEMENT_INTEGRATION === "true";
const run = randomUUID().replaceAll("-", "").slice(0, 10);
const email = (label: string) => `lifecycle-${run}-${label}@example.test`;
const invitationIds: string[] = [];
const userIds: string[] = [];
const adminId = randomUUID();
const password = "integration-password-123";
const actor: ActorContext = {
  userId: adminId,
  status: "ACTIVE",
  roles: new Set(["ADMIN"]),
  profileIds: { organizationSupervisor: [] },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe.skipIf(!connectionString || !enabled)("invitation acceptance/cancellation race against PostgreSQL", () => {
  let prisma: PrismaClient;
  let service: InvitationService;
  const query = <T>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params);
  const execute = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);
  const build = (overrides: Partial<InvitationServiceDeps> = {}) =>
    new InvitationService({
      repo: new PrismaInvitationRepository(),
      audit: new PrismaAuditRepository(),
      outbox: new PrismaOutboxRepository(),
      appBaseUrl: "https://app.example.test",
      runTx: prismaTxRunner(prisma, { timeout: 30_000 }),
      ...overrides,
    });

  async function createInvitation(label: string) {
    const target = email(label);
    const created = await service.create(actor, { email: target, role: "UNIVERSITY_SUPERVISOR" });
    invitationIds.push(created.invitationId);
    const [outbox] = await query<{ payload: { acceptanceUrl: string } }>(
      `SELECT o.payload
       FROM invitations i
       JOIN email_outbox o ON o."idempotencyKey" = 'invitation-created:' || i."tokenHash"
       WHERE i.id = $1`,
      created.invitationId,
    );
    if (!outbox) throw new Error("Invitation outbox row was not created.");
    const token = new URL(outbox.payload.acceptanceUrl).searchParams.get("token");
    if (!token) throw new Error("Invitation acceptance URL did not contain a token.");
    return { invitationId: created.invitationId, email: target, token };
  }

  async function waitForAdvisoryLockWait(applicationName: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE application_name = $1
             AND state = 'active'
             AND wait_event_type = 'Lock'
             AND query LIKE '%pg_advisory_xact_lock%'
         ) AS waiting`,
        applicationName,
      );
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No advisory-lock wait was observed for ${applicationName}.`);
  }

  async function exerciseRace(winner: "accept" | "cancel") {
    const invitation = await createInvitation(`${winner}-wins`);
    const reachedAudit = deferred();
    const releaseWinner = deferred();
    const firstAction = winner === "accept" ? "INVITATION_ACCEPTED" : "INVITATION_CANCELLED";
    const baseAudit = new PrismaAuditRepository();
    const audit: InvitationServiceDeps["audit"] = {
      record: async (tx, event) => {
        if (event.action === firstAction) {
          reachedAudit.resolve();
          await releaseWinner.promise;
        }
        await baseAudit.record(tx, event);
      },
    };
    const raceService = build({ audit });
    const firstOperation = winner === "accept"
      ? raceService.accept({
        token: invitation.token,
        password,
        name: "Race Supervisor",
        staffId: null,
        title: null,
        ip: "198.51.100.61",
      })
      : raceService.cancel(actor, invitation.invitationId);

    await Promise.race([
      reachedAudit.promise,
      firstOperation.then(
        () => { throw new Error("The first operation completed before reaching its audit barrier."); },
        (error: unknown) => { throw error; },
      ),
    ]);
    const waitingOperation = winner === "accept"
      ? raceService.cancel(actor, invitation.invitationId)
      : raceService.accept({
        token: invitation.token,
        password,
        name: "Race Supervisor",
        staffId: null,
        title: null,
        ip: "198.51.100.62",
      });
    let lockWaitError: unknown;
    try {
      await waitForAdvisoryLockWait(`invitation-lifecycle-${run}`);
    } catch (error) {
      lockWaitError = error;
    } finally {
      releaseWinner.resolve();
    }

    const [firstResult, waitingResult] = await Promise.all([
      Promise.allSettled([firstOperation]),
      Promise.allSettled([waitingOperation]),
    ]);
    if (lockWaitError) throw lockWaitError;
    expect(firstResult[0]!.status).toBe("fulfilled");
    expect(waitingResult[0]!.status).toBe("rejected");
    const loser = (waitingResult[0] as PromiseRejectedResult).reason;
    expect(loser).toMatchObject(winner === "accept"
      ? { status: 409, code: "INVITATION_ALREADY_ACCEPTED" }
      : { status: 404, code: "NOT_FOUND" });

    const [row] = await query<{
      acceptedByUserId: string | null;
      acceptedAt: Date | null;
      revokedAt: Date | null;
    }>(
      `SELECT "acceptedByUserId", "acceptedAt", "revokedAt" FROM invitations WHERE id = $1`,
      invitation.invitationId,
    );
    expect(row).toBeDefined();
    expect(Boolean(row!.acceptedByUserId)).toBe(winner === "accept");
    expect(Boolean(row!.acceptedAt)).toBe(winner === "accept");
    expect(Boolean(row!.revokedAt)).toBe(winner === "cancel");

    const events = await query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE "targetType" = 'Invitation' AND "targetId" = $1 ORDER BY action`,
      invitation.invitationId,
    );
    expect(events.map(({ action }) => action)).toEqual([
      "INVITATION_CREATED",
      winner === "accept" ? "INVITATION_ACCEPTED" : "INVITATION_CANCELLED",
    ].sort());

    if (winner === "accept") {
      const [user] = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, invitation.email);
      if (user) userIds.push(user.id);
    }
  }

  beforeAll(async () => {
    if (!connectionString) return;
    if (process.env.NEON_BRANCH === "production") {
      throw new Error("Refusing invitation lifecycle integration tests while NEON_BRANCH is production.");
    }
    const target = new URL(connectionString);
    if (decodeURIComponent(target.pathname.slice(1)) !== "test_db") {
      throw new Error("Refusing to run invitation lifecycle integration tests outside test_db.");
    }
    const appName = `invitation-lifecycle-${run}`;
    target.searchParams.set("application_name", appName);
    const connection = target.toString();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connection, max: 4 }) });
    const indexes = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'invitations'
           AND indexname = 'invitations_createdAt_id_idx'
       ) AS exists`,
    );
    if (!indexes[0]?.exists) {
      throw new Error("The invitation admin listing migration has not been applied to test_db.");
    }
    await execute(
      `INSERT INTO users (id, email, "passwordHash", name, status, "updatedAt")
       VALUES ($1, $2, 'integration-only', 'Integration Admin', 'ACTIVE', now())`,
      adminId,
      email("admin"),
    );
    service = build();
  });

  afterAll(async () => {
    if (!prisma) return;
    await execute(`DELETE FROM audit_logs WHERE "targetId" = ANY($1::text[])`, invitationIds);
    await execute(`DELETE FROM email_outbox WHERE "toEmail" LIKE $1`, `lifecycle-${run}-%`);
    await execute(`DELETE FROM invitations WHERE id = ANY($1::text[])`, invitationIds);
    await execute(`DELETE FROM university_supervisor_profiles WHERE "userId" = ANY($1::text[])`, userIds);
    await execute(`DELETE FROM user_roles WHERE "userId" = ANY($1::text[])`, userIds);
    await execute(`DELETE FROM users WHERE id = ANY($1::text[])`, [...userIds, adminId]);
    await prisma.$disconnect();
  });

  it("acceptance wins only after the cancellation is confirmed waiting on the shared lock", async () => {
    await exerciseRace("accept");
  }, 30_000);

  it("cancellation wins only after the acceptance is confirmed waiting on the shared lock", async () => {
    await exerciseRace("cancel");
  }, 30_000);

  it("lists and retrieves invitations with database-derived status, pagination, and safe fields", async () => {
    const existingTotal = (await service.list(actor, { page: 1, limit: 1 })).pagination.total;
    const pending = await createInvitation("list-pending");
    const cancelled = await createInvitation("list-cancelled");
    const accepted = await createInvitation("list-accepted");
    const expired = await createInvitation("list-expired");

    await service.cancel(actor, cancelled.invitationId);
    const acceptedResult = await service.accept({
      token: accepted.token,
      password,
      name: "Listed Supervisor",
      staffId: null,
      title: null,
      ip: "198.51.100.63",
    });
    userIds.push(acceptedResult.userId);
    await execute(
      `UPDATE invitations
       SET "expiresAt" = clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second'
       WHERE id = $1`,
      expired.invitationId,
    );

    const pageOne = await service.list(actor, { page: 1, limit: 2 });
    const pageTwo = await service.list(actor, { page: 2, limit: 2 });
    const allRecords = [...pageOne.data, ...pageTwo.data];

    expect(pageOne.pagination).toEqual({
      page: 1,
      limit: 2,
      total: existingTotal + 4,
      totalPages: Math.ceil((existingTotal + 4) / 2),
    });
    expect(pageTwo.pagination).toMatchObject({
      total: existingTotal + 4,
      totalPages: Math.ceil((existingTotal + 4) / 2),
    });
    expect(Object.fromEntries(allRecords.map(({ id, status }) => [id, status]))).toEqual({
      [pending.invitationId]: "PENDING",
      [cancelled.invitationId]: "CANCELLED",
      [accepted.invitationId]: "ACCEPTED",
      [expired.invitationId]: "EXPIRED",
    });

    const expectedOrder = [...allRecords]
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map(({ id }) => id);
    expect(allRecords.map(({ id }) => id)).toEqual(expectedOrder);

    const detail = await service.get(actor, accepted.invitationId);
    expect(detail).toMatchObject({
      id: accepted.invitationId,
      email: accepted.email,
      status: "ACCEPTED",
      acceptedAt: expect.any(String),
    });
    for (const response of [JSON.stringify(pageOne), JSON.stringify(detail)]) {
      expect(response).not.toMatch(/tokenHash|acceptedByUserId|raw.invitation.token/);
    }

    const pendingOnly = await service.list(actor, { page: 1, limit: 10, status: "PENDING", email: pending.email });
    expect(pendingOnly.data.map(({ id }) => id)).toEqual([pending.invitationId]);
    expect(pendingOnly.pagination.total).toBe(1);
  }, 30_000);
});
