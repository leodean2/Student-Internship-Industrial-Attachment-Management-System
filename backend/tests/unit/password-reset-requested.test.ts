import { describe, expect, it } from "vitest";
import type { Tx } from "../../src/infrastructure/transaction";
import type { OutboxMessage } from "../../src/modules/email-outbox/outbox.repository";
import { PermanentEmailError } from "../../src/modules/email-outbox/email-provider";
import {
  buildResetUrl,
  passwordResetRequestedPayloadSchema,
  PASSWORD_RESET_REQUESTED,
} from "../../src/modules/email-outbox/password-reset-requested.payload";
import { enqueuePasswordResetRequested } from "../../src/modules/email-outbox/password-reset-requested.producer";
import { renderPasswordResetRequested } from "../../src/modules/email-outbox/password-reset-requested.template";

const NOW = new Date("2026-11-09T00:00:00.000Z");
const EXPIRES = new Date("2026-11-10T00:00:00.000Z");
const TOKEN = "abc-DEF_123";

describe("buildResetUrl", () => {
  it("builds the reset link and encodes the token", () => {
    expect(buildResetUrl("https://app.example.test/", TOKEN)).toBe(
      "https://app.example.test/reset-password?token=abc-DEF_123",
    );
    expect(buildResetUrl("https://app.example.test", "a+b/c=")).toBe(
      "https://app.example.test/reset-password?token=a%2Bb%2Fc%3D",
    );
  });

  it("rejects a bad base URL and an empty token", () => {
    expect(() => buildResetUrl("javascript:alert(1)", TOKEN)).toThrow();
    expect(() => buildResetUrl("https://app.example.test", "")).toThrow();
  });
});

describe("passwordResetRequestedPayloadSchema", () => {
  const valid = {
    resetUrl: "https://app.example.test/reset-password?token=x",
    expiresAt: EXPIRES.toISOString(),
  };

  it("accepts valid payloads", () => {
    expect(passwordResetRequestedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects extra keys", () => {
    expect(passwordResetRequestedPayloadSchema.safeParse({ ...valid, token: "x" }).success).toBe(false);
  });

  it("rejects non-http URLs", () => {
    expect(passwordResetRequestedPayloadSchema.safeParse({ ...valid, resetUrl: "javascript:x" }).success).toBe(false);
  });

  it("rejects non-UTC date strings", () => {
    expect(
      passwordResetRequestedPayloadSchema.safeParse({ ...valid, expiresAt: "2026-11-10T00:00:00+03:00" }).success,
    ).toBe(false);
  });
});

describe("renderPasswordResetRequested", () => {
  const payload = {
    resetUrl: "https://app.example.test/reset-password?token=abc-DEF_123",
    expiresAt: EXPIRES.toISOString(),
  };

  it("renders subject, text and html when the token has not yet expired", () => {
    const result = renderPasswordResetRequested(payload, { now: NOW });
    expect(result.subject).toContain("Reset your password");
    expect(result.text).toContain(payload.resetUrl);
    expect(result.html).toContain(payload.resetUrl);
    expect(result.text).toContain("10 November 2026, 00:00 UTC");
  });

  it("throws PermanentEmailError when the token is already expired at render time", () => {
    expect(() => renderPasswordResetRequested(payload, { now: EXPIRES })).toThrow(PermanentEmailError);
  });

  it("throws PermanentEmailError for an invalid payload", () => {
    expect(() => renderPasswordResetRequested({ resetUrl: "not-a-url", expiresAt: EXPIRES.toISOString() }, { now: NOW })).toThrow(PermanentEmailError);
  });
});

describe("enqueuePasswordResetRequested", () => {
  it("enqueues a PASSWORD_RESET_REQUESTED message with the correct idempotency key and template type", async () => {
    const messages: OutboxMessage[] = [];
    const outbox = { enqueue: async (_tx: Tx, m: OutboxMessage) => { messages.push(m); return { created: true }; } };
    const tx = {} as Tx;
    const tokenHash = "abc123def456";
    await enqueuePasswordResetRequested(outbox, tx, {
      toEmail: "user@example.test",
      userId: "usr-1",
      rawToken: TOKEN,
      tokenHash,
      expiresAt: EXPIRES,
      appBaseUrl: "https://app.example.test",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.templateType).toBe(PASSWORD_RESET_REQUESTED);
    expect(messages[0]!.idempotencyKey).toBe(`password-reset:${tokenHash}`);
    expect(messages[0]!.relatedUserId).toBe("usr-1");
  });
});
