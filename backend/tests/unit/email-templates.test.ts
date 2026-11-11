import { describe, expect, it } from "vitest";
import {
  PermanentEmailError,
  type EmailMessage,
} from "../../src/modules/email-outbox/email-provider";
import { emailTemplates, renderEmail } from "../../src/modules/email-outbox/email-templates";
import {
  buildEmailVerificationRequestedPayload,
  EMAIL_VERIFICATION_REQUESTED,
} from "../../src/modules/email-outbox/email-verification-requested.payload";
import {
  buildInvitationCreatedPayload,
  INVITATION_CREATED,
} from "../../src/modules/email-outbox/invitation-created.payload";
import {
  buildRegistrationConfirmedPayload,
  REGISTRATION_CONFIRMED,
} from "../../src/modules/email-outbox/registration-confirmed.payload";
import {
  buildRegistrationRejectedPayload,
  REGISTRATION_REJECTED,
} from "../../src/modules/email-outbox/registration-rejected.payload";
import { PASSWORD_RESET_REQUESTED } from "../../src/modules/email-outbox/password-reset-requested.payload";
import { ACCOUNT_DEACTIVATED } from "../../src/modules/email-outbox/account-deactivated.payload";
import { PASSWORD_CHANGED } from "../../src/modules/email-outbox/password-changed.payload";

const NOW = new Date("2026-11-09T00:00:00.000Z");

describe("emailTemplates registry", () => {
  it("registers exactly the implemented templates", () => {
    expect(Object.keys(emailTemplates).sort()).toEqual([
      ACCOUNT_DEACTIVATED,
      EMAIL_VERIFICATION_REQUESTED,
      INVITATION_CREATED,
      PASSWORD_CHANGED,
      PASSWORD_RESET_REQUESTED,
      REGISTRATION_CONFIRMED,
      REGISTRATION_REJECTED,
    ].sort());
  });

  it("renders the payload built by the invitation producer", () => {
    const payload = buildInvitationCreatedPayload({
      appBaseUrl: "https://app.example.test",
      rawToken: "tok_en-1",
      role: "STUDENT",
      expiresAt: new Date("2026-12-08T14:30:00.000Z"),
    });
    const email = renderEmail({
      id: "email-1",
      toEmail: "student@example.test",
      templateType: INVITATION_CREATED,
      payload,
      attempt: 1,
    }, () => NOW);

    expect(email.subject).toContain("invited");
    expect(email.text).toContain(payload.acceptanceUrl);
    expect(email.html).toContain(`href="${payload.acceptanceUrl}"`);
  });

  it("renders the payload built by the verification producer", () => {
    const payload = buildEmailVerificationRequestedPayload({
      appBaseUrl: "https://app.example.test",
      rawToken: "tok_en-2",
      expiresAt: new Date("2026-11-10T00:00:00.000Z"),
    });
    const email = renderEmail({
      id: "email-2",
      toEmail: "student@example.test",
      templateType: EMAIL_VERIFICATION_REQUESTED,
      payload,
      attempt: 1,
    }, () => NOW);

    expect(email.subject).toContain("Verify your email");
    expect(email.text).toContain(payload.verificationUrl);
    expect(email.html).toContain(`href="${payload.verificationUrl}"`);
  });

  it("renders both registration decision notifications built by their producers", () => {
    const confirmed = buildRegistrationConfirmedPayload({ appBaseUrl: "https://app.example.test" });
    const confirmedEmail = renderEmail({
      id: "email-confirmed",
      toEmail: "student@example.test",
      templateType: REGISTRATION_CONFIRMED,
      payload: confirmed,
      attempt: 1,
    }, () => NOW);
    expect(confirmedEmail.text).toContain(confirmed.loginUrl);

    const rejectedEmail = renderEmail({
      id: "email-rejected",
      toEmail: "student@example.test",
      templateType: REGISTRATION_REJECTED,
      payload: buildRegistrationRejectedPayload(),
      attempt: 1,
    }, () => NOW);
    expect(rejectedEmail.subject).toContain("registration");
  });

  it("treats malformed or scrubbed payloads as permanent failures without leaking payload data", () => {
    const rawToken = "secret-invitation-token";
    const messages: EmailMessage[] = [
      {
        id: "invalid-object",
        toEmail: "student@example.test",
        templateType: INVITATION_CREATED,
        payload: { acceptanceUrl: "invalid", token: rawToken },
        attempt: 1,
      },
      {
        id: "scrubbed-payload",
        toEmail: "student@example.test",
        templateType: INVITATION_CREATED,
        payload: null,
        attempt: 1,
      },
    ];

    for (const message of messages) {
      try {
        renderEmail(message, () => NOW);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PermanentEmailError);
        if (!(error instanceof Error)) throw error;
        expect(error.message).not.toContain(rawToken);
      }
    }
  });

  it("treats expired payloads as permanent failures", () => {
    const expiredInvitation = buildInvitationCreatedPayload({
      appBaseUrl: "https://app.example.test",
      rawToken: "secret-expired-invitation",
      role: "STUDENT",
      expiresAt: new Date("2026-11-08T00:00:00.000Z"),
    });
    const expiredVerification = buildEmailVerificationRequestedPayload({
      appBaseUrl: "https://app.example.test",
      rawToken: "secret-expired-verification",
      expiresAt: new Date("2026-11-08T00:00:00.000Z"),
    });

    for (const [templateType, payload] of [
      [INVITATION_CREATED, expiredInvitation],
      [EMAIL_VERIFICATION_REQUESTED, expiredVerification],
    ] as const) {
      try {
        renderEmail({
          id: "expired-email",
          toEmail: "student@example.test",
          templateType,
          payload,
          attempt: 1,
        }, () => NOW);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PermanentEmailError);
        if (!(error instanceof Error)) throw error;
        expect(error.message).not.toContain("secret-expired");
      }
    }
  });
});
