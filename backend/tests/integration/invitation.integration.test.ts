import { randomUUID } from "node:crypto";
import pg, { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbClockNow } from "../../src/infrastructure/db-clock";
import { invitationEmailLockKey } from "../../src/infrastructure/advisory-lock";
import { prismaTxRunner, type Tx } from "../../src/infrastructure/transaction";
import { PrismaAuditRepository } from "../../src/modules/audit/audit.repository";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { PrismaInvitationRepository } from "../../src/modules/invitations/invitation.repository";
import { InvitationService, type InvitationServiceDeps } from "../../src/modules/invitations/invitation.service";
import { PrismaOutboxRepository } from "../../src/modules/outbox/outbox.repository";
import { hashToken } from "../../src/shared/security/opaque-token";

const url = process.env.TEST_DATABASE_URL;
const ROLE = "UNIVERSITY_SUPERVISOR";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errOf = (promise: Promise<unknown>) =>
  promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

describe.skipIf(!url)("invitation creation against PostgreSQL (Batch B, Delivery 1)", () => {
  const run = randomUUID().slice(0, 8);
  const adminId = `inv-${run}-admin`;
  const email = (name: string) => `inv-${run}-${name}@example.test`;
  const connectionStringFor = (applicationName: string) => {
    const connection = new URL(url!);
    connection.searchParams.set("application_name", applicationName);
    return connection.toString();
  };
  const appName = `invitation-tests-${run}`;
  const actor: ActorContext = {
    userId: adminId,
    status: "ACTIVE",
    roles: new Set(["ADMIN"]),
    profileIds: { organizationSupervisor: [] },
  };

  let prisma: PrismaClient;
  const db = (): PrismaClient => prisma;
  let service: InvitationService;
  const build = (
    client: PrismaClient,
    overrides: Partial<InvitationServiceDeps> = {},
  ): InvitationService => new InvitationService({
    repo: new PrismaInvitationRepository(),
    audit: new PrismaAuditRepository(),
    outbox: new PrismaOutboxRepository(),
    appBaseUrl: "https://app.example.test",
    runTx: prismaTxRunner(client, { timeout: 30_000 }),
    ...overrides,
  });

  const query = <T>(sql: string, ...params: unknown[]) =>
    db().$queryRawUnsafe<T[]>(sql, ...params);
  const execute = (sql: string, ...params: unknown[]) =>
    db().$executeRawUnsafe(sql, ...params);
  const count = async (fromAndWhere: string, ...params: unknown[]) => {
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n ${fromAndWhere}`, ...params);
    return rows[0]!.n;
  };
  const invitationsFor = (target: string) => count(`FROM invitations WHERE email = $1`, target);
  const outboxFor = (target: string) => count(`FROM email_outbox WHERE "toEmail" = $1`, target);
  const auditFor = (target: string) =>
    count(`FROM audit_logs WHERE "targetType" = 'Invitation' AND "targetId" IN (SELECT id FROM invitations WHERE email = $1)`, target);
  const dbTime = async () => (await query<{ t: Date }>(`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS t`))[0]!.t;
  const insertUser = (id: string, target: string, name = "Fixture") =>
    execute(
      `INSERT INTO users (id, email, "passwordHash", name, status, "updatedAt")
       VALUES ($1, $2, 'integration-only', $3, 'ACTIVE', now())`,
      id,
      target,
      name,
    );

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionStringFor(appName), max: 10 }),
    });
    const schema = await query<{ lifecycleColumns: number; provisioningConstraints: number }>(`
      SELECT
        (SELECT count(*)::int
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'invitations'
           AND column_name IN ('createdAt', 'acceptedAt', 'revokedAt')) AS "lifecycleColumns",
        (SELECT count(*)::int
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         WHERE c.contype = 'c'
           AND (t.relname, c.conname) IN (
             ('users', 'ck_user_name_length'),
             ('university_supervisor_profiles', 'ck_supervisor_staff_id_length'),
             ('university_supervisor_profiles', 'ck_supervisor_title_length')
           )) AS "provisioningConstraints"`);
    if (schema[0]?.lifecycleColumns !== 3 || schema[0]?.provisioningConstraints !== 3) {
      throw new Error(
        "TEST_DATABASE_URL is missing the 20261106090000_provisioning_limits migration. " +
        "Apply all migrations to this disposable database before running integration tests.",
      );
    }

    service = build(db());
    await insertUser(adminId, email("admin"), "Admin");
    await execute(
      `INSERT INTO user_roles (id, "userId", role) VALUES ($1, $2, 'ADMIN')`,
      randomUUID(),
      adminId,
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    const like = `inv-${run}-%`;
    await execute(`DELETE FROM audit_logs WHERE "actorUserId" = $1`, adminId);
    await execute(`DELETE FROM email_outbox WHERE "toEmail" LIKE $1`, like);
    await execute(`DELETE FROM invitations WHERE email LIKE $1`, like);
    await execute(`DELETE FROM university_supervisor_profiles WHERE "userId" LIKE $1`, like);
    await execute(`DELETE FROM user_roles WHERE "userId" LIKE $1`, like);
    await execute(`DELETE FROM users WHERE id LIKE $1`, like);
    await db().$disconnect();
  });

  describe("what a successful creation stores", () => {
    it("writes the token hash, outbox message, and audit event consistently", async () => {
      const target = email("shape");
      const created = await service.create(actor, { email: target, role: ROLE });
      const [invitation] = await query<{ tokenHash: string } & Record<string, unknown>>(
        `SELECT * FROM invitations WHERE id = $1`,
        created.invitationId,
      );
      const [outbox] = await query<{
        payload: Record<string, unknown>;
        toEmail: string;
        templateType: string;
        status: string;
        attempts: number;
        relatedUserId: string | null;
      }>(
        `SELECT * FROM email_outbox WHERE "idempotencyKey" = $1`,
        `invitation-created:${invitation!.tokenHash}`,
      );
      const audit = await query<{
        actorUserId: string;
        action: string;
        targetType: string;
        metadata: unknown;
      }>(`SELECT * FROM audit_logs WHERE "targetId" = $1`, created.invitationId);

      const acceptanceUrl = outbox!.payload.acceptanceUrl as string;
      const rawToken = new URL(acceptanceUrl).searchParams.get("token")!;
      expect(invitation).toMatchObject({
        email: target,
        role: ROLE,
        organizationId: null,
        invitedByUserId: adminId,
        acceptedByUserId: null,
        acceptedAt: null,
        revokedAt: null,
      });
      expect(invitation!.tokenHash).toBe(hashToken(rawToken));
      expect(JSON.stringify(invitation)).not.toContain(rawToken);
      expect(outbox).toMatchObject({
        toEmail: target,
        templateType: "INVITATION_CREATED",
        status: "PENDING",
        attempts: 0,
        relatedUserId: null,
      });
      expect(Object.keys(outbox!.payload).sort()).toEqual(["acceptanceUrl", "expiresAt", "role"]);
      expect(outbox!.payload).toMatchObject({
        acceptanceUrl,
        role: ROLE,
        expiresAt: created.expiresAt.toISOString(),
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: adminId,
        action: "INVITATION_CREATED",
        targetType: "Invitation",
        metadata: { role: ROLE },
      });
      const auditText = JSON.stringify(audit);
      for (const secret of [target, rawToken, hashToken(rawToken)]) expect(auditText).not.toContain(secret);
    });

    it("sets expiry exactly seven days after createdAt from one database clock reading", async () => {
      const before = await dbTime();
      const created = await service.create(actor, { email: email("seven"), role: ROLE });
      const after = await dbTime();
      const [row] = await query<{ createdAt: Date; expiresAt: Date }>(
        `SELECT "createdAt", "expiresAt" FROM invitations WHERE id = $1`,
        created.invitationId,
      );
      expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
      expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
      expect(row!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1);
      expect(created.expiresAt.getTime()).toBe(row!.expiresAt.getTime());
    });

    it("uses the outbox idempotency key to enqueue at most one message", async () => {
      const repo = new PrismaOutboxRepository();
      const key = `invitation:${randomUUID()}`;
      const message = {
        toEmail: email("idempotency"),
        templateType: "invitation",
        payload: { marker: "idempotency-test" },
        idempotencyKey: key,
      };
      const runner = prismaTxRunner(db());
      expect(await runner((tx) => repo.enqueue(tx, message))).toEqual({ created: true });
      expect(await runner((tx) => repo.enqueue(tx, message))).toEqual({ created: false });
      expect(await count(`FROM email_outbox WHERE "idempotencyKey" = $1`, key)).toBe(1);
    });
  });

  describe("reissue policy (database clock, derived status)", () => {
    const seedInvitation = (
      target: string,
      options: { expires: string; acceptedByUserId?: string; revoked?: boolean },
    ) => execute(
      `INSERT INTO invitations (id, email, role, "invitedByUserId", "tokenHash", "expiresAt", "acceptedByUserId", "revokedAt")
       VALUES ($1, $2, 'UNIVERSITY_SUPERVISOR', $3, $4,
               (clock_timestamp() AT TIME ZONE 'UTC') + $5::interval, $6,
               ${options.revoked ? "(clock_timestamp() AT TIME ZONE 'UTC')" : "NULL"})`,
      randomUUID(),
      target,
      adminId,
      `token-hash-${randomUUID()}`,
      options.expires,
      options.acceptedByUserId ?? null,
    );

    it("blocks invitation when an account already exists", async () => {
      const target = email("account");
      await insertUser(`inv-${run}-account`, target);
      expect(await errOf(service.create(actor, { email: target, role: ROLE })))
        .toMatchObject({ status: 409, code: "CONFLICT" });
      expect(await invitationsFor(target)).toBe(0);
    });

    it("blocks when a pending invitation exists", async () => {
      const target = email("pending");
      await seedInvitation(target, { expires: "3 days" });
      expect(await errOf(service.create(actor, { email: target, role: ROLE })))
        .toMatchObject({ status: 409, code: "CONFLICT" });
      expect(await invitationsFor(target)).toBe(1);
    });

    it("blocks accepted invitations even after their expiry", async () => {
      const target = email("accepted");
      const acceptorId = `inv-${run}-acceptor`;
      await insertUser(acceptorId, email("acceptor-mailbox"));
      await seedInvitation(target, { expires: "-1 day", acceptedByUserId: acceptorId });
      expect(await errOf(service.create(actor, { email: target, role: ROLE })))
        .toMatchObject({ status: 409, code: "CONFLICT" });
      expect(await invitationsFor(target)).toBe(1);
    });

    it("allows reissue for expired unaccepted invitations and preserves history", async () => {
      const target = email("expired");
      await seedInvitation(target, { expires: "-1 minute" });
      await service.create(actor, { email: target, role: ROLE });
      expect(await invitationsFor(target)).toBe(2);
    });

    it("allows reissue for cancelled invitations and preserves history", async () => {
      const target = email("cancelled");
      await seedInvitation(target, { expires: "5 days", revoked: true });
      await service.create(actor, { email: target, role: ROLE });
      expect(await invitationsFor(target)).toBe(2);
    });
  });

  describe("L1: concurrent creation", () => {
    it("allows one of eight concurrent requests for the same email, across three rounds", async () => {
      for (let round = 0; round < 3; round++) {
        const target = email(`l1-${round}`);
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => service.create(actor, { email: target, role: ROLE })),
        );
        const winners = results.filter(
          (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
            result.status === "fulfilled",
        );
        const losers = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        expect(winners, `round ${round} winners`).toHaveLength(1);
        expect(losers).toHaveLength(7);
        for (const loser of losers) expect(loser.reason).toMatchObject({ status: 409, code: "CONFLICT" });
        expect(await invitationsFor(target)).toBe(1);
        expect(await outboxFor(target)).toBe(1);
        expect(await auditFor(target)).toBe(1);
        expect(await count(
          `FROM email_outbox o
           JOIN invitations i ON o."idempotencyKey" = 'invitation-created:' || i."tokenHash"
           WHERE i.id = $1`,
          winners[0]!.value.invitationId,
        )).toBe(1);
      }
    }, 60_000);

    it("allows concurrent creation for eight different emails", async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          service.create(actor, { email: email(`many-${index}`), role: ROLE }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    }, 30_000);
  });

  describe("L3: advisory lock and database clock", () => {
    pg.types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`));

    async function waitForLockWait(applicationName: string, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const rows = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_stat_activity
             WHERE application_name = $1
               AND wait_event_type = 'Lock'
               AND query LIKE '%pg_advisory_xact_lock%'
           ) AS waiting`,
          applicationName,
        );
        if (rows[0]?.waiting) return;
        await sleep(25);
      }
      throw new Error(`No advisory-lock wait was observed for ${applicationName}.`);
    }

    async function holdLock(target: string) {
      const client = new Client({ connectionString: connectionStringFor(`invitation-lock-holder-${run}`) });
      await client.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [invitationEmailLockKey(target)]);
      let released = false;
      return {
        client,
        async release(commit = true) {
          if (released) return;
          released = true;
          await client.query(commit ? "COMMIT" : "ROLLBACK");
          await client.end();
        },
      };
    }

    const track = <T>(promise: Promise<T>) => {
      const state = { settled: false };
      const outcome = promise
        .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
        .finally(() => { state.settled = true; });
      return { state, outcome };
    };

    it("waits for the lock and checks state only after lock acquisition", async () => {
      const target = email("lock-wait");
      const holder = await holdLock(target);
      try {
        const creating = track(service.create(actor, { email: target, role: ROLE }));
        await waitForLockWait(appName);
        expect(creating.state.settled).toBe(false);
        await holder.client.query(
          `INSERT INTO invitations (id, email, role, "invitedByUserId", "tokenHash", "expiresAt")
           VALUES ($1, $2, 'UNIVERSITY_SUPERVISOR', $3, $4,
                   (clock_timestamp() AT TIME ZONE 'UTC') + interval '7 days')`,
          [randomUUID(), target, adminId, `token-hash-${randomUUID()}`],
        );
        await holder.release();
        const outcome = await creating.outcome;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error).toMatchObject({ status: 409, code: "CONFLICT" });
      } finally {
        await holder.release().catch(() => undefined);
      }
      expect(await invitationsFor(target)).toBe(1);
      expect(await outboxFor(target)).toBe(0);
      expect(await auditFor(target)).toBe(0);
    }, 30_000);

    it("computes expiry after lock release using the database clock", async () => {
      const target = email("expiry-after-lock");
      const start = await dbTime();
      const holder = await holdLock(target);
      let releasedAt: Date;
      try {
        const creating = track(service.create(actor, { email: target, role: ROLE }));
        await waitForLockWait(appName);
        expect(creating.state.settled).toBe(false);
        await holder.client.query("SELECT pg_sleep(0.5)");
        releasedAt = (await holder.client.query(`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS t`)).rows[0].t as Date;
        await holder.release();
        const outcome = await creating.outcome;
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const [row] = await query<{ createdAt: Date; expiresAt: Date }>(
          `SELECT "createdAt", "expiresAt" FROM invitations WHERE id = $1`,
          outcome.value.invitationId,
        );
        expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
        expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime() - 1);
        expect(row!.createdAt.getTime() - start.getTime()).toBeGreaterThanOrEqual(1400);
      } finally {
        await holder.release().catch(() => undefined);
      }
    }, 30_000);

    it("does not block a different email while one email lock is held", async () => {
      const holder = await holdLock(email("held-email"));
      try {
        const target = email("free-email");
        const create = service.create(actor, { email: target, role: ROLE });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("A different email was blocked by the held advisory lock.")), 10_000),
        );
        await Promise.race([create, timeout]);
        expect(await invitationsFor(target)).toBe(1);
      } finally {
        await holder.release();
      }
    }, 30_000);

    it("serializes differently-cased email inputs on one normalized lock key", async () => {
      const target = email("case-folded");
      const holder = await holdLock(target);
      try {
        const creating = track(service.create(actor, { email: ` ${target.toUpperCase()} `, role: ROLE }));
        await waitForLockWait(appName);
        expect(creating.state.settled).toBe(false);
        await holder.release();
        expect((await creating.outcome).ok).toBe(true);
      } finally {
        await holder.release().catch(() => undefined);
      }
      expect(await invitationsFor(target)).toBe(1);
    }, 30_000);
  });

  describe("P1: pool of two connections", () => {
    it("completes sixteen concurrent requests without deadlock using a two-connection Prisma pool", async () => {
      const pool2Name = `invitation-pool2-${run}`;
      const pool2 = new PrismaClient({
        adapter: new PrismaPg({ connectionString: connectionStringFor(pool2Name), max: 2 }),
      });
      try {
        const limited = build(pool2);
        const same = email("pool-same");
        const jobs = [
          ...Array.from({ length: 8 }, () => limited.create(actor, { email: same, role: ROLE })),
          ...Array.from({ length: 8 }, (_, index) =>
            limited.create(actor, { email: email(`pool-${index}`), role: ROLE })),
        ];
        const results = await Promise.allSettled(jobs);
        expect(results.slice(0, 8).filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.slice(8).filter((result) => result.status === "fulfilled")).toHaveLength(8);
      } finally {
        await pool2.$disconnect();
      }
    }, 60_000);
  });

  describe("atomicity against PostgreSQL", () => {
    it("rolls back invitation when outbox persistence fails", async () => {
      class FailingOutbox extends PrismaOutboxRepository {
        override async enqueue(): Promise<{ created: boolean }> {
          throw new Error("simulated outbox failure");
        }
      }
      const target = email("atomic-outbox");
      const auditBefore = await count(`FROM audit_logs WHERE "actorUserId" = $1`, adminId);
      expect(await errOf(build(db(), { outbox: new FailingOutbox() }).create(actor, { email: target, role: ROLE })))
        .toMatchObject({ message: "simulated outbox failure" });
      expect(await invitationsFor(target)).toBe(0);
      expect(await outboxFor(target)).toBe(0);
      expect(await count(`FROM audit_logs WHERE "actorUserId" = $1`, adminId)).toBe(auditBefore);
    });

    it("rolls back invitation and outbox when audit persistence fails", async () => {
      class FailingAudit extends PrismaAuditRepository {
        override async record(): Promise<void> {
          throw new Error("simulated audit failure");
        }
      }
      const target = email("atomic-audit");
      expect(await errOf(build(db(), { audit: new FailingAudit() }).create(actor, { email: target, role: ROLE })))
        .toMatchObject({ message: "simulated audit failure" });
      expect(await invitationsFor(target)).toBe(0);
      expect(await outboxFor(target)).toBe(0);
      expect(await count(`FROM email_outbox WHERE "idempotencyKey" LIKE 'invitation-created:%' AND "toEmail" = $1`, target)).toBe(0);
    });
  });

  describe("database clock", () => {
    it("advances within a transaction while now() remains frozen", async () => {
      await prismaTxRunner(db())(async (tx: Tx) => {
        const first = await tx.$queryRaw<{ t: Date }[]>`SELECT (now() AT TIME ZONE 'UTC') AS t`;
        await tx.$queryRaw`SELECT pg_sleep(0.4)::text AS slept`;
        const clock = await dbClockNow(tx);
        const second = await tx.$queryRaw<{ t: Date }[]>`SELECT (now() AT TIME ZONE 'UTC') AS t`;
        const start = new Date(first[0]!.t).getTime();
        expect(clock.getTime() - start).toBeGreaterThanOrEqual(350);
        expect(new Date(second[0]!.t).getTime()).toBe(start);
      });
    });
  });

  describe("P3: database constraints and columns", () => {
    const insertProfile = (userId: string, staffId: string | null, title: string | null) =>
      execute(
        `INSERT INTO university_supervisor_profiles (id, "userId", "staffId", title)
         VALUES ($1, $2, $3, $4)`,
        randomUUID(),
        userId,
        staffId,
        title,
      );
    let sequence = 0;
    const freshUser = async () => {
      const id = `inv-${run}-constraint-${++sequence}`;
      await insertUser(id, `${id}@example.test`);
      return id;
    };

    it("enforces users.name length 1 through 100", async () => {
      for (const invalid of ["", "x".repeat(101)]) {
        const id = `inv-${run}-name-invalid-${invalid.length}`;
        expect(errorMessage(await errOf(insertUser(id, `${id}@example.test`, invalid))))
          .toMatch(/ck_user_name_length|23514|check constraint/i);
        expect(await count(`FROM users WHERE id = $1`, id)).toBe(0);
      }
      await insertUser(`inv-${run}-name-valid-1`, email("name-valid-1"), "x");
      await insertUser(`inv-${run}-name-valid-100`, email("name-valid-100"), "x".repeat(100));
    });

    it("enforces staffId as NULL or length 1 through 64", async () => {
      for (const invalid of ["", "s".repeat(65)]) {
        const userId = await freshUser();
        expect(errorMessage(await errOf(insertProfile(userId, invalid, null))))
          .toMatch(/ck_supervisor_staff_id_length|23514|check constraint/i);
      }
      for (const valid of [null, "s", "s".repeat(64)]) {
        await insertProfile(await freshUser(), valid, null);
      }
    });

    it("enforces title as NULL or length 1 through 100", async () => {
      for (const invalid of ["", "t".repeat(101)]) {
        const userId = await freshUser();
        expect(errorMessage(await errOf(insertProfile(userId, null, invalid))))
          .toMatch(/ck_supervisor_title_length|23514|check constraint/i);
      }
      for (const valid of [null, "t", "t".repeat(100)]) {
        await insertProfile(await freshUser(), null, valid);
      }
    });

    it("has createdAt default, nullable acceptedAt/revokedAt, and no status column", async () => {
      const id = randomUUID();
      await execute(
        `INSERT INTO invitations (id, email, role, "invitedByUserId", "tokenHash", "expiresAt")
         VALUES ($1, $2, 'UNIVERSITY_SUPERVISOR', $3, $4, now())`,
        id,
        email("lifecycle-columns"),
        adminId,
        `token-hash-${randomUUID()}`,
      );
      const [row] = await query<{ createdAt: Date | null; acceptedAt: Date | null; revokedAt: Date | null }>(
        `SELECT "createdAt", "acceptedAt", "revokedAt" FROM invitations WHERE id = $1`,
        id,
      );
      expect(row!.createdAt).not.toBeNull();
      expect(row!.acceptedAt).toBeNull();
      expect(row!.revokedAt).toBeNull();
      expect(await count(
        `FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'status'`,
      )).toBe(0);
    });

    it("preserves tokenHash uniqueness", async () => {
      const hash = `unique-token-hash-${randomUUID()}`;
      const insert = (target: string) => execute(
        `INSERT INTO invitations (id, email, role, "invitedByUserId", "tokenHash", "expiresAt")
         VALUES ($1, $2, 'UNIVERSITY_SUPERVISOR', $3, $4, now())`,
        randomUUID(),
        target,
        adminId,
        hash,
      );
      await insert(email("duplicate-hash-1"));
      expect(errorMessage(await errOf(insert(email("duplicate-hash-2")))))
        .toMatch(/unique|23505|duplicate/i);
    });
  });
});
