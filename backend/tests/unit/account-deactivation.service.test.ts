import { describe, expect, it } from "vitest";
import { AppError } from "../../src/shared/errors";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import { AccountDeactivationService } from "../../src/modules/account-deactivation/account-deactivation.service";
import type { AccountDeactivationRepository, DeactivationTarget } from "../../src/modules/account-deactivation/account-deactivation.repository";
import type { AuditRepository } from "../../src/modules/audit/audit.repository";
import type { OutboxEnqueuer } from "../../src/modules/email-outbox/outbox.repository";
import { SYSTEM_USER_ID } from "../../src/shared/system-user";

const ADMIN_ID = "admin-user-id";
const TARGET_ID = "target-user-id";
const TARGET_EMAIL = "target@example.test";

function makeActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: ADMIN_ID,
    status: "ACTIVE",
    roles: new Set(["ADMIN"]),
    profileIds: { admin: "ap1", organizationSupervisor: [] },
    ...overrides,
  } as ActorContext;
}

function makeTarget(overrides: Partial<DeactivationTarget> = {}): DeactivationTarget {
  return {
    userId: TARGET_ID,
    email: TARGET_EMAIL,
    status: "ACTIVE",
    roles: ["STUDENT"],
    ...overrides,
  };
}

interface Captured {
  deactivations: { userId: string; expectedStatus: string }[];
  revocations: string[];
  auditEvents: { action: string; actorUserId: string; targetId: string; metadata?: Record<string, unknown> }[];
  outboxMessages: { templateType: string; idempotencyKey: string }[];
  sqlStatements: string[];
}

function buildDeps(
  target: DeactivationTarget | null = makeTarget(),
  deactivateResult = true,
  revokedAssignments = 0,
) {
  const captured: Captured = {
    deactivations: [],
    revocations: [],
    auditEvents: [],
    outboxMessages: [],
    sqlStatements: [],
  };
  const transaction = {
    $executeRaw: async (query: TemplateStringsArray) => {
      captured.sqlStatements.push(query.join("?"));
      return 1;
    },
  } as unknown as Tx;
  const transactionRunner: TxRunner = async (fn) => fn(transaction);

  const repo: AccountDeactivationRepository = {
    findAndLockTarget: async () => target,
    deactivate: async (_tx, userId, expectedStatus) => {
      captured.deactivations.push({ userId, expectedStatus });
      return deactivateResult;
    },
    revokeReviewerAssignments: async (_tx, userId) => {
      captured.revocations.push(userId);
      return revokedAssignments;
    },
  };

  const audit: AuditRepository = {
    record: async (_tx, event) => {
      captured.auditEvents.push({
        action: event.action,
        actorUserId: event.actorUserId,
        targetId: event.targetId,
        metadata: event.metadata as Record<string, unknown> | undefined,
      });
    },
  };

  const outbox: OutboxEnqueuer = {
    enqueue: async (_tx, msg) => {
      captured.outboxMessages.push({ templateType: msg.templateType, idempotencyKey: msg.idempotencyKey });
      return { created: true };
    },
  };

  const service = new AccountDeactivationService({ repo, audit, outbox, runTx: transactionRunner });
  return { service, captured };
}

async function rejects(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (e) { return e as AppError; }
  throw new Error("expected a rejection");
}

// ── §1: Authorization ─────────────────────────────────────────────────────────

describe("authorization (C3 §1)", () => {
  it("non-ADMIN receives 403", async () => {
    const { service } = buildDeps();
    const actor = makeActor({ roles: new Set(["STUDENT"]) });
    const err = await rejects(service.deactivate(actor, TARGET_ID));
    expect(err.status).toBe(403);
  });

  it("self-deactivation receives 403", async () => {
    const { service } = buildDeps();
    const actor = makeActor();
    const err = await rejects(service.deactivate(actor, ADMIN_ID));
    expect(err.status).toBe(403);
  });

  it("ADMIN-on-ADMIN deactivation receives 403", async () => {
    const { service } = buildDeps(makeTarget({ roles: ["ADMIN"] }));
    const err = await rejects(service.deactivate(makeActor(), TARGET_ID));
    expect(err.status).toBe(403);
  });

  it("SYSTEM cannot be deactivated", async () => {
    const { service, captured } = buildDeps(makeTarget({ userId: SYSTEM_USER_ID, roles: [] }));
    const err = await rejects(service.deactivate(makeActor(), SYSTEM_USER_ID));
    expect(err.status).toBe(403);
    expect(captured.deactivations).toHaveLength(0);
  });
});

// ── §2: Supported targets ─────────────────────────────────────────────────────

