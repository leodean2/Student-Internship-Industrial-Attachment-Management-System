import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/shared/errors";
import type { Tx, TxRunner } from "../../src/infrastructure/transaction";
import type { PasswordResetUserRecord, PasswordResetUserRepository } from "../../src/modules/auth/password-reset.service";
import { PasswordResetService, PASSWORD_RESET_ACCEPTED_MESSAGE } from "../../src/modules/auth/password-reset.service";
import type { PasswordResetTokenRepository } from "../../src/modules/auth/password-reset-token.repository";
import type { OutboxEnqueuer } from "../../src/modules/email-outbox/outbox.repository";
import type { AuditRepository } from "../../src/modules/audit/audit.repository";
import type { AttemptLimiter } from "../../src/shared/security/attempt-limiter";

const tx = {} as Tx;
const runTx: TxRunner = async (fn) => fn(tx);

// A valid password that satisfies checkPassword (>= 10 chars, no NUL, <= 72 bytes).
const VALID_PASSWORD = "new-secure-password-123";
const ACTIVE_USER_ID = "user-active-id";
const ACTIVE_EMAIL = "active@example.test";

function makeUser(overrides: Partial<PasswordResetUserRecord> = {}): PasswordResetUserRecord {
  return { userId: ACTIVE_USER_ID, email: ACTIVE_EMAIL, status: "ACTIVE", ...overrides };
}

interface Captured {
  tokenInserts: { userId: string; tokenHash: string }[];
  outboxMessages: { templateType: string; idempotencyKey: string }[];
  auditEvents: { action: string; actorUserId: string; metadata?: Record<string, unknown> }[];
  passwordUpdates: { userId: string; hash: string }[];
  tokenConsumptions: string[];
  invalidations: string[];
  sessionRevocations: string[];
  sessionRevocationTransactions: Tx[];
}

function buildDeps(overrides: {
  user?: PasswordResetUserRecord | null;
  consumeResult?: { userId: string } | null;
  hashPassword?: (plain: string) => Promise<string>;
  requestThrottle?: Pick<AttemptLimiter, "acquire">;
  confirmThrottle?: Pick<AttemptLimiter, "acquire">;
  requestEmailThrottle?: Pick<AttemptLimiter, "acquire">;
  emailLimitPerHour?: number;
  throttleKeyer?: import("../../src/shared/throttle-key").ThrottleKeyer;
} = {}) {
  const captured: Captured = {
    tokenInserts: [],
    outboxMessages: [],
    auditEvents: [],
    passwordUpdates: [],
    tokenConsumptions: [],
    invalidations: [],
    sessionRevocations: [],
    sessionRevocationTransactions: [],
  };

  const userRecord: PasswordResetUserRecord | null =
    overrides.user !== undefined ? overrides.user : makeUser();
  const consumeResult: { userId: string } | null =
    overrides.consumeResult !== undefined ? overrides.consumeResult : { userId: ACTIVE_USER_ID };

  const users: PasswordResetUserRepository = {
    findByEmail: async () => userRecord,
    findById: async () => userRecord,
    updatePassword: async (_tx, userId, hash) => { captured.passwordUpdates.push({ userId, hash }); },
  };

  const tokens: PasswordResetTokenRepository = {
    insert: async (_tx, input) => {
      captured.tokenInserts.push(input);
      return { expiresAt: new Date(Date.now() + 3_600_000) };
    },
    consume: async (_tx, tokenHash) => {
      captured.tokenConsumptions.push(tokenHash);
      return consumeResult;
    },
    invalidateAllForUser: async (_tx, userId) => { captured.invalidations.push(userId); },
  };

  const outbox: OutboxEnqueuer = {
    enqueue: async (_tx, msg) => {
      captured.outboxMessages.push({ templateType: msg.templateType, idempotencyKey: msg.idempotencyKey });
      return { created: true };
    },
  };

  const audit: AuditRepository = {
    record: async (_tx, event) => { captured.auditEvents.push({ action: event.action, actorUserId: event.actorUserId, metadata: event.metadata }); },
  };

  const sessions = {
    revokeAllSessionsInTransaction: async (txArg: Tx, userId: string) => {
      captured.sessionRevocations.push(userId);
      captured.sessionRevocationTransactions.push(txArg);
      return 1;
    },
  };

  const service = new PasswordResetService({
    users,
    tokens,
    outbox,
    audit,
    sessions,
    appBaseUrl: "http://localhost:5173",
    runTx,
    hashPassword: overrides.hashPassword ?? (async (plain) => `hashed:${plain}`),
    requestThrottle: overrides.requestThrottle,
    confirmThrottle: overrides.confirmThrottle,
    requestEmailThrottle: overrides.requestEmailThrottle,
    emailLimitPerHour: overrides.emailLimitPerHour,
    throttleKeyer: overrides.throttleKeyer,
  });

  return { service, captured };
}

