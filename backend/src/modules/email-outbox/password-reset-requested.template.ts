import { PermanentEmailError } from "./email-provider";
import { passwordResetRequestedPayloadSchema } from "./password-reset-requested.payload";
import { escapeHtml, formatUtc, SYSTEM_NAME } from "./template-helpers";
import type { RenderedEmail, TemplateContext } from "./template-types";

/** Throws permanently for malformed or expired payloads so expired links are never sent. */
export function renderPasswordResetRequested(payload: unknown, context: TemplateContext): RenderedEmail {
  const parsed = passwordResetRequestedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentEmailError("Invalid PASSWORD_RESET_REQUESTED email payload");
  const { resetUrl, expiresAt } = parsed.data;
  if (Date.parse(expiresAt) <= context.now.getTime()) {
    throw new PermanentEmailError("Password reset token expired before delivery");
  }
  const expires = formatUtc(expiresAt);

  const text = [
    "Hello,",
    "",
    `You requested a password reset for your ${SYSTEM_NAME} account.`,
    "To set a new password, open this link:",
    resetUrl,
    "",
    `This link expires on ${expires}.`,
    "If you did not request a password reset, you can ignore this email.",
    "Your password has not been changed.",
  ].join("\n");

  const html = [
    "<p>Hello,</p>",
    `<p>You requested a password reset for your ${escapeHtml(SYSTEM_NAME)} account.</p>`,
    `<p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>`,
    `<p>This link expires on ${escapeHtml(expires)}.</p>`,
    "<p>If you did not request a password reset, you can ignore this email. Your password has not been changed.</p>",
  ].join("\n");

  return { subject: `Reset your password for the ${SYSTEM_NAME}`, text, html };
}
