import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import { hashToken } from "../../src/shared/security/opaque-token";
import type { OutboxEnqueuer, OutboxMessage } from "../../src/modules/email-outbox/outbox.repository";
import type { AuditEvent } from "../../src/modules/audit/audit.repository";
import {
  EMAIL_VERIFICATION_TTL_MS,
  type EmailVerificationTokenRepository,
} from "../../src/modules/student-registration/email-verification-token.repository";
import type { StudentRegistrationRepository } from "../../src/modules/student-registration/student-registration.repository";
import {
  REGISTRATION_EMAIL_LIMIT,
  REGISTRATION_IP_LIMIT,
  StudentRegistrationService,
} from "../../src/modules/student-registration/student-registration.service";
import type { RegisterStudentInput } from "../../src/modules/student-registration/student-registration.validation";

interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  status: string;
  emailVerifiedAt: Date | null;
}

interface TokenRow {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

const context = { ip: "203.0.113.7" };
const regNo = (n: number): string => `CIT-221-${String(n).padStart(3, "0")}/2024`;
const input: RegisterStudentInput = {
  name: "Jane Student",
  email: "jane@example.test",
  registrationNumber: regNo(1),
  password: "Correct-Horse-9!",
};

function build(options: {
  failOutbox?: boolean;
  verifyLimit?: number;
  uniqueViolation?: "email" | "registrationNumber";
} = {}) {
  const clock = { now: new Date("2026-11-09T10:00:00.000Z") };
  const world = {
    users: [] as UserRow[],
    roles: [] as { userId: string; role: string }[],
    profiles: [] as { userId: string; registrationNumber: string }[],
    tokens: [] as TokenRow[],
    outbox: [] as OutboxMessage[],
    audit: [] as AuditEvent[],
  };
  const calls: string[] = [];
  let hashCalls = 0;

  const runTx: TxRunner = async (fn) => {
    calls.push("begin");
    const snapshot = structuredClone(world);
    try {
      const result = await fn(undefined as unknown as Tx);
      calls.push("commit");
      return result;
    } catch (error) {
      Object.assign(world, snapshot);
      calls.push("rollback");
      throw error;
    }
  };

  const users: StudentRegistrationRepository = {
    accountExists: async (_tx, email) => world.users.some((user) => user.email === email),
    registrationNumberExists: async (_tx, registrationNumber) =>
      world.profiles.some((profile) => profile.registrationNumber === registrationNumber),
    insertUser: async (_tx, user) => {
      if (options.uniqueViolation === "email") {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`email`)", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["email"] },
        });
      }
      world.users.push({ ...user, status: "PENDING_VERIFICATION", emailVerifiedAt: null });
    },
    insertStudentRole: async (_tx, userId) => { world.roles.push({ userId, role: "STUDENT" }); },
    insertStudentProfile: async (_tx, profile) => {
      if (options.uniqueViolation === "registrationNumber") {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`registrationNumber`)",
          { code: "P2002", clientVersion: "test", meta: { target: ["registrationNumber"] } },
        );
      }
      world.profiles.push(profile);
    },
    markEmailVerified: async (_tx, userId) => {
      const user = world.users.find(
        (row) => row.id === userId && row.status === "PENDING_VERIFICATION" && row.emailVerifiedAt === null,
      );
      if (!user) return false;
      user.emailVerifiedAt = clock.now;
      return true;
    },
  };

  const tokens: EmailVerificationTokenRepository = {
    insert: async (_tx, { userId, tokenHash }) => {
      const expiresAt = new Date(clock.now.getTime() + EMAIL_VERIFICATION_TTL_MS);
      world.tokens.push({ userId, tokenHash, expiresAt, usedAt: null });
      return { expiresAt };
    },
    consume: async (_tx, tokenHash) => {
      const token = world.tokens.find(
        (row) => row.tokenHash === tokenHash && row.usedAt === null && row.expiresAt > clock.now,
      );
      if (!token) return null;
      token.usedAt = clock.now;
      return { userId: token.userId };
    },
  };

  const outbox: OutboxEnqueuer = {
    enqueue: async (_tx, message) => {
      if (options.failOutbox) throw new Error("outbox down");
      world.outbox.push(message);
      return { created: true };
    },
  };
  const audit = {
    record: async (_tx: Tx, entry: AuditEvent) => { world.audit.push(entry); },
  };

  const service = new StudentRegistrationService({
    users,
    tokens,
    outbox,
    audit,
    appBaseUrl: "https://app.example.test",
    runTx,
    acquireLock: async (_tx, key) => { calls.push(`lock:${key}`); },
    hashPassword: async (_plain) => {
      hashCalls += 1;
      return `test-password-hash-${hashCalls}`;
    },
    verifyAttemptLimit: options.verifyLimit,
    verifyWindowMs: 60_000,
  });

  const rawToken = () => {
    const payload = world.outbox[0]!.payload as { verificationUrl: string };
    return new URL(payload.verificationUrl).searchParams.get("token")!;
  };

  return { service, world, calls, clock, hashCalls: () => hashCalls, rawToken };
}

