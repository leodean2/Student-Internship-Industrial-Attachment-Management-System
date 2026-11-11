import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { ActorContext } from "../../src/modules/auth/actor-context";
import type { OutboxMessage } from "../../src/modules/email-outbox/outbox.repository";
import { RegistrationReviewPolicy } from "../../src/modules/registration-reviewer/registration-review.policy";
import type {
  RegistrationReviewRepository,
  ReviewProfile,
} from "../../src/modules/registration-review/registration-review.repository";
import { RegistrationReviewService } from "../../src/modules/registration-review/registration-review.service";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const CIT1 = "CIT-221-001/2024";
const CIT2 = "CIT-221-002/2024";
const BUS1 = "BUS-221-001/2024";
const BASIS = { basis: "checked against the roster" };
const REASON = { reason: "does not match the roster" };

const actorOf = (userId: string, ...roles: string[]) =>
  ({ userId, status: "ACTIVE", roles: new Set(roles), profileIds: { organizationSupervisor: [] } }) as unknown as ActorContext;
const reviewer = (id: string) => actorOf(id, "UNIVERSITY_SUPERVISOR");

function profileOf(id: string, overrides: Partial<ReviewProfile> = {}): ReviewProfile {
  return {
    id,
    userId: `user-${id}`,
    name: `Student ${id}`,
    email: `${id}@example.test`,
    emailVerifiedAt: new Date("2026-11-09T09:00:00.000Z"),
    userStatus: "PENDING_VERIFICATION",
    userCreatedAt: new Date("2026-11-09T08:00:00.000Z"),
    registrationNumber: CIT1,
    rejectedRegistrationNumber: null,
    registrationDepartmentCode: "CIT",
    registrationStatus: "PENDING",
    registrationDecidedAt: null,
    registrationDecidedByUserId: null,
    registrationDecisionBasis: null,
    registrationDecisionReason: null,
    ...overrides,
  };
}

