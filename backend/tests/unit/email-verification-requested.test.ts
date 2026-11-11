import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../src/infrastructure/transaction";
import type { OutboxMessage } from "../../src/modules/email-outbox/outbox.repository";
import { PermanentEmailError } from "../../src/modules/email-outbox/email-provider";
import {
  buildVerificationUrl,
  emailVerificationRequestedPayloadSchema,
  EMAIL_VERIFICATION_REQUESTED,
} from "../../src/modules/email-outbox/email-verification-requested.payload";
import { enqueueEmailVerificationRequested } from "../../src/modules/email-outbox/email-verification-requested.producer";
import { renderEmailVerificationRequested } from "../../src/modules/email-outbox/email-verification-requested.template";

const NOW = new Date("2026-11-09T00:00:00.000Z");
const EXPIRES = new Date("2026-11-10T00:00:00.000Z");
const TOKEN = "abc-DEF_123";

describe("buildVerificationUrl", () => {
  it("builds the verification link and encodes the token", () => {
    expect(buildVerificationUrl("https://app.example.test/", TOKEN)).toBe(
      "https://app.example.test/verify-email?token=abc-DEF_123",
    );
    expect(buildVerificationUrl("https://app.example.test", "a+b/c=")).toBe(
      "https://app.example.test/verify-email?token=a%2Bb%2Fc%3D",
    );
  });

  it("rejects a bad base URL and an empty token", () => {
    expect(() => buildVerificationUrl("javascript:alert(1)", TOKEN)).toThrow();
    expect(() => buildVerificationUrl("https://app.example.test", "")).toThrow();
  });
});

describe("emailVerificationRequestedPayloadSchema", () => {
  const valid = {
    verificationUrl: "https://app.example.test/verify-email?token=x",
    expiresAt: EXPIRES.toISOString(),
  };

  it("accepts valid payloads and rejects extra keys, non-http URLs and non-UTC dates", () => {
    expect(emailVerificationRequestedPayloadSchema.safeParse(valid).success).toBe(true);
    expect(emailVerificationRequestedPayloadSchema.safeParse({ ...valid, token: "x" }).success).toBe(false);
    expect(emailVerificationRequestedPayloadSchema.safeParse({ ...valid, verificationUrl: "javascript:x" }).success).toBe(false);
    expect(emailVerificationRequestedPayloadSchema.safeParse({ ...valid, expiresAt: "2026-11-10T00:00:00+03:00" }).success).toBe(false);
  });
});

describe("renderEmailVerificationRequested", () => {
  const payload = {
    verificationUrl: "https://app.example.test/verify-email?token=abc-DEF_123&x=1",
    expiresAt: EXPIRES.toISOString(),
  };

  it("is deterministic and contains the link and expiry", () => {
    const first = renderEmailVerificationRequested(payload, { now: NOW });
    expect(renderEmailVerificationRequested(payload, { now: new Date("2026-11-09T12:00:00.000Z") })).toEqual(first);
    expect(first.text).toContain(payload.verificationUrl);
    expect(first.text).toContain("10 November 2026, 00:00 UTC");
    expect(first.html).toContain("&amp;x=1");
  });

  it("refuses to render at or after expiry, and renders one millisecond before", () => {
    expect(() => renderEmailVerificationRequested(payload, { now: EXPIRES })).toThrow(PermanentEmailError);
    expect(() =>
      renderEmailVerificationRequested(payload, { now: new Date(EXPIRES.getTime() - 1) }),
    ).not.toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => renderEmailVerificationRequested({ verificationUrl: "nope" }, { now: NOW })).toThrow(PermanentEmailError);
  });
});

describe("enqueueEmailVerificationRequested", () => {
  it("enqueues in the caller's transaction with a per-token key and token only in the URL", async () => {
    const enqueue = vi.fn(async (_tx: Tx, _message: OutboxMessage) => ({ created: true }));
    const tx = {} as Tx;
    const result = await enqueueEmailVerificationRequested({ enqueue }, tx, {
      toEmail: "student@example.test",
      userId: "user-1",
      rawToken: TOKEN,
      tokenHash: "hash-1",
      expiresAt: EXPIRES,
      appBaseUrl: "https://app.example.test",
    });

    expect(result).toEqual({ created: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(tx, {
      toEmail: "student@example.test",
      relatedUserId: "user-1",
      templateType: EMAIL_VERIFICATION_REQUESTED,
      payload: {
        verificationUrl: `https://app.example.test/verify-email?token=${TOKEN}`,
        expiresAt: EXPIRES.toISOString(),
      },
      idempotencyKey: "email-verification:hash-1",
    });
    expect(JSON.stringify(enqueue.mock.calls[0]?.[1]).split(TOKEN)).toHaveLength(2);
  });
});