describe("StudentRegistrationService.register", () => {
  it("creates user, role, profile, token and outbox row in one transaction", async () => {
    const { service, world, calls, rawToken } = build();
    await service.register(input, context);

    expect(calls.filter((call) => call === "begin")).toHaveLength(1);
    expect(calls.at(-1)).toBe("commit");
    expect(world.users).toHaveLength(1);
    expect(world.users[0]).toMatchObject({
      email: input.email,
      name: input.name,
      status: "PENDING_VERIFICATION",
    });
    expect(world.roles).toEqual([{ userId: world.users[0]!.id, role: "STUDENT" }]);
    expect(world.profiles).toEqual([{ userId: world.users[0]!.id, registrationNumber: input.registrationNumber }]);
    expect(world.tokens[0]!.tokenHash).toBe(hashToken(rawToken()));
    expect(world.outbox[0]).toMatchObject({
      toEmail: input.email,
      relatedUserId: world.users[0]!.id,
      templateType: "EMAIL_VERIFICATION_REQUESTED",
      idempotencyKey: `email-verification:${world.tokens[0]!.tokenHash}`,
    });
  });

  it("stores no password or raw token in database-shaped rows", async () => {
    const { service, world, rawToken } = build();
    await service.register(input, context);
    const stored = JSON.stringify({ users: world.users, tokens: world.tokens, profiles: world.profiles });
    expect(stored).not.toContain(input.password);
    expect(stored).not.toContain(rawToken());
    expect(world.users[0]!.passwordHash).toMatch(/^test-password-hash-/);
  });

  it("gives existing accounts the same acknowledgement without sending another email", async () => {
    const { service, world, hashCalls } = build();
    const first = await service.register(input, context);
    const second = await service.register({ ...input, registrationNumber: regNo(2) }, context);

    expect(second).toEqual(first);
    expect(world.users).toHaveLength(1);
    expect(world.tokens).toHaveLength(1);
    expect(world.outbox).toHaveLength(1);
    expect(hashCalls()).toBe(2);
  });

  it("rejects a taken registration number without partial writes", async () => {
    const { service, world, calls } = build();
    await service.register(input, context);
    await expect(service.register({ ...input, email: "other@example.test" }, context)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    expect(calls.at(-1)).toBe("rollback");
    expect(world.users).toHaveLength(1);
    expect(world.outbox).toHaveLength(1);
  });

  it("rolls back all rows when outbox persistence fails", async () => {
    const { service, world, calls } = build({ failOutbox: true });
    await expect(service.register(input, context)).rejects.toThrow("outbox down");
    expect(calls.at(-1)).toBe("rollback");
    expect(world.users).toHaveLength(0);
    expect(world.roles).toHaveLength(0);
    expect(world.profiles).toHaveLength(0);
    expect(world.tokens).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
  });

  it("records STUDENT_REGISTERED in the same transaction without secrets", async () => {
    const { service, world, rawToken } = build();
    await service.register(input, context);

    expect(world.audit).toEqual([{
      actorUserId: world.users[0]!.id,
      action: "STUDENT_REGISTERED",
      targetType: "User",
      targetId: world.users[0]!.id,
      metadata: { role: "STUDENT" },
    }]);
    expect(JSON.stringify(world.audit)).not.toContain(input.password);
    expect(JSON.stringify(world.audit)).not.toContain(rawToken());
  });

  it("writes no audit event when registration rolls back", async () => {
    const { service, world } = build({ failOutbox: true });
    await expect(service.register(input, context)).rejects.toThrow();
    expect(world.audit).toHaveLength(0);
  });

  it("maps unique-index races to the documented generic email and registration-number outcomes", async () => {
    const emailRace = build({ uniqueViolation: "email" });
    const acknowledgement = await emailRace.service.register(input, context);
    expect(acknowledgement.message).toBeTruthy();
    expect(emailRace.world.users).toHaveLength(0);

    const registrationNumberRace = build({ uniqueViolation: "registrationNumber" });
    await expect(registrationNumberRace.service.register(input, context)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    expect(registrationNumberRace.world.users).toHaveLength(0);
    expect(registrationNumberRace.world.tokens).toHaveLength(0);
    expect(registrationNumberRace.world.outbox).toHaveLength(0);
  });

  it("applies per-email and per-IP registration limits", async () => {
    const perEmail = build();
    for (let index = 0; index < REGISTRATION_EMAIL_LIMIT; index++) {
      await perEmail.service.register({ ...input, registrationNumber: regNo(index + 10) }, context);
    }
    await expect(perEmail.service.register(input, context)).rejects.toMatchObject({ status: 429 });

    const perIp = build();
    for (let index = 0; index < REGISTRATION_IP_LIMIT; index++) {
      await perIp.service.register({
        ...input,
        email: `user${index}@example.test`,
        registrationNumber: regNo(index + 10),
      }, context);
    }
    await expect(perIp.service.register({
      ...input,
      email: "late@example.test",
      registrationNumber: regNo(99),
    }, context)).rejects.toMatchObject({ status: 429 });
  });
});

describe("StudentRegistrationService.verifyEmail", () => {
  it("records mailbox ownership, spends the token, audits, and does not activate the account", async () => {
    const { service, world, rawToken } = build();
    await service.register(input, context);
    expect(await service.verifyEmail({ token: rawToken() }, context)).toEqual({ emailVerified: true });
    expect(world.users[0]!.status).toBe("PENDING_VERIFICATION");
    expect(world.users[0]!.emailVerifiedAt).toEqual(new Date("2026-11-09T10:00:00.000Z"));
    expect(world.tokens[0]!.usedAt).not.toBeNull();
    expect(world.audit.at(-1)).toEqual({
      actorUserId: world.users[0]!.id,
      action: "EMAIL_VERIFIED",
      targetType: "User",
      targetId: world.users[0]!.id,
      metadata: {},
    });
  });

  it("uniformly rejects unknown, used, expired, and ineligible tokens", async () => {
    const failures: string[] = [];
    const captureFailure = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failures.push((error as Error).message);
      }
    };

    const used = build();
    await used.service.register(input, context);
    const token = used.rawToken();
    await used.service.verifyEmail({ token }, context);
    await captureFailure(() => used.service.verifyEmail({ token }, context));
    await captureFailure(() => used.service.verifyEmail({ token: "does-not-exist" }, context));

    const expired = build();
    await expired.service.register(input, context);
    expired.clock.now = new Date(expired.clock.now.getTime() + EMAIL_VERIFICATION_TTL_MS + 1);
    await captureFailure(() => expired.service.verifyEmail({ token: expired.rawToken() }, context));

    const ineligible = build();
    await ineligible.service.register(input, context);
    ineligible.world.users[0]!.status = "ACTIVE";
    await captureFailure(() => ineligible.service.verifyEmail({ token: ineligible.rawToken() }, context));

    expect(failures).toHaveLength(4);
    expect(new Set(failures).size).toBe(1);
    expect(ineligible.world.tokens[0]!.usedAt).toBeNull();
    expect(expired.world.users[0]!.emailVerifiedAt).toBeNull();
  });

  it("does not verify twice or change the first verification timestamp", async () => {
    const { service, world, rawToken } = build();
    await service.register(input, context);
    const token = rawToken();
    await service.verifyEmail({ token }, context);
    const first = world.users[0]!.emailVerifiedAt;
    await expect(service.verifyEmail({ token }, context)).rejects.toThrow();
    expect(world.users[0]!.emailVerifiedAt).toEqual(first);
    expect(world.audit.filter((event) => event.action === "EMAIL_VERIFIED")).toHaveLength(1);
  });

  it("counts failed guesses but refunds successful verification attempts", async () => {
    const failing = build({ verifyLimit: 2 });
    await expect(failing.service.verifyEmail({ token: "bad-1" }, context)).rejects.toThrow();
    await expect(failing.service.verifyEmail({ token: "bad-2" }, context)).rejects.toThrow();
    await failing.service.register(input, context);
    await expect(failing.service.verifyEmail({ token: failing.rawToken() }, context)).rejects.toMatchObject({ status: 429 });

    const success = build({ verifyLimit: 1 });
    for (let index = 0; index < 3; index++) {
      await success.service.register({
        ...input,
        email: `verified${index}@example.test`,
        registrationNumber: regNo(index + 10),
      }, context);
    }
    for (const message of success.world.outbox) {
      const token = new URL((message.payload as { verificationUrl: string }).verificationUrl).searchParams.get("token")!;
      await success.service.verifyEmail({ token }, context);
    }
    expect(success.world.users.every(
      (user) => user.emailVerifiedAt !== null && user.status === "PENDING_VERIFICATION",
    )).toBe(true);
  });
});