function build(options: { failOutbox?: boolean } = {}) {
  const world = {
    profiles: [profileOf("p1")],
    roster: new Map<string, string | null>([[CIT1, "ACTIVE"], [CIT2, "ACTIVE"], [BUS1, "ACTIVE"]]),
    reviewers: new Map<string, string[]>([
      ["rev-cit", ["CIT"]],
      ["rev-bus", ["BUS"]],
      ["rev-both", ["CIT", "BUS"]],
    ]),
    audit: [] as Record<string, unknown>[],
    outbox: [] as OutboxMessage[],
    lockedProfiles: [] as string[],
  };
  const runTx: TxRunner = async (fn) => {
    const snapshot = structuredClone(world);
    try {
      return await fn(undefined as unknown as Tx);
    } catch (error) {
      world.profiles = snapshot.profiles;
      world.audit = snapshot.audit;
      world.outbox = snapshot.outbox;
      world.lockedProfiles = snapshot.lockedProfiles;
      throw error;
    }
  };
  const clean = {
    registrationDecidedAt: null,
    registrationDecidedByUserId: null,
    registrationDecisionBasis: null,
    registrationDecisionReason: null,
  };
  const repo: RegistrationReviewRepository = {
    findById: async (_tx, id) => {
      const profile = world.profiles.find((row) => row.id === id);
      return profile ? structuredClone(profile) : null;
    },
    lockById: async (_tx, id) => {
      world.lockedProfiles.push(id);
      const profile = world.profiles.find((row) => row.id === id);
      return profile ? structuredClone(profile) : null;
    },
    list: async (_tx, query) => world.profiles
      .filter((profile) => query.departments.includes(profile.registrationDepartmentCode))
      .filter((profile) => profile.registrationStatus === query.status)
      .filter((profile) => query.emailVerified === undefined || (profile.emailVerifiedAt !== null) === query.emailVerified)
      .filter((profile) => !query.registrationNumber ||
        profile.registrationNumber === query.registrationNumber ||
        profile.rejectedRegistrationNumber === query.registrationNumber)
      .slice(0, query.limit),
    history: async (_tx, profile) => world.audit
      .filter((entry) => entry.targetId === profile.id)
      .map((entry) => ({
        action: entry.action as string,
        actorUserId: entry.actorUserId as string,
        occurredAt: NOW,
      })),
    markConfirmed: async (_tx, input) => {
      const profile = world.profiles.find((row) =>
        row.id === input.profileId &&
        row.registrationStatus === "PENDING" &&
        row.registrationNumber === input.registrationNumber);
      if (!profile) return null;
      Object.assign(profile, {
        ...clean,
        registrationStatus: "CONFIRMED",
        registrationDecidedAt: NOW,
        registrationDecidedByUserId: input.reviewerId,
        registrationDecisionBasis: input.basis,
      });
      return NOW;
    },
    markRejected: async (_tx, input) => {
      const profile = world.profiles.find((row) =>
        row.id === input.profileId &&
        row.registrationStatus === "PENDING" &&
        row.registrationNumber === input.claimedNumber);
      if (!profile) return null;
      Object.assign(profile, {
        registrationStatus: "REJECTED",
        registrationNumber: null,
        rejectedRegistrationNumber: input.claimedNumber,
        registrationDecidedAt: NOW,
        registrationDecidedByUserId: input.reviewerId,
        registrationDecisionReason: input.reason,
        registrationDecisionBasis: null,
      });
      return NOW;
    },
    applyCorrection: async (_tx, input) => {
      const profile = world.profiles.find((row) =>
        row.id === input.profileId && row.registrationStatus === input.expectedStatus);
      if (!profile) return false;
      if (world.profiles.some((other) =>
        other.id !== profile.id && other.registrationNumber === input.registrationNumber)) {
        throw new Prisma.PrismaClientKnownRequestError("unique registration number", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["registrationNumber"] },
        });
      }
      Object.assign(profile, {
        ...clean,
        registrationNumber: input.registrationNumber,
        registrationDepartmentCode: input.departmentCode,
        registrationStatus: "PENDING",
        rejectedRegistrationNumber: null,
      });
      return true;
    },
    activateUser: async (_tx, userId) => {
      const profile = world.profiles.find((row) =>
        row.userId === userId &&
        row.userStatus === "PENDING_VERIFICATION" &&
        row.emailVerifiedAt !== null);
      if (!profile) return false;
      profile.userStatus = "ACTIVE";
      return true;
    },
  };
  const entryFor = (number: string) => world.roster.has(number)
    ? {
        id: `entry-${number}`,
        registrationNumber: number,
        departmentCode: number.split("-")[0]!,
        studentName: null,
        rosterStatus: world.roster.get(number) ?? null,
        importId: "import-1",
        importedAt: NOW,
      }
    : null;
  const service = new RegistrationReviewService({
    repo,
    policy: new RegistrationReviewPolicy({
      lockActiveDepartments: async (_tx, userId) => world.reviewers.get(userId) ?? [],
    }),
    roster: { match: async (_tx, number) => {
      const entry = entryFor(number);
      if (!entry) return { result: "not_found" };
      return {
        result: entry.rosterStatus === "ACTIVE" ? "found" : "found_ineligible",
        entryId: entry.id,
        importId: entry.importId,
        importedAt: entry.importedAt,
        studentName: entry.studentName,
      };
    } },
    rosterRepo: {
      findEntriesByNumbers: async (_tx, numbers) =>
        numbers.flatMap((number) => {
          const entry = entryFor(number);
          return entry ? [entry] : [];
        }),
    },
    audit: {
      record: async (_tx: Tx, entry: Record<string, unknown>) => {
        world.audit.push(entry);
      },
    } as never,
    outbox: {
      enqueue: async (_tx, message) => {
        if (options.failOutbox) throw new Error("outbox down");
        world.outbox.push(message);
        return { created: true };
      },
    },
    appBaseUrl: "https://app.example.test",
    runTx,
  });
  const invariantHolds = () => world.profiles.every((profile) =>
    profile.userStatus !== "ACTIVE" ||
    (profile.registrationStatus === "CONFIRMED" && profile.emailVerifiedAt !== null));
  return { service, world, invariantHolds };
}

