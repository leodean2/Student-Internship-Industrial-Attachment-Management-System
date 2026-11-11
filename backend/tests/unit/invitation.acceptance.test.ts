import { describe, expect, it, vi } from "vitest";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { AuditEvent } from "../../src/modules/audit/audit.repository";
import type { InvitationRepository } from "../../src/modules/invitations/invitation.repository";
import { InvitationService, type AcceptInvitationInput } from "../../src/modules/invitations/invitation.service";
import { AttemptLimiter } from "../../src/shared/security/attempt-limiter";
import { hashToken } from "../../src/shared/security/opaque-token";
import { caughtAsync } from "./helpers";

const input: AcceptInvitationInput = {
  token: "raw-invitation-token",
  password: "a secure password",
  name: "Jane Supervisor",
  staffId: null,
  title: null,
  ip: "192.0.2.10",
};

function build(options: {
  found?: boolean;
  status?: "ACCEPTED" | "CANCELLED" | "EXPIRED" | "PENDING";
  accountExists?: boolean;
  claim?: boolean;
  insertUserError?: unknown;
  failAudit?: boolean;
  failHash?: boolean;
  acceptanceThrottle?: Pick<AttemptLimiter, "acquire">;
} = {}) {
  const calls: string[] = [];
  const audits: AuditEvent[] = [];
  const insertedUsers: { id: string; email: string; passwordHash: string; name: string }[] = [];
  const profiles: { id: string; userId: string; staffId: string | null; title: string | null }[] = [];
  const repo: InvitationRepository = {
    accountExists: async (_tx, email) => (calls.push(`account:${email}`), options.accountExists ?? false),
    findBlocking: async () => null,
    findByTokenHash: async (_tx, tokenHash) => {
      calls.push("find");
      expect(tokenHash).toBe(hashToken(input.token));
      return options.found === false ? null : { id: "inv-1", email: "jane@example.test", role: "UNIVERSITY_SUPERVISOR" };
    },
    findEmailById: async () => "jane@example.test",
    findLifecycleForUpdate: async (_tx, invitationId) => (
      calls.push(`lifecycle:${invitationId}`),
      { status: options.status ?? "PENDING" }
    ),
    insertUser: async (_tx, data) => {
      calls.push("user");
      if (options.insertUserError !== undefined) throw options.insertUserError;
      insertedUsers.push(data);
    },
    insertRole: async (_tx, data) => { calls.push(`role:${data.role}`); },
    insertUniversitySupervisorProfile: async (_tx, data) => {
      calls.push("profile");
      profiles.push(data);
    },
    claim: async (_tx, data) => {
      calls.push(`claim:${data.invitationId}`);
      return options.claim ?? true;
    },
    cancel: async () => new Date(),
    findMany: async () => [],
    count: async () => 0,
    findAdminById: async () => null,
    insert: async () => ({ createdAt: new Date(), expiresAt: new Date() }),
  };
  const runTx: TxRunner = async (fn) => {
    calls.push("begin");
    try {
      const result = await fn(undefined as unknown as Tx);
      calls.push("commit");
      return result;
    } catch (error) {
      insertedUsers.length = 0;
      profiles.length = 0;
      calls.push("rollback");
      throw error;
    }
  };
  const permit = { refund: vi.fn(() => calls.push("refund")) };
  const acceptanceThrottle = {
    acquire: vi.fn((key: string) => {
      calls.push(`throttle:${key}`);
      return { allowed: true as const, permit };
    }),
  };
  const service = new InvitationService({
    repo,
    audit: {
      record: async (_tx, event) => {
        calls.push("audit");
        if (options.failAudit) throw new Error("audit unavailable");
        audits.push(event);
      },
    },
    outbox: { enqueue: async () => ({ created: true }) },
    appBaseUrl: "https://app.example.test",
    runTx,
    acceptanceThrottle: options.acceptanceThrottle ?? acceptanceThrottle,
    hashPassword: async (password) => {
      calls.push("hash");
      if (options.failHash) throw new Error("hash unavailable");
      return `hash:${password}`;
    },
    acquireLock: async (_tx, key) => { calls.push(`lock:${key}`); },
  });
  return { service, calls, audits, insertedUsers, profiles, permit, acceptanceThrottle };
}

