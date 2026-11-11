import { PermanentEmailError } from "./email-provider";
import { invitationCreatedPayloadSchema } from "./invitation-created.payload";
import { escapeHtml, formatUtc, SYSTEM_NAME } from "./template-helpers";
import type { RenderedEmail, TemplateContext } from "./template-types";

export { formatUtc };

export function renderInvitationCreated(payload: unknown, context: TemplateContext): RenderedEmail {
  const parsed = invitationCreatedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentEmailError("Invalid INVITATION_CREATED email payload");
  const { acceptanceUrl, expiresAt, role } = parsed.data;
  if (Date.parse(expiresAt) <= context.now.getTime()) {
    throw new PermanentEmailError("Invitation expired before delivery");
  }
  const expires = formatUtc(expiresAt);
  const text = [
    "Hello,",
    "",
    `You have been invited to the ${SYSTEM_NAME}.`,
    `Your role: ${role}`,
    "",
    "To accept the invitation and set up your account, open this link:",
    acceptanceUrl,
    "",
    `This invitation expires on ${expires}.`,
    "If you were not expecting it, you can ignore this email.",
  ].join("\n");
  const html = [
    "<p>Hello,</p>",
    `<p>You have been invited to the ${escapeHtml(SYSTEM_NAME)}.<br>Your role: <strong>${escapeHtml(role)}</strong></p>`,
    `<p><a href="${escapeHtml(acceptanceUrl)}">Accept the invitation</a></p>`,
    `<p>This invitation expires on ${escapeHtml(expires)}.<br>If you were not expecting it, you can ignore this email.</p>`,
  ].join("\n");
  return { subject: `You have been invited to the ${SYSTEM_NAME}`, text, html };
}