describe("RegistrationReviewService.confirm", () => {
  it("confirms, activates, audits and queues email atomically without leaking secrets to audit", async () => {
    const { service, world, invariantHolds } = build();
    expect(await service.confirm(reviewer("rev-cit"), "p1", BASIS)).toEqual({
      profileId: "p1",
      status: "CONFIRMED",
      decidedAt: NOW,
    });
    expect(world.profiles[0]).toMatchObject({
      registrationStatus: "CONFIRMED",
      registrationDecidedByUserId: "rev-cit",
      registrationDecisionBasis: BASIS.basis,
      userStatus: "ACTIVE",
    });
    expect(world.lockedProfiles).toEqual(["p1"]);
    expect(world.audit[0]).toMatchObject({
      action: "REGISTRATION_NUMBER_CONFIRMED",
      targetType: "StudentProfile",
      metadata: {
        fromStatus: "PENDING",
        toStatus: "CONFIRMED",
        departmentCode: "CIT",
        rosterImportId: "import-1",
        rosterMatch: "found",
      },
    });
    expect(world.outbox).toMatchObject([
      { templateType: "REGISTRATION_CONFIRMED", toEmail: "p1@example.test", relatedUserId: "user-p1" },
    ]);
    expect(JSON.stringify(world.audit)).not.toContain(CIT1);
    expect(JSON.stringify(world.audit)).not.toContain(BASIS.basis);
    expect(invariantHolds()).toBe(true);
  });

  it("requires assignment, scope, verified email and an eligible roster match", async () => {
    const { service, world } = build();
    await expect(service.confirm(actorOf("admin", "ADMIN"), "p1", BASIS)).rejects.toMatchObject({ status: 403 });
    await expect(service.confirm(reviewer("rev-bus"), "p1", BASIS)).rejects.toMatchObject({ status: 404 });
    world.profiles[0]!.userId = "rev-cit";
    await expect(service.confirm(reviewer("rev-cit"), "p1", BASIS)).rejects.toMatchObject({ status: 403 });
    world.profiles[0]!.userId = "user-p1";
    world.profiles[0]!.emailVerifiedAt = null;
    await expect(service.confirm(reviewer("rev-cit"), "p1", BASIS)).rejects.toMatchObject({ status: 409 });
    world.profiles[0]!.emailVerifiedAt = NOW;
    world.roster.set(CIT1, "WITHDRAWN");
    await expect(service.confirm(reviewer("rev-cit"), "p1", BASIS)).rejects.toMatchObject({ status: 409 });
    expect(world.profiles[0]).toMatchObject({ registrationStatus: "PENDING", userStatus: "PENDING_VERIFICATION" });
    expect(world.outbox).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
  });

  it("rolls the decision and activation back if the email cannot be queued", async () => {
    const { service, world, invariantHolds } = build({ failOutbox: true });
    await expect(service.confirm(reviewer("rev-cit"), "p1", BASIS)).rejects.toThrow("outbox down");
    expect(world.profiles[0]).toMatchObject({
      registrationStatus: "PENDING",
      userStatus: "PENDING_VERIFICATION",
      registrationDecidedAt: null,
    });
    expect(world.audit).toHaveLength(0);
    expect(invariantHolds()).toBe(true);
  });
});

describe("RegistrationReviewService.reject", () => {
  it("releases the claimed number and keeps the account pending without auditing the reason", async () => {
    const { service, world, invariantHolds } = build();
    world.profiles[0]!.emailVerifiedAt = null;
    expect(await service.reject(reviewer("rev-cit"), "p1", REASON)).toEqual({
      profileId: "p1",
      status: "REJECTED",
      decidedAt: NOW,
    });
    expect(world.profiles[0]).toMatchObject({
      registrationStatus: "REJECTED",
      registrationNumber: null,
      rejectedRegistrationNumber: CIT1,
      registrationDecisionReason: REASON.reason,
      userStatus: "PENDING_VERIFICATION",
    });
    expect(world.audit[0]).toMatchObject({
      action: "REGISTRATION_NUMBER_REJECTED",
      metadata: { fromStatus: "PENDING", toStatus: "REJECTED", departmentCode: "CIT" },
    });
    expect(JSON.stringify(world.audit)).not.toContain(REASON.reason);
    expect(JSON.stringify(world.audit)).not.toContain(CIT1);
    expect(world.outbox).toMatchObject([{ templateType: "REGISTRATION_REJECTED", payload: {} }]);
    expect(invariantHolds()).toBe(true);
  });

  it("rejects repeat decisions and hides profiles outside the reviewer scope", async () => {
    const { service } = build();
    await expect(service.reject(reviewer("rev-bus"), "p1", REASON)).rejects.toMatchObject({ status: 404 });
    await service.reject(reviewer("rev-cit"), "p1", REASON);
    await expect(service.reject(reviewer("rev-cit"), "p1", REASON)).rejects.toMatchObject({ status: 409 });
  });
});

