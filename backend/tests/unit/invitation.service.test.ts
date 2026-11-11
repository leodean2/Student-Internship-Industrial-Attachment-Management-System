import { describe, expect, it } from "vitest";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import type { AuditEvent, AuditRepository } from "../../src/modules/audit/audit.repository";
import type { BlockingInvitation, InvitationRepository } from "../../src/modules/invitations/invitation.repository";
import { InvitationService } from "../../src/modules/invitations/invitation.service";
import type { OutboxMessage, OutboxRepository } from "../../src/modules/outbox/outbox.repository";
import { hashToken } from "../../src/shared/security/opaque-token";
import { caughtAsync } from "./helpers";

const admin: ActorContext = {
  userId: "admin-1",
  status: "ACTIVE",
  roles: new Set(["ADMIN"]),
  profileIds: { organizationSupervisor: [] },
};
const student: ActorContext = {
  userId: "stu-1",
  status: "ACTIVE",
  roles: new Set(["STUDENT"]),
  profileIds: { organizationSupervisor: [] },
};
const input = { email: "jane@example.test", role: "UNIVERSITY_SUPERVISOR" };

function build(options: { accountExists?: boolean; blocking?: BlockingInvitation | null; failOutbox?: boolean; failAudit?: boolean } = {}) {
  const world = {
    invitations: [] as { id: string; email: string; role: string; invitedByUserId: string; tokenHash: string }[],
    outbox: [] as OutboxMessage[],
    audit: [] as AuditEvent[],
  };
  const calls: string[] = [];
  const expiresAt = new Date("2026-11-13T10:00:00.000Z");
  const repo: InvitationRepository = {
    accountExists: async (_tx, email) => (calls.push(`accountExists:${email}`), options.accountExists ?? false),
    findBlocking: async (_tx, email) => (calls.push(`findBlocking:${email}`), options.blocking ?? null),
    findByTokenHash: async () => null,
    findEmailById: async () => null,
    findLifecycleForUpdate: async () => null,
    insertUser: async () => undefined,
    insertRole: async () => undefined,
    insertUniversitySupervisorProfile: async () => undefined,
    claim: async () => false,
    cancel: async () => null,
    findMany: async () => [],
    count: async () => 0,
    findAdminById: async () => null,
    insert: async (_tx, data) => {
      calls.push("insert");
      world.invitations.push(data);
      return { createdAt: new Date("2026-11-06T10:00:00.000Z"), expiresAt };
    },
  };
  const outbox: OutboxRepository = {
    enqueue: async (_tx, message) => {
      calls.push("outbox");
      if (options.failOutbox) throw new Error("outbox down");
      world.outbox.push(message);
      return { created: true };
    },
  };
  const audit: AuditRepository = {
    record: async (_tx, event) => {
      calls.push("audit");
      if (options.failAudit) throw new Error("audit down");
      world.audit.push(event);
    },
  };
  const runTx: TxRunner = async (fn) => {
    calls.push("begin");
    const snapshot = structuredClone(world);
    try {
      const result = await fn(undefined as unknown as Tx);
      calls.push("commit");
      return result;
    } catch (error) {
      world.invitations = snapshot.invitations;
      world.outbox = snapshot.outbox;
      world.audit = snapshot.audit;
      calls.push("rollback");
      throw error;
    }
  };
  const service = new InvitationService({
    repo,
    audit,
    outbox,
    appBaseUrl: "https://app.example.test",
    runTx,
    acquireLock: async (_tx, key) => { calls.push(`lock:${key}`); },
  });
  return { service, world, calls, expiresAt };
}

describe("InvitationService.create: success", () => {
  it("writes invitation, outbox, and audit in one transaction after acquiring the lock", async () => {
    const { service, world, calls, expiresAt } = build();
    const created = await service.create(admin, input);
    expect(created).toEqual({
      invitationId: expect.any(String),
      email: input.email,
      role: input.role,
      expiresAt,
    });
    expect(calls).toEqual([
      "begin",
      "lock:invitation-email:jane@example.test",
      "accountExists:jane@example.test",
      "findBlocking:jane@example.test",
      "insert",
      "outbox",
      "audit",
      "commit",
    ]);
    expect(world.invitations).toHaveLength(1);
    expect(world.outbox).toHaveLength(1);
    expect(world.audit).toHaveLength(1);
  });

  it("normalizes email again at the service boundary and uses it for the lock", async () => {
    const { service, calls, world } = build();
    const created = await service.create(admin, { email: "  Jane@Example.TEST ", role: input.role });
    expect(created.email).toBe("jane@example.test");
    expect(calls).toContain("lock:invitation-email:jane@example.test");
    expect(world.invitations[0]!.email).toBe("jane@example.test");
  });

  it("stores only the token hash on the invitation and puts the raw token in outbox", async () => {
    const { service, world } = build();
    const created = await service.create(admin, input);
    const invitation = world.invitations[0]!;
    const payload = world.outbox[0]!.payload as { acceptanceUrl: string; role: string; expiresAt: string };
    const rawToken = new URL(payload.acceptanceUrl).searchParams.get("token")!;
    expect(invitation.tokenHash).toBe(hashToken(rawToken));
    expect(invitation.tokenHash).not.toBe(rawToken);
    expect(JSON.stringify(invitation)).not.toContain(rawToken);
    expect(rawToken.length).toBeGreaterThanOrEqual(43);
    expect(payload).toEqual({
      acceptanceUrl: `https://app.example.test/accept-invitation?token=${encodeURIComponent(rawToken)}`,
      role: "UNIVERSITY_SUPERVISOR",
      expiresAt: created.expiresAt.toISOString(),
    });
    expect(Object.keys(payload).sort()).toEqual(["acceptanceUrl", "expiresAt", "role"]);
  });

  it("uses an invitation-specific outbox idempotency key and has no related user", async () => {
    const { service, world } = build();
    const created = await service.create(admin, input);
    expect(world.outbox[0]).toMatchObject({
      toEmail: input.email,
      templateType: "INVITATION_CREATED",
      idempotencyKey: `invitation-created:${world.invitations[0]!.tokenHash}`,
    });
    expect(world.outbox[0]!.relatedUserId ?? null).toBeNull();
  });

  it("audits only the role and no email, token, hash, or URL", async () => {
    const { service, world } = build();
    const created = await service.create(admin, input);
    const event = world.audit[0]!;
    expect(event).toEqual({
      actorUserId: admin.userId,
      action: "INVITATION_CREATED",
      targetType: "Invitation",
      targetId: created.invitationId,
      metadata: { role: "UNIVERSITY_SUPERVISOR" },
    });
    const text = JSON.stringify(event);
    const raw = new URL(world.outbox[0]!.payload.acceptanceUrl as string).searchParams.get("token")!;
    for (const secret of [input.email, raw, hashToken(raw), "http"]) expect(text).not.toContain(secret);
  });

  it("records the inviting admin on the invitation", async () => {
    const { service, world } = build();
    await service.create(admin, input);
    expect(world.invitations[0]).toMatchObject({ invitedByUserId: admin.userId, role: input.role });
  });
});

