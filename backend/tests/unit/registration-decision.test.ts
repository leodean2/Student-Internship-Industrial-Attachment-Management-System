import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../src/infrastructure/transaction";
import { buildPageLink } from "../../src/modules/email-outbox/email-link";
import { enqueueRegistrationConfirmed, enqueueRegistrationRejected } from "../../src/modules/email-outbox/registration-decision.producer";
import {
  REGISTRATION_CONFIRMED,
  buildRegistrationConfirmedPayload,
  registrationConfirmedPayloadSchema,
} from "../../src/modules/email-outbox/registration-confirmed.payload";
import {
  REGISTRATION_REJECTED,
  buildRegistrationRejectedPayload,
} from "../../src/modules/email-outbox/registration-rejected.payload";
import { renderRegistrationConfirmed } from "../../src/modules/email-outbox/registration-confirmed.template";
import { renderRegistrationRejected } from "../../src/modules/email-outbox/registration-rejected.template";
import type { OutboxEnqueuer, OutboxMessage } from "../../src/modules/email-outbox/outbox.repository";

describe("buildPageLink", () => {
  it("joins base and path, and rejects bad input", () => {
    expect(buildPageLink("https://app.example.test/", "/login")).toBe("https://app.example.test/login");
    expect(() => buildPageLink("javascript:alert(1)", "/login")).toThrow();
    expect(() => buildPageLink("https://app.example.test", "login")).toThrow();
  });
});

describe("registration-confirmed payload and template", () => {
  const payload = buildRegistrationConfirmedPayload({ appBaseUrl: "https://app.example.test" });

  it("builds a strict login-link payload", () => {
    expect(payload).toEqual({ loginUrl: "https://app.example.test/login" });
    expect(registrationConfirmedPayloadSchema.safeParse({ ...payload, token: "x" }).success).toBe(false);
    expect(registrationConfirmedPayloadSchema.safeParse({ loginUrl: "javascript:x" }).success).toBe(false);
  });

  it("renders deterministically with the link in text and html", () => {
    const first = renderRegistrationConfirmed(payload);
    expect(renderRegistrationConfirmed(payload)).toEqual(first);
    expect(first.text).toContain(payload.loginUrl);
    expect(first.html).toContain(`href="${payload.loginUrl}"`);
  });

  it("refuses a scrubbed or malformed payload", () => {
    for (const bad of [null, {}, { loginUrl: "nope" }]) {
      expect(() => renderRegistrationConfirmed(bad)).toThrow();
    }
  });
});

describe("registration-rejected payload and template", () => {
  it("carries no reason, registration number or name", () => {
    expect(buildRegistrationRejectedPayload()).toEqual({});
    const email = renderRegistrationRejected({});
    expect(email.text).toContain("could not be approved");
    expect(email.text).not.toContain("CIT-");
    expect(email.text).not.toContain("Jane Student");
    expect(email.text).not.toContain("not on the roster");
    expect(() => renderRegistrationRejected({ reason: "leak" })).toThrow();
    expect(() => renderRegistrationRejected(null)).toThrow();
  });
});

describe("decision producers", () => {
  const tx = {} as Tx;
  const enqueuer = () => {
    const enqueue = vi.fn<OutboxEnqueuer["enqueue"]>(async () => ({ created: true }));
    return { enqueue };
  };

  it("enqueues the confirmed email once per profile, in the caller's transaction", async () => {
    const outbox = enqueuer();
    await enqueueRegistrationConfirmed({ enqueue: outbox.enqueue }, tx, {
      toEmail: "s@example.test",
      userId: "u1",
      profileId: "p1",
      appBaseUrl: "https://app.example.test",
    });
    const [passedTx, message] = outbox.enqueue.mock.calls[0]!;
    expect(passedTx).toBe(tx);
    expect(message).toMatchObject({
      toEmail: "s@example.test",
      relatedUserId: "u1",
      templateType: REGISTRATION_CONFIRMED,
      idempotencyKey: "registration-confirmed:p1",
      payload: { loginUrl: "https://app.example.test/login" },
    });
  });

  it("makes each rejection's key unique by decision time", async () => {
    const outbox = enqueuer();
    const base = { toEmail: "s@example.test", userId: "u1", profileId: "p1" };
    await enqueueRegistrationRejected({ enqueue: outbox.enqueue }, tx, {
      ...base,
      decidedAt: new Date("2026-11-09T10:00:00Z"),
    });
    await enqueueRegistrationRejected({ enqueue: outbox.enqueue }, tx, {
      ...base,
      decidedAt: new Date("2026-11-10T10:00:00Z"),
    });
    const keys = outbox.enqueue.mock.calls.map((call) => call[1].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(outbox.enqueue.mock.calls[0]![1]).toMatchObject({
      templateType: REGISTRATION_REJECTED,
      payload: {},
    } satisfies Partial<OutboxMessage>);
  });
});