describe("RegistrationReviewService.correct", () => {
  it("requires scope in both departments and resets a rejected profile to pending", async () => {
    const { service, world } = build();
    await service.reject(reviewer("rev-both"), "p1", REASON);
    expect(await service.correct(reviewer("rev-both"), "p1", { registrationNumber: BUS1 })).toEqual({
      profileId: "p1",
      status: "PENDING",
      decidedAt: null,
    });
    expect(world.profiles[0]).toMatchObject({
      registrationNumber: BUS1,
      registrationDepartmentCode: "BUS",
      registrationStatus: "PENDING",
      rejectedRegistrationNumber: null,
      registrationDecidedAt: null,
      registrationDecidedByUserId: null,
      registrationDecisionBasis: null,
      registrationDecisionReason: null,
      userStatus: "PENDING_VERIFICATION",
    });
    expect(world.outbox).toHaveLength(1);
    expect(world.audit.at(-1)).toMatchObject({
      action: "REGISTRATION_NUMBER_CORRECTED",
      targetType: "StudentProfile",
      metadata: {
        fromStatus: "REJECTED",
        toStatus: "PENDING",
        fromDepartmentCode: "CIT",
        toDepartmentCode: "BUS",
      },
    });
    expect(JSON.stringify(world.audit.at(-1))).not.toContain(CIT1);
    expect(JSON.stringify(world.audit.at(-1))).not.toContain(BUS1);
  });

  it("denies current-only and destination-only reviewers and rejects invalid corrections", async () => {
    const { service, world } = build();
    const before = structuredClone(world.profiles[0]);
    await expect(service.correct(reviewer("rev-cit"), "p1", { registrationNumber: BUS1 }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.correct(reviewer("rev-bus"), "p1", { registrationNumber: BUS1 }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.correct(actorOf("admin", "ADMIN"), "p1", { registrationNumber: BUS1 }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.correct(reviewer("rev-cit"), "missing", { registrationNumber: CIT2 }))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.correct(reviewer("rev-cit"), "p1", { registrationNumber: CIT1 }))
      .rejects.toMatchObject({ status: 400 });
    expect(world.profiles[0]).toEqual(before);
    expect(world.audit).toHaveLength(0);
  });

  it("maps a taken number to conflict and cannot change confirmed profiles", async () => {
    const { service, world } = build();
    world.profiles.push(profileOf("p2", { registrationNumber: CIT2 }));
    await expect(service.correct(reviewer("rev-cit"), "p1", { registrationNumber: CIT2 }))
      .rejects.toMatchObject({ status: 409 });
    world.profiles[0]!.registrationStatus = "CONFIRMED";
    await expect(service.correct(reviewer("rev-cit"), "p1", { registrationNumber: "CIT-221-003/2024" }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe("RegistrationReviewService.list and get", () => {
  it("scopes list results, applies filters and returns roster match states", async () => {
    const { service, world } = build();
    world.profiles.push(profileOf("p2", {
      registrationNumber: BUS1,
      registrationDepartmentCode: "BUS",
      emailVerifiedAt: null,
    }));
    world.profiles.push(profileOf("p3", { registrationNumber: "CIT-221-050/2024" }));
    const cit = await service.list(reviewer("rev-cit"), { status: "PENDING", limit: 50 });
    expect(cit.map((item) => [item.profileId, item.rosterMatch])).toEqual([
      ["p1", "found"],
      ["p3", "not_found"],
    ]);
    expect(await service.list(reviewer("rev-both"), {
      status: "PENDING",
      emailVerified: false,
      limit: 50,
    })).toHaveLength(1);
    await expect(service.list(reviewer("nobody"), { status: "PENDING", limit: 50 }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("returns history only for an in-scope profile", async () => {
    const { service } = build();
    await service.reject(reviewer("rev-cit"), "p1", REASON);
    const detail = await service.get(reviewer("rev-cit"), "p1");
    expect(detail).toMatchObject({ profileId: "p1", status: "REJECTED", rosterMatch: null });
    expect(detail.history.map(({ action }) => action)).toEqual(["REGISTRATION_NUMBER_REJECTED"]);
    await expect(service.get(reviewer("rev-bus"), "p1")).rejects.toMatchObject({ status: 404 });
    await expect(service.get(reviewer("rev-cit"), "missing")).rejects.toMatchObject({ status: 404 });
  });
});
