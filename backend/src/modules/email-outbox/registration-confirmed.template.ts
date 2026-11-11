import { PermanentEmailError } from "./email-provider";
import { registrationConfirmedPayloadSchema } from "./registration-confirmed.payload";
import { SYSTEM_NAME, escapeHtml } from "./template-helpers";
import type { RenderedEmail } from "./template-types";

export function renderRegistrationConfirmed(payload: unknown): RenderedEmail {
  const parsed = registrationConfirmedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentEmailError("Invalid REGISTRATION_CONFIRMED email payload");
  const { loginUrl } = parsed.data;
  const text = [
    "Hello,",
    "",
    `Your registration number has been confirmed and your account on the ${SYSTEM_NAME} is now active.`,
    "You can log in here:",
    loginUrl,
  ].join("\n");
  const html = [
    "<p>Hello,</p>",
    `<p>Your registration number has been confirmed and your account on the ${escapeHtml(SYSTEM_NAME)} is now active.</p>`,
    `<p><a href="${escapeHtml(loginUrl)}">Log in</a></p>`,
  ].join("\n");
  return { subject: `Your account is active on the ${SYSTEM_NAME}`, text, html };
}
