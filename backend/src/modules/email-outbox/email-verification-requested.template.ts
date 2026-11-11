import { PermanentEmailError } from "./email-provider";
import { emailVerificationRequestedPayloadSchema } from "./email-verification-requested.payload";
import { escapeHtml, formatUtc, SYSTEM_NAME } from "./template-helpers";
import type { RenderedEmail, TemplateContext } from "./template-types";

/** Throws permanently for malformed or expired payloads so expired links are never sent. */
export function renderEmailVerificationRequested(payload: unknown, context: TemplateContext): RenderedEmail {
  const parsed = emailVerificationRequestedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentEmailError("Invalid EMAIL_VERIFICATION_REQUESTED email payload");
  const { verificationUrl, expiresAt } = parsed.data;
  if (Date.parse(expiresAt) <= context.now.getTime()) {
    throw new PermanentEmailError("Email verification token expired before delivery");
  }
  const expires = formatUtc(expiresAt);

  const text = [
    "Hello,",
    "",
    `Thank you for registering with the ${SYSTEM_NAME}.`,
    "To verify your email address and finish setting up your account, open this link:",
    verificationUrl,
    "",
    `This link expires on ${expires}.`,
    "If you did not register, you can ignore this email.",
  ].join("\n");

  const html = [
    "<p>Hello,</p>",
    `<p>Thank you for registering with the ${escapeHtml(SYSTEM_NAME)}.</p>`,
    `<p><a href="${escapeHtml(verificationUrl)}">Verify your email address</a></p>`,
    `<p>This link expires on ${escapeHtml(expires)}.<br>If you did not register, you can ignore this email.</p>`,
  ].join("\n");

  return { subject: `Verify your email address for the ${SYSTEM_NAME}`, text, html };
}