describe("supported target accounts (C3 §2)", () => {
  it("ADMIN can deactivate an ACTIVE student", async () => {
    const { service, captured } = buildDeps(makeTarget({ roles: ["STUDENT"] }));
    await service.deactivate(makeActor(), TARGET_ID);
    expect(captured.deactivations).toHaveLength(1);
  });

  it("ADMIN can deactivate an ACTIVE university supervisor", async () => {
    const { service, captured } = buildDeps(makeTarget({ roles: ["UNIVERSITY_SUPERVISOR"] }));
    await service.deactivate(makeActor(), TARGET_ID);
    expect(captured.deactivations).toHaveLength(1);
  });

  it("ADMIN can deactivate an ACTIVE organization supervisor", async () => {
    const { service, captured } = buildDeps(makeTarget({ roles: ["ORGANIZATION_SUPERVISOR"] }));
    await service.deactivate(makeActor(), TARGET_ID);
    expect(captured.deactivations).toHaveLength(1);
  });

  it("cannot deactivate a PENDING_VERIFICATION account", async () => {
    const { service, captured } = buildDeps(makeTarget({ status: "PENDING_VERIFICATION" }));
    const err = await rejects(service.deactivate(makeActor(), TARGET_ID));
    expect(err.status).toBe(403);
    expect(captured.deactivations).toHaveLength(0);
    expect(captured.auditEvents).toHaveLength(0);
    expect(captured.outboxMessages).toHaveLength(0);
  });

  it("returns 404 for an unknown user", async () => {
    const { service } = buildDeps(null);
    const err = await rejects(service.deactivate(makeActor(), "nonexistent-id"));
    expect(err.status).toBe(404);
  });
});

// ── §3: Already-deactivated ───────────────────────────────────────────────────

describe("already-deactivated account (C3 §3)", () => {
  it("returns 409 when the account is already DEACTIVATED", async () => {
    const { service } = buildDeps(makeTarget({ status: "DEACTIVATED" }));
    const err = await rejects(service.deactivate(makeActor(), TARGET_ID));
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONFLICT");
  });

  it("does not create duplicate audit events or notifications for an already-deactivated account", async () => {
    const { service, captured } = buildDeps(makeTarget({ status: "DEACTIVATED" }));
    await service.deactivate(makeActor(), TARGET_ID).catch(() => undefined);
    expect(captured.auditEvents).toHaveLength(0);
    expect(captured.outboxMessages).toHaveLength(0);
  });
});

// ── §4: Reviewer assignment revocation ───────────────────────────────────────

describe("reviewer assignment revocation (C3 §4)", () => {
  it("revokes reviewer assignments when deactivating a university supervisor", async () => {
    const { service, captured } = buildDeps(makeTarget({ roles: ["UNIVERSITY_SUPERVISOR"] }), true, 2);
    await service.deactivate(makeActor(), TARGET_ID);
    expect(captured.revocations).toContain(TARGET_ID);
  });

  it("does not revoke reviewer assignments for a student", async () => {
    const { service, captured } = buildDeps(makeTarget({ roles: ["STUDENT"] }));
    await service.deactivate(makeActor(), TARGET_ID);
    expect(captured.revocations).toHaveLength(0);
  });

  it("does not revoke reviewer assignments for an organization supervisor", async () => {
    const { service, captured } = buildDeps(makeTarget({ roles: ["ORGANIZATION_SUPERVISOR"] }));
    await service.deactivate(makeActor(), TARGET_ID);
    expect(captured.revocations).toHaveLength(0);
  });
});

// ── §6: Notification ─────────────────────────────────────────────────────────

describe("deactivation notification (C3 §6)", () => {
  it("enqueues an ACCOUNT_DEACTIVATED email", async () => {
    const { service, captured } = buildDeps();
    await service.deactivate(makeActor(), TARGET_ID);
    const msg = captured.outboxMessages.find((m) => m.templateType === "ACCOUNT_DEACTIVATED");
    expect(msg).toBeDefined();
  });

  it("notification idempotency key is scoped to the userId", async () => {
    const { service, captured } = buildDeps();
    await service.deactivate(makeActor(), TARGET_ID);
    const msg = captured.outboxMessages.find((m) => m.templateType === "ACCOUNT_DEACTIVATED");
    expect(msg?.idempotencyKey).toBe(`account-deactivated:${TARGET_ID}`);
  });

  it("audit metadata does not contain internal deactivation reason or sensitive data", async () => {
    const { service, captured } = buildDeps();
    await service.deactivate(makeActor(), TARGET_ID);
    const event = captured.auditEvents.find((e) => e.action === "ACCOUNT_DEACTIVATED");
    expect(event).toBeDefined();
    // metadata must not contain token, password, or any secret field
    const metaStr = JSON.stringify(event!.metadata ?? {});
    expect(metaStr).not.toContain("reason");
    expect(metaStr).not.toContain("note");
    expect(metaStr).not.toContain("token");
  });
});

// ── §7: Session revocation ────────────────────────────────────────────────────

describe("session revocation (C3 §7)", () => {
  it("revokes refresh sessions inside the deactivation transaction", async () => {
    const { service, captured } = buildDeps();
    await service.deactivate(makeActor(), TARGET_ID);
    expect(captured.sqlStatements.some((sql) => sql.includes("UPDATE refresh_tokens"))).toBe(true);
  });
});

// ── Audit event ───────────────────────────────────────────────────────────────

describe("audit event", () => {
  it("records ACCOUNT_DEACTIVATED with the admin as actor and target userId as targetId", async () => {
    const { service, captured } = buildDeps();
    await service.deactivate(makeActor(), TARGET_ID);
    const event = captured.auditEvents.find((e) => e.action === "ACCOUNT_DEACTIVATED");
    expect(event?.actorUserId).toBe(ADMIN_ID);
    expect(event?.targetId).toBe(TARGET_ID);
  });
});