describe("InvitationService.accept", () => {
  it("hashes before the transaction, locks and rechecks, then creates, claims, audits, and commits", async () => {
    const { service, calls, audits, insertedUsers, profiles, permit, acceptanceThrottle } = build();
    const result = await service.accept({ ...input, name: "Jane", staffId: "STAFF-1", title: "Professor" });
    expect(result).toEqual({ userId: expect.any(String), email: "jane@example.test", role: "UNIVERSITY_SUPERVISOR" });
    expect(calls).toEqual([
      "throttle:invitation-accept:ip:192.0.2.10",
      "hash",
      "begin",
      "find",
      "lock:invitation-email:jane@example.test",
      "lifecycle:inv-1",
      "account:jane@example.test",
      "user",
      "role:UNIVERSITY_SUPERVISOR",
      "profile",
      "claim:inv-1",
      "audit",
      "commit",
      "refund",
    ]);
    expect(acceptanceThrottle.acquire).toHaveBeenCalledOnce();
    expect(insertedUsers[0]).toMatchObject({
      email: "jane@example.test",
      passwordHash: `hash:${input.password}`,
      name: "Jane",
    });
    expect(profiles[0]).toMatchObject({ staffId: "STAFF-1", title: "Professor" });
    expect(audits[0]).toMatchObject({
      actorUserId: result.userId,
      action: "INVITATION_ACCEPTED",
      targetType: "Invitation",
      targetId: "inv-1",
    });
  });

  it.each([
    ["unknown token", { found: false }],
    ["accepted invitation", { status: "ACCEPTED" }],
    ["cancelled invitation", { status: "CANCELLED", accountExists: true }],
    ["expired invitation", { status: "EXPIRED" }],
    ["claim lost after account creation", { claim: false }],
  ] as const)("returns the uniform 404 for an %s and counts it as a failed guess", async (_label, options) => {
    const { service, calls, audits, insertedUsers, permit } = build(options);
    expect(await caughtAsync(() => service.accept(input))).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(permit.refund).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
    if ("status" in options) expect(calls).not.toContain("account:jane@example.test");
    if ("claim" in options && options.claim === false) {
      expect(insertedUsers).toHaveLength(0);
      expect(calls.at(-1)).toBe("rollback");
    }
  });

  it("returns 409 for an existing account and refunds the limiter slot", async () => {
    const { service, calls, insertedUsers, permit } = build({ accountExists: true });
    expect(await caughtAsync(() => service.accept(input))).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(insertedUsers).toHaveLength(0);
    expect(calls).not.toContain("user");
    expect(permit.refund).toHaveBeenCalledOnce();
  });

  it("maps a concurrent duplicate-account insert to 409 and refunds the limiter slot", async () => {
    const { service, calls, insertedUsers, permit } = build({ insertUserError: { code: "23505" } });
    expect(await caughtAsync(() => service.accept(input))).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(insertedUsers).toHaveLength(0);
    expect(calls).toContain("rollback");
    expect(permit.refund).toHaveBeenCalledOnce();
  });

  it("propagates non-unique user insert failures", async () => {
    const failure = { code: "23503", message: "foreign key violation" };
    const { service, permit } = build({ insertUserError: failure });
    await expect(service.accept(input)).rejects.toBe(failure);
    expect(permit.refund).toHaveBeenCalledOnce();
  });

  it("refunds limiter slots when validation has succeeded but hashing or persistence fails", async () => {
    const hashFailure = build({ failHash: true });
    await expect(hashFailure.service.accept(input)).rejects.toThrow("hash unavailable");
    expect(hashFailure.permit.refund).toHaveBeenCalledOnce();

    const auditFailure = build({ failAudit: true });
    await expect(auditFailure.service.accept(input)).rejects.toThrow("audit unavailable");
    expect(auditFailure.insertedUsers).toHaveLength(0);
    expect(auditFailure.calls.indexOf("rollback")).toBeLessThan(auditFailure.calls.indexOf("refund"));
    expect(auditFailure.permit.refund).toHaveBeenCalledOnce();
  });

  it("rejects a rate-limited IP before password hashing", async () => {
    const calls: string[] = [];
    const blocked = new InvitationService({
      repo: {
        accountExists: async () => false,
        findBlocking: async () => null,
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
        insert: async () => ({ createdAt: new Date(), expiresAt: new Date() }),
      },
      audit: { record: async () => undefined },
      outbox: { enqueue: async () => ({ created: true }) },
      appBaseUrl: "https://app.example.test",
      runTx: async () => { throw new Error("transaction should not start"); },
      acceptanceThrottle: {
        acquire: (key: string) => {
          calls.push(`throttle:${key}`);
          return { allowed: false, retryAfterSeconds: 30 };
        },
      },
      hashPassword: async () => { throw new Error("hashing should not start"); },
    });
    expect(await caughtAsync(() => blocked.accept(input))).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: 30,
    });
    expect(calls).toEqual(["throttle:invitation-accept:ip:192.0.2.10"]);
  });

  it("allows ten failed guesses per IP in fifteen minutes and rejects the eleventh", async () => {
    const limiter = new AttemptLimiter({ limit: 10, windowMs: 15 * 60 * 1000, now: () => 1_000 });
    const { service } = build({ found: false, acceptanceThrottle: limiter });
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await caughtAsync(() => service.accept(input))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
    expect(await caughtAsync(() => service.accept(input))).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: expect.any(Number),
    });
  });
});
