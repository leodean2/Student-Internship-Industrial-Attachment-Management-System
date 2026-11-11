import { describe, expect, it, vi } from "vitest";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import type { AuditEvent } from "../../src/modules/audit/audit.repository";
import {
  PrismaInvitationRepository,
  type InvitationListRecord,
  type InvitationRepository,
} from "../../src/modules/invitations/invitation.repository";
import { InvitationService } from "../../src/modules/invitations/invitation.service";
import { invitationListQuerySchema } from "../../src/modules/invitations/invitation.validation";
import { caughtAsync } from "./helpers";

const now = new Date("2026-11-06T10:00:00.000Z");
const cancelledAt = new Date("2026-11-06T10:05:00.000Z");
const admin: ActorContext = {
  userId: "admin-1",
  status: "ACTIVE",
  roles: new Set(["ADMIN"]),
  profileIds: { organizationSupervisor: [] },
};
const student: ActorContext = {
  userId: "student-1",
  status: "ACTIVE",
  roles: new Set(["STUDENT"]),
  profileIds: { organizationSupervisor: [] },
};

const record = (overrides: Partial<InvitationListRecord> = {}): InvitationListRecord => ({
  id: "inv-1",
  email: "person@example.test",
  role: "UNIVERSITY_SUPERVISOR",
  organizationId: null,
  invitedByUserId: "admin-1",
  acceptedByUserId: null,
  createdAt: new Date("2026-11-06T09:00:00.000Z"),
  expiresAt: new Date("2026-11-13T10:00:00.000Z"),
  acceptedAt: null,
  revokedAt: null,
  ...overrides,
});

function build() {
  const audits: AuditEvent[] = [];
  const queries: { where: unknown; skip?: number; take?: number }[] = [];
  let lifecycle: "ACCEPTED" | "CANCELLED" | "EXPIRED" | "PENDING" = "PENDING";
  const rows = [
    record({
      id: "accepted",
      acceptedByUserId: "user-1",
      acceptedAt: new Date("2026-11-05T10:00:00.000Z"),
      revokedAt: cancelledAt,
      expiresAt: new Date("2026-11-05T09:00:00.000Z"),
    }),
    record({ id: "cancelled", revokedAt: cancelledAt, expiresAt: new Date("2026-11-05T09:00:00.000Z") }),
    record({ id: "expired", expiresAt: new Date("2026-11-06T09:59:59.000Z") }),
    record({ id: "pending" }),
  ];
  const repository: InvitationRepository = {
    accountExists: async () => false,
    findBlocking: async () => null,
    findByTokenHash: async () => null,
    findEmailById: async (_tx, id) => id === "inv-1" ? "person@example.test" : null,
    findLifecycleForUpdate: async () => ({ status: lifecycle }),
    insertUser: async () => undefined,
    insertRole: async () => undefined,
    insertUniversitySupervisorProfile: async () => undefined,
    claim: async () => false,
    cancel: async () => cancelledAt,
    findMany: async (_tx, where, skip, take) => {
      queries.push({ where, skip, take });
      return rows;
    },
    count: async (_tx, where) => {
      queries.push({ where });
      return rows.length;
    },
    findAdminById: async (_tx, id) => rows.find((row) => row.id === id) ?? null,
    insert: async () => ({ createdAt: now, expiresAt: now }),
  };
  const tx = { $queryRaw: async () => [{ now }] } as unknown as Tx;
  const runTx: TxRunner = (fn) => fn(tx);
  const service = new InvitationService({
    repo: repository,
    audit: { record: async (_tx, event) => { audits.push(event); } },
    outbox: { enqueue: async () => ({ created: true }) },
    appBaseUrl: "https://app.example.test",
    runTx,
    acquireLock: async () => undefined,
  });
  return { service, audits, queries, setLifecycle: (status: typeof lifecycle) => { lifecycle = status; } };
}

describe("InvitationService administrative lifecycle", () => {
  it("cancels a pending invitation under the email lock and audits without deleting it", async () => {
    const { service, audits } = build();
    await expect(service.cancel(admin, "inv-1")).resolves.toEqual({
      invitationId: "inv-1",
      status: "CANCELLED",
      revokedAt: cancelledAt.toISOString(),
    });
    expect(audits).toEqual([{
      actorUserId: admin.userId,
      action: "INVITATION_CANCELLED",
      targetType: "Invitation",
      targetId: "inv-1",
      metadata: { role: "UNIVERSITY_SUPERVISOR" },
    }]);
  });

  it.each([
    ["accepted", "INVITATION_ALREADY_ACCEPTED"],
    ["cancelled", "INVITATION_ALREADY_CANCELLED"],
    ["expired", "INVITATION_EXPIRED"],
  ] as const)("returns a state-specific conflict for a %s invitation", async (status, code) => {
    const { service, setLifecycle, audits } = build();
    setLifecycle(status === "accepted" ? "ACCEPTED" : status === "cancelled" ? "CANCELLED" : "EXPIRED");
    const error = await caughtAsync(() => service.cancel(admin, "inv-1"));
    expect(error).toMatchObject({ status: 409, code });
    expect(audits).toHaveLength(0);
  });

  it("returns 404 only when the invitation id does not exist", async () => {
    const { service } = build();
    await expect(service.cancel(admin, "missing")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("blocks non-admin listing and cancellation before database work", async () => {
    const { service } = build();
    await expect(service.list(student, { page: 1, limit: 20 })).rejects.toMatchObject({ status: 403 });
    await expect(service.cancel(student, "inv-1")).rejects.toMatchObject({ status: 403 });
  });

  it("derives lifecycle status in precedence order using the database clock", async () => {
    const { service } = build();
    const result = await service.list(admin, { page: 1, limit: 20 });
    expect(result.data.map(({ id, status }) => [id, status])).toEqual([
      ["accepted", "ACCEPTED"],
      ["cancelled", "CANCELLED"],
      ["expired", "EXPIRED"],
      ["pending", "PENDING"],
    ]);
  });

  it("uses the same status, exact email, and database-time filters for page data and count", async () => {
    const { service, queries } = build();
    await service.list(admin, { page: 3, limit: 5, status: "PENDING", email: "person@example.test" });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ skip: 10, take: 5 });
    expect(queries[0]!.where).toEqual(queries[1]!.where);
    expect(queries[0]!.where).toEqual({
      AND: [
        { acceptedByUserId: null, revokedAt: null, expiresAt: { gt: now } },
        { email: "person@example.test" },
      ],
    });
  });

  it("normalizes the exact email filter and rejects the old search parameter", () => {
    expect(invitationListQuerySchema.parse({ email: "  PERSON@EXAMPLE.TEST " })).toMatchObject({
      email: "person@example.test",
    });
    expect(() => invitationListQuerySchema.parse({ search: "person" })).toThrow();
  });

  it("uses stable newest-first pagination in the Prisma repository", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaInvitationRepository();
    const tx = { invitation: { findMany } } as unknown as Tx;
    const where = { email: "person@example.test" };
    await repository.findMany(tx, where, 10, 5);
    expect(findMany).toHaveBeenCalledWith({
      where,
      skip: 10,
      take: 5,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        email: true,
        role: true,
        organizationId: true,
        invitedByUserId: true,
        acceptedByUserId: true,
        createdAt: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
    });
  });

  it("returns 404 for a missing administrative retrieval", async () => {
    const { service } = build();
    await expect(service.get(admin, "missing")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