describe("InvitationService.create: invitation email", () => {
  it("enqueues the acceptance link and keeps the raw token out of invitation, audit, and response data", async () => {
    const { service, world } = build();
    const created = await service.create(admin, input);

    expect(world.outbox).toHaveLength(1);
    const message = world.outbox[0]!;
    expect(message).toMatchObject({ toEmail: created.email, templateType: "INVITATION_CREATED" });

    const payload = message.payload as { acceptanceUrl: string; expiresAt: string; role: string };
    const url = new URL(payload.acceptanceUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://app.example.test/accept-invitation");
    const raw = url.searchParams.get("token");
    expect(raw).toBeTruthy();

    const stored = world.invitations[0]!;
    expect(stored.tokenHash).toBe(hashToken(raw!));
    expect(message.idempotencyKey).toBe(`invitation-created:${stored.tokenHash}`);
    expect(payload.expiresAt).toBe(created.expiresAt.toISOString());
    expect(Object.keys(payload).sort()).toEqual(["acceptanceUrl", "expiresAt", "role"]);

    expect(JSON.stringify(world.invitations)).not.toContain(raw!);
    expect(JSON.stringify(world.audit)).not.toContain(raw!);
    expect(JSON.stringify(created)).not.toContain(raw!);
  });

  it("uses a fresh token and idempotency key for every invitation", async () => {
    const { service, world } = build();
    await service.create(admin, input);
    await service.create(admin, { ...input, email: "second@example.test" });

    const [first, second] = world.outbox;
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
    const token = (message: typeof first) =>
      new URL((message!.payload as { acceptanceUrl: string }).acceptanceUrl).searchParams.get("token");
    expect(token(first)).not.toBe(token(second));
  });
});

describe("InvitationService.create: refusals write nothing", () => {
  it("refuses non-admins before opening a transaction", async () => {
    const { service, calls, world } = build();
    expect(await caughtAsync(() => service.create(student, input))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(calls).toEqual([]);
    expect(world.invitations).toHaveLength(0);
  });

  it.each(["STUDENT", "ORGANIZATION_SUPERVISOR", "ADMIN", "anything"])(
    "refuses unsupported role %s before opening a transaction",
    async (role) => {
      const { service, calls } = build();
      expect(await caughtAsync(() => service.create(admin, { email: input.email, role })))
        .toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
      expect(calls).toEqual([]);
    },
  );

  it("returns 409 for an existing account without writing", async () => {
    const { service, world, calls } = build({ accountExists: true });
    expect(await caughtAsync(() => service.create(admin, input))).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(world.invitations).toHaveLength(0);
    expect(world.outbox).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
    expect(calls.at(-1)).toBe("rollback");
  });

  it("returns 409 for a pending invitation", async () => {
    const { service, world } = build({ blocking: "PENDING" });
    expect(await caughtAsync(() => service.create(admin, input))).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(world.invitations).toHaveLength(0);
  });

  it("returns 409 for an accepted invitation", async () => {
    const { service, world } = build({ blocking: "ACCEPTED" });
    expect(await caughtAsync(() => service.create(admin, input))).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(world.invitations).toHaveLength(0);
  });

  it("allows issuance when prior invitations are expired or cancelled", async () => {
    const { service, world } = build({ blocking: null });
    await service.create(admin, input);
    expect(world.invitations).toHaveLength(1);
  });
});

describe("InvitationService.create: atomicity", () => {
  it("rolls back the invitation if outbox persistence fails", async () => {
    const { service, world, calls } = build({ failOutbox: true });
    expect(await caughtAsync(() => service.create(admin, input))).toMatchObject({ message: "outbox down" });
    expect(world.invitations).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
    expect(calls.at(-1)).toBe("rollback");
  });

  it("rolls back invitation and outbox if audit persistence fails", async () => {
    const { service, world } = build({ failAudit: true });
    expect(await caughtAsync(() => service.create(admin, input))).toMatchObject({ message: "audit down" });
    expect(world.invitations).toHaveLength(0);
    expect(world.outbox).toHaveLength(0);
  });
});