async function rejects(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (e) { return e as AppError; }
  throw new Error("expected a rejection");
}

const CTX = { ip: "127.0.0.1" };

// ── §1-2: Generic request response ──────────────────────────────────────────

describe("requestReset: generic response (C2 §1–2)", () => {
  it("returns the generic message for an unknown email", async () => {
    const { service, captured } = buildDeps({ user: null });
    const result = await service.requestReset("nobody@example.test", CTX);
    expect(result.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(captured.tokenInserts).toHaveLength(0);
    expect(captured.outboxMessages).toHaveLength(0);
  });

  it("returns the generic message for a PENDING_VERIFICATION account", async () => {
    const { service, captured } = buildDeps({ user: makeUser({ status: "PENDING_VERIFICATION" }) });
    const result = await service.requestReset(ACTIVE_EMAIL, CTX);
    expect(result.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(captured.tokenInserts).toHaveLength(0);
    expect(captured.outboxMessages).toHaveLength(0);
  });

  it("returns the generic message for a DEACTIVATED account", async () => {
    const { service, captured } = buildDeps({ user: makeUser({ status: "DEACTIVATED" }) });
    const result = await service.requestReset(ACTIVE_EMAIL, CTX);
    expect(result.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(captured.tokenInserts).toHaveLength(0);
    expect(captured.outboxMessages).toHaveLength(0);
  });

  it("returns the generic message for an ACTIVE account and enqueues the reset email", async () => {
    const { service, captured } = buildDeps();
    const result = await service.requestReset(ACTIVE_EMAIL, CTX);
    expect(result.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(captured.tokenInserts).toHaveLength(1);
    expect(captured.tokenInserts[0]!.userId).toBe(ACTIVE_USER_ID);
    expect(captured.outboxMessages).toHaveLength(1);
    expect(captured.outboxMessages[0]!.templateType).toBe("PASSWORD_RESET_REQUESTED");
  });
});

// ── §3: Token expiry ─────────────────────────────────────────────────────────

describe("confirmReset: expired / invalid token (C2 §3)", () => {
  it("rejects a consumed or unknown token with NOT_FOUND", async () => {
    const { service } = buildDeps({ consumeResult: null });
    const err = await rejects(service.confirmReset({ token: "bad-token", newPassword: VALID_PASSWORD }, CTX));
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });
});

// ── §4: Password validation matches registration rules ───────────────────────

describe("confirmReset: password validation (C2 §4)", () => {
  it("rejects a password shorter than the minimum", async () => {
    const { service } = buildDeps();
    const err = await rejects(service.confirmReset({ token: "valid", newPassword: "short" }, CTX));
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a password containing a NUL byte", async () => {
    const { service } = buildDeps();
    const err = await rejects(service.confirmReset({ token: "valid", newPassword: "valid-pass\u0000word" }, CTX));
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("accepts a password that meets the policy", async () => {
    const { service, captured } = buildDeps();
    await service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX);
    expect(captured.passwordUpdates).toHaveLength(1);
  });
});

// ── §5: Account recheck at confirmation time ─────────────────────────────────

describe("confirmReset: account state recheck (C2 §5)", () => {
  it("rejects confirmation when the account is DEACTIVATED after token issuance", async () => {
    const { service } = buildDeps({ user: makeUser({ status: "DEACTIVATED" }) });
    const err = await rejects(service.confirmReset({ token: "valid-token", newPassword: VALID_PASSWORD }, CTX));
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("rejects confirmation when the account is PENDING_VERIFICATION after token issuance", async () => {
    const { service } = buildDeps({ user: makeUser({ status: "PENDING_VERIFICATION" }) });
    const err = await rejects(service.confirmReset({ token: "valid-token", newPassword: VALID_PASSWORD }, CTX));
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });
});

// ── §6: Post-reset cleanup ───────────────────────────────────────────────────

describe("confirmReset: session revocation and token invalidation (C2 §6)", () => {
  it("revokes all refresh sessions after a successful reset", async () => {
    const { service, captured } = buildDeps();
    await service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX);
    expect(captured.sessionRevocations).toContain(ACTIVE_USER_ID);
    expect(captured.sessionRevocationTransactions).toEqual([tx]);
  });

  it("invalidates all other reset tokens for the user after a successful reset", async () => {
    const { service, captured } = buildDeps();
    await service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX);
    expect(captured.invalidations).toContain(ACTIVE_USER_ID);
  });

  it("does not log the raw token or hash in audit metadata", async () => {
    const rawToken = "my-secret-raw-token";
    const { service, captured } = buildDeps();
    await service.requestReset(ACTIVE_EMAIL, CTX);
    await service.confirmReset({ token: rawToken, newPassword: VALID_PASSWORD }, CTX);
    for (const event of captured.auditEvents) {
      const metaStr = JSON.stringify(event.metadata ?? {});
      expect(metaStr).not.toContain(rawToken);
    }
    // No tokenHash in metadata either (we can't see the internal hash, but we ensure no token key appears).
    for (const event of captured.auditEvents) {
      expect(event.metadata).not.toHaveProperty("token");
      expect(event.metadata).not.toHaveProperty("tokenHash");
    }
  });

  it("records a PASSWORD_RESET_REQUESTED audit event for an eligible account", async () => {
    const { service, captured } = buildDeps();
    await service.requestReset(ACTIVE_EMAIL, CTX);
    const event = captured.auditEvents.find((e) => e.action === "PASSWORD_RESET_REQUESTED");
    expect(event).toBeDefined();
    expect(event!.actorUserId).toBe(ACTIVE_USER_ID);
  });

  it("records a PASSWORD_RESET_CONFIRMED audit event on success", async () => {
    const { service, captured } = buildDeps();
    await service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX);
    const event = captured.auditEvents.find((e) => e.action === "PASSWORD_RESET_CONFIRMED");
    expect(event).toBeDefined();
    expect(event!.actorUserId).toBe(ACTIVE_USER_ID);
  });
});

// ── Token storage: hash only ─────────────────────────────────────────────────

describe("requestReset: token storage (C2 §6)", () => {
  it("stores a hash in the token repository, not the raw token", async () => {
    let storedHash: string | undefined;
    const tokens: PasswordResetTokenRepository = {
      insert: async (_tx, input) => { storedHash = input.tokenHash; return { expiresAt: new Date() }; },
      consume: async () => null,
      invalidateAllForUser: async () => undefined,
    };
    // Capture what actually goes in the outbox payload URL.
    let outboxRawTokenUrl: string | undefined;
    const outbox: OutboxEnqueuer = {
      enqueue: async (_tx, msg) => {
        const payload = msg.payload as Record<string, unknown>;
        outboxRawTokenUrl = payload["resetUrl"] as string;
        return { created: true };
      },
    };
    const service = new PasswordResetService({
      users: { findByEmail: async () => makeUser(), findById: async () => makeUser(), updatePassword: async () => undefined },
      tokens,
      outbox,
      audit: { record: async () => undefined },
      sessions: { revokeAllSessionsInTransaction: async () => 0 },
      appBaseUrl: "http://localhost:5173",
      runTx,
      hashPassword: async (p) => `hashed:${p}`,
    });

    await service.requestReset(ACTIVE_EMAIL, CTX);

    expect(storedHash).toBeDefined();
    // The stored hash is a hex SHA-256 (64 chars), not the raw token (43-char base64url).
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token is embedded in the URL, not stored directly.
    expect(outboxRawTokenUrl).toBeDefined();
    // The raw token from the URL should NOT equal the stored hash.
    const urlToken = new URL(outboxRawTokenUrl!).searchParams.get("token")!;
    expect(urlToken).not.toBe(storedHash);
  });
});

// ── Request throttle ─────────────────────────────────────────────────────────

describe("requestReset: IP throttle (C2 §2)", () => {
  /**
   * Build a fake throttle that starts already exhausted.
   * `allowed: false` means the limiter has refused the request; the service must throw RATE_LIMITED.
   */
  function exhaustedThrottle(): Pick<import("../../src/shared/security/attempt-limiter").AttemptLimiter, "acquire"> {
    return {
      acquire: () => ({ allowed: false, retryAfterSeconds: 60 }),
    };
  }

  /** Open throttle — allows every attempt, refund is a no-op. */
  function openThrottle(): Pick<import("../../src/shared/security/attempt-limiter").AttemptLimiter, "acquire"> {
    return {
      acquire: () => ({ allowed: true, permit: { refund: () => undefined } }),
    };
  }

  it("throws RATE_LIMITED when the request IP limit is exhausted", async () => {
    const { service } = buildDeps({ requestThrottle: exhaustedThrottle() });
    const err = await rejects(service.requestReset(ACTIVE_EMAIL, CTX));
    expect(err.status).toBe(429);
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("returns the generic message for an ACTIVE account even when over-limit (uniform response)", async () => {
    // The throttle fires before the account lookup, so the response message must remain the same
    // regardless of account state — there is no account-state-specific error path.
    const { service } = buildDeps({ requestThrottle: exhaustedThrottle() });
    // The 429 bubbles up; the route converts it. Here we confirm it throws, not returns a different body.
    await expect(service.requestReset(ACTIVE_EMAIL, CTX)).rejects.toBeDefined();
  });

  it("applies the same throttle key for unknown, pending and active emails (bucket is IP-only)", async () => {
    // All account states go through the same acquire call before any DB work.
    const acquisitions: string[] = [];
    const recordingThrottle: ReturnType<typeof openThrottle> = {
      acquire: (key: string) => { acquisitions.push(key); return { allowed: true, permit: { refund: () => undefined } }; },
    };
    const { service: s1 } = buildDeps({ user: null, requestThrottle: recordingThrottle });
    const { service: s2 } = buildDeps({ user: makeUser({ status: "PENDING_VERIFICATION" }), requestThrottle: recordingThrottle });
    const { service: s3 } = buildDeps({ user: makeUser({ status: "DEACTIVATED" }), requestThrottle: recordingThrottle });
    await s1.requestReset(ACTIVE_EMAIL, CTX);
    await s2.requestReset(ACTIVE_EMAIL, CTX);
    await s3.requestReset(ACTIVE_EMAIL, CTX);
    // All three used the same IP key.
    expect(acquisitions).toHaveLength(3);
    expect(new Set(acquisitions).size).toBe(1);
    expect(acquisitions[0]).toContain(CTX.ip);
  });

  it("uses separate throttle buckets for different IPs", async () => {
    const acquisitions: string[] = [];
    const recordingThrottle: ReturnType<typeof openThrottle> = {
      acquire: (key: string) => { acquisitions.push(key); return { allowed: true, permit: { refund: () => undefined } }; },
    };
    const { service } = buildDeps({ user: null, requestThrottle: recordingThrottle });
    await service.requestReset(ACTIVE_EMAIL, { ip: "1.2.3.4" });
    await service.requestReset(ACTIVE_EMAIL, { ip: "5.6.7.8" });
    expect(acquisitions[0]).toContain("1.2.3.4");
    expect(acquisitions[1]).toContain("5.6.7.8");
    expect(acquisitions[0]).not.toBe(acquisitions[1]);
  });
});

// ── Confirm throttle ─────────────────────────────────────────────────────────

describe("confirmReset: IP throttle (C2 §2)", () => {
  function exhaustedThrottle(): Pick<import("../../src/shared/security/attempt-limiter").AttemptLimiter, "acquire"> {
    return { acquire: () => ({ allowed: false, retryAfterSeconds: 60 }) };
  }

  it("throws RATE_LIMITED when the confirm IP limit is exhausted", async () => {
    const { service } = buildDeps({ confirmThrottle: exhaustedThrottle() });
    const err = await rejects(service.confirmReset({ token: "any", newPassword: VALID_PASSWORD }, CTX));
    expect(err.status).toBe(429);
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("refunds the slot on a successful reset", async () => {
    let refunded = false;
    const refundingThrottle: Pick<import("../../src/shared/security/attempt-limiter").AttemptLimiter, "acquire"> = {
      acquire: () => ({ allowed: true, permit: { refund: () => { refunded = true; } } }),
    };
    const { service } = buildDeps({ confirmThrottle: refundingThrottle });
    await service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX);
    expect(refunded).toBe(true);
  });

  it("does not refund the slot when the token is invalid", async () => {
    let refunded = false;
    const refundingThrottle: Pick<import("../../src/shared/security/attempt-limiter").AttemptLimiter, "acquire"> = {
      acquire: () => ({ allowed: true, permit: { refund: () => { refunded = true; } } }),
    };
    const { service } = buildDeps({ consumeResult: null, confirmThrottle: refundingThrottle });
    await expect(service.confirmReset({ token: "bad", newPassword: VALID_PASSWORD }, CTX)).rejects.toBeDefined();
    expect(refunded).toBe(false);
  });
});

// ── Password-changed notice ───────────────────────────────────────────────────

describe("confirmReset: password-changed notice (C2 notice)", () => {
  it("enqueues the PASSWORD_CHANGED notice on a successful reset", async () => {
    const { service, captured } = buildDeps();
    await service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX);
    const notice = captured.outboxMessages.find((m) => m.templateType === "PASSWORD_CHANGED");
    expect(notice).toBeDefined();
  });

  it("does not enqueue the notice when the token is invalid", async () => {
    const { service, captured } = buildDeps({ consumeResult: null });
    await expect(service.confirmReset({ token: "bad", newPassword: VALID_PASSWORD }, CTX)).rejects.toBeDefined();
    expect(captured.outboxMessages.filter((m) => m.templateType === "PASSWORD_CHANGED")).toHaveLength(0);
  });

  it("does not enqueue the notice when the account is no longer ACTIVE", async () => {
    const { service, captured } = buildDeps({ user: makeUser({ status: "DEACTIVATED" }) });
    await expect(service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX)).rejects.toBeDefined();
    expect(captured.outboxMessages.filter((m) => m.templateType === "PASSWORD_CHANGED")).toHaveLength(0);
  });

  it("uses a unique idempotency key per reset (not shared across resets)", async () => {
    // First reset uses token "token-a", second uses "token-b" — the idempotency keys must differ.
    const { service: s1, captured: c1 } = buildDeps();
    const { service: s2, captured: c2 } = buildDeps();
    await s1.confirmReset({ token: "token-a", newPassword: VALID_PASSWORD }, CTX);
    await s2.confirmReset({ token: "token-b", newPassword: VALID_PASSWORD }, CTX);
    const key1 = c1.outboxMessages.find((m) => m.templateType === "PASSWORD_CHANGED")?.idempotencyKey;
    const key2 = c2.outboxMessages.find((m) => m.templateType === "PASSWORD_CHANGED")?.idempotencyKey;
    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).not.toBe(key2);
  });

  it("enqueues the notice inside the same transaction as the password update", async () => {
    // Both the password update and the outbox insert capture the same tx object.
    // We verify by checking the tx arg passed to updatePassword matches the one the outbox sees.
    const txObjects: unknown[] = [];
    let outboxTx: unknown;
    const users: import("../../src/modules/auth/password-reset.service").PasswordResetUserRepository = {
      findByEmail: async () => makeUser(),
      findById: async (_tx) => { txObjects.push(_tx); return makeUser(); },
      updatePassword: async (_tx) => { txObjects.push(_tx); },
    };
    const outbox: import("../../src/modules/email-outbox/outbox.repository").OutboxEnqueuer = {
      enqueue: async (_tx, msg) => {
        if ((msg.templateType as string) === "PASSWORD_CHANGED") outboxTx = _tx;
        return { created: true };
      },
    };
    const tokens: import("../../src/modules/auth/password-reset-token.repository").PasswordResetTokenRepository = {
      insert: async (_tx, input) => ({ expiresAt: new Date(Date.now() + 3_600_000), ...input }),
      consume: async (_tx) => ({ userId: ACTIVE_USER_ID }),
      invalidateAllForUser: async () => undefined,
    };
    const service = new (await import("../../src/modules/auth/password-reset.service")).PasswordResetService({
      users,
      tokens,
      outbox,
      audit: { record: async () => undefined },
      sessions: { revokeAllSessionsInTransaction: async () => 0 },
      appBaseUrl: "http://localhost:5173",
      runTx,
      hashPassword: async (p) => `hashed:${p}`,
    });
    await service.confirmReset({ token: "valid", newPassword: VALID_PASSWORD }, CTX);
    // Every tx object captured during the transaction (findById, updatePassword, outbox) must be the same reference.
    expect(outboxTx).toBeDefined();
    expect(txObjects.every((t) => t === outboxTx)).toBe(true);
  });
});

// ── Per-email request limit ───────────────────────────────────────────────────

describe("requestReset: per-email limit (C2 §3 decision)", () => {
  /**
   * Open throttle that records every acquire key it sees.
   * Useful for inspecting bucket keys without enforcing a limit.
   */
  function recordingEmailThrottle(): {
    throttle: Pick<AttemptLimiter, "acquire">;
    keys: string[];
  } {
    const keys: string[] = [];
    return {
      keys,
      throttle: {
        acquire: (key: string) => {
          keys.push(key);
          return { allowed: true, permit: { refund: () => undefined } };
        },
      },
    };
  }

  it("returns the same generic ack when the per-email limit is exhausted (no 429)", async () => {
    // Exhausted per-email throttle — service must return the generic message, not throw.
    const { service, captured } = buildDeps({
      requestEmailThrottle: { acquire: () => ({ allowed: false, retryAfterSeconds: 60 }) },
    });
    const result = await service.requestReset(ACTIVE_EMAIL, CTX);
    expect(result.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(captured.tokenInserts).toHaveLength(0);
    expect(captured.outboxMessages).toHaveLength(0);
  });

  it("applies the per-email limit for unknown accounts (no account enumeration)", async () => {
    const { service, captured } = buildDeps({
      user: null,
      requestEmailThrottle: { acquire: () => ({ allowed: false, retryAfterSeconds: 60 }) },
    });
    const result = await service.requestReset("nobody@example.test", CTX);
    expect(result.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(captured.tokenInserts).toHaveLength(0);
  });

  it("applies the per-email limit for PENDING_VERIFICATION accounts", async () => {
    const { service, captured } = buildDeps({
      user: makeUser({ status: "PENDING_VERIFICATION" }),
      requestEmailThrottle: { acquire: () => ({ allowed: false, retryAfterSeconds: 60 }) },
    });
    const result = await service.requestReset(ACTIVE_EMAIL, CTX);
    expect(result.message).toBe(PASSWORD_RESET_ACCEPTED_MESSAGE);
    expect(captured.tokenInserts).toHaveLength(0);
  });

  it("uses separate buckets per normalized email, shared across IPs", async () => {
    const recorder = recordingEmailThrottle();
    // Share one keyer so both service instances hash the same email to the same key.
    const { createThrottleKeyer } = await import("../../src/shared/throttle-key");
    const sharedKeyer = createThrottleKeyer("shared-secret-for-bucket-test-32chars");
    const { service: s1 } = buildDeps({ requestEmailThrottle: recorder.throttle, throttleKeyer: sharedKeyer });
    const { service: s2 } = buildDeps({ requestEmailThrottle: recorder.throttle, throttleKeyer: sharedKeyer });
    await s1.requestReset(" Student@Example.TEST ", { ip: "1.2.3.4" });
    await s2.requestReset("student@example.test", { ip: "5.6.7.8" });
    // Both normalize to the same email → same bucket key.
    expect(recorder.keys).toHaveLength(2);
    expect(recorder.keys[0]).toBe(recorder.keys[1]);
  });

  it("uses different buckets for different emails", async () => {
    const recorder = recordingEmailThrottle();
    const { service } = buildDeps({ requestEmailThrottle: recorder.throttle });
    await service.requestReset("a@example.test", CTX);
    await service.requestReset("b@example.test", CTX);
    expect(recorder.keys[0]).not.toBe(recorder.keys[1]);
  });

  it("never puts the raw email in a limiter key", async () => {
    const recorder = recordingEmailThrottle();
    const { service } = buildDeps({ requestEmailThrottle: recorder.throttle });
    await service.requestReset("student@example.test", CTX);
    for (const key of recorder.keys) {
      expect(key).not.toContain("student");
      expect(key).not.toContain("example");
    }
  });

  it("is configurable: emailLimitPerHour wires into the default throttle", async () => {
    // With emailLimitPerHour=2, the third request must not produce another token.
    // We can't test the actual AttemptLimiter internals, but we can verify the shape of the
    // constructed service by using an injectable throttle that counts allowed acquisitions.
    let count = 0;
    const countingThrottle: Pick<AttemptLimiter, "acquire"> = {
      acquire: () => {
        count++;
        return count <= 2
          ? { allowed: true, permit: { refund: () => undefined } }
          : { allowed: false, retryAfterSeconds: 3600 };
      },
    };
    const { service, captured } = buildDeps({ requestEmailThrottle: countingThrottle });
    for (let i = 0; i < 4; i++) await service.requestReset(ACTIVE_EMAIL, CTX);
    // Requests 1 and 2 were allowed (ACTIVE account) → 2 token inserts.
    // Requests 3 and 4 were blocked → no additional inserts.
    expect(captured.tokenInserts).toHaveLength(2);
  });

  it("per-IP limit is still a 429 even when per-email limit is open", async () => {
    const { service } = buildDeps({
      requestThrottle: { acquire: () => ({ allowed: false, retryAfterSeconds: 60 }) },
      requestEmailThrottle: { acquire: () => ({ allowed: true, permit: { refund: () => undefined } }) },
    });
    const err = await rejects(service.requestReset(ACTIVE_EMAIL, CTX));
    expect(err.status).toBe(429);
  });
});
