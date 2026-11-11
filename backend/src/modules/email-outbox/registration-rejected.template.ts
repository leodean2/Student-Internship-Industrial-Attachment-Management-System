import { PermanentEmailError } from "./email-provider";
import { registrationRejectedPayloadSchema } from "./registration-rejected.payload";
import { SYSTEM_NAME, escapeHtml } from "./template-helpers";
import type { RenderedEmail } from "./template-types";

export function renderRegistrationRejected(payload: unknown): RenderedEmail {
  if (!registrationRejectedPayloadSchema.safeParse(payload).success) {
    throw new PermanentEmailError("Invalid REGISTRATION_REJECTED email payload");
  }
  const text = [
    "Hello,",
    "",
    `Your registration on the ${SYSTEM_NAME} could not be approved.`,
    "Please contact the attachment office of your department for assistance.",
    "",
    "If you did not register, you can ignore this email.",
  ].join("\n");
  const html = [
    "<p>Hello,</p>",
    `<p>Your registration on the ${escapeHtml(SYSTEM_NAME)} could not be approved.<br>Please contact the attachment office of your department for assistance.</p>`,
    "<p>If you did not register, you can ignore this email.</p>",
  ].join("\n");
  return { subject: `Your registration on the ${SYSTEM_NAME}`, text, html };
}
