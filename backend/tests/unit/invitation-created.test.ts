import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../src/infrastructure/transaction";
import type { OutboxMessage } from "../../src/modules/email-outbox/outbox.repository";
import {
  buildAcceptanceUrl,
  invitationCreatedPayloadSchema,
  INVITATION_CREATED,
} from "../../src/modules/email-outbox/invitation-created.payload";
import { enqueueInvitationCreated } from "../../src/modules/email-outbox/invitation-created.producer";
import {
  formatUtc,
  renderInvitationCreated,
} from "../../src/modules/email-outbox/invitation-created.template";
import { PermanentEmailError } from "../../src/modules/email-outbox/email-provider";

const SAFE_TOKEN = "abc-DEF_123";
const expiresAt = new Date("2026-12-08T14:30:00.000Z");
const NOW = new Date("2026-11-09T00:00:00.000Z");

describe("buildAcceptanceUrl", () => {
  it("builds the acceptance link and ignores trailing slashes on the base", () => {
    expect(buildAcceptanceUrl("https://app.example.test/", SAFE_TOKEN)).toBe(
      "https://app.example.test/accept-invitation?token=abc-DEF_123",
    );
  });

  it("encodes the token", () => {
    expect(buildAcceptanceUrl("https://app.example.test", "a+b/c=")).toBe(
      "https://app.example.test/accept-invitation?token=a%2Bb%2Fc%3D",
    );
  });

  it("rejects a bad base URL and an empty token", () => {
    expect(() => buildAcceptanceUrl("javascript:alert(1)", SAFE_TOKEN)).toThrow();
    expect(() => buildAcceptanceUrl("not a url", SAFE_TOKEN)).toThrow();
    expect(() => buildAcceptanceUrl("https://app.example.test", "")).toThrow();
  });
});

describe("invitationCreatedPayloadSchema", () => {
  const valid = {
    acceptanceUrl: "https://app.example.test/accept-invitation?token=x",
    expiresAt: "2026-12-08T14:30:00.000Z",
    role: "Student",
  };

  it("accepts a valid payload and rejects extra keys, non-http URLs and non-UTC dates", () => {
    expect(invitationCreatedPayloadSchema.safeParse(valid).success).toBe(true);
    expect(invitationCreatedPayloadSchema.safeParse({ ...valid, invitationToken: "x" }).success).toBe(false);
    expect(invitationCreatedPayloadSchema.safeParse({ ...valid, acceptanceUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(invitationCreatedPayloadSchema.safeParse({ ...valid, expiresAt: "2026-12-08T14:30:00+03:00" }).success).toBe(false);
  });
});

describe("renderInvitationCreated", () => {
  const payload = {
    acceptanceUrl: "https://app.example.test/accept-invitation?token=abc-DEF_123&x=1",
    expiresAt: "2026-12-08T14:30:00.000Z",
    role: "Student",
  };

  it("is deterministic and contains the link, role and expiry", () => {
    const first = renderInvitationCreated(payload, { now: NOW });
    expect(renderInvitationCreated(payload, { now: NOW })).toEqual(first);
    expect(first.text).toContain(payload.acceptanceUrl);
    expect(first.text).toContain("Your role: Student");
    expect(first.text).toContain("8 December 2026, 14:30 UTC");
    expect(first.html).toContain("&amp;x=1");
  });

  it("escapes HTML in the role", () => {
    const { html } = renderInvitationCreated({ ...payload, role: '<script>alert("x")</script>' }, { now: NOW });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("rejects a malformed payload", () => {
    expect(() => renderInvitationCreated({ acceptanceUrl: "nope" }, { now: NOW })).toThrow();
  });

  it("refuses expired invitations and permits rendering just before expiry", () => {
    const expiry = new Date(payload.expiresAt);
    expect(() => renderInvitationCreated(payload, { now: expiry })).toThrow(PermanentEmailError);
    expect(() => renderInvitationCreated(payload, { now: new Date(expiry.getTime() - 1) })).not.toThrow();
  });

  it("formats UTC dates without locale dependence", () => {
    expect(formatUtc("2026-01-02T03:04:00.000Z")).toBe("2 January 2026, 03:04 UTC");
  });
});

describe("enqueueInvitationCreated", () => {
  it("enqueues with the caller transaction, a per-issuance key, and one raw-token occurrence", async () => {
    const enqueue = vi.fn(async (_tx: Tx, _message: OutboxMessage) => ({ created: true }));
    const tx = {} as Tx;
    const result = await enqueueInvitationCreated({ enqueue }, tx, {
      toEmail: "invitee@example.test",
      rawToken: SAFE_TOKEN,
      tokenHash: "hash-1",
      role: "Student",
      expiresAt,
      appBaseUrl: "https://app.example.test",
    });

    expect(result).toEqual({ created: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(tx, {
      toEmail: "invitee@example.test",
      relatedUserId: null,
      templateType: INVITATION_CREATED,
      payload: {
        acceptanceUrl: `https://app.example.test/accept-invitation?token=${SAFE_TOKEN}`,
        expiresAt: expiresAt.toISOString(),
        role: "Student",
      },
      idempotencyKey: "invitation-created:hash-1",
    });
    expect(JSON.stringify(enqueue.mock.calls[0]?.[1]).split(SAFE_TOKEN)).toHaveLength(2);
  });
});
