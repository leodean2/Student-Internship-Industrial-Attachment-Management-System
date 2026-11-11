import { PermanentEmailError, type EmailMessage } from "./email-provider";
import { ACCOUNT_DEACTIVATED } from "./account-deactivated.payload";
import { renderAccountDeactivated } from "./account-deactivated.template";
import { EMAIL_VERIFICATION_REQUESTED } from "./email-verification-requested.payload";
import { renderEmailVerificationRequested } from "./email-verification-requested.template";
import { INVITATION_CREATED } from "./invitation-created.payload";
import { renderInvitationCreated } from "./invitation-created.template";
import { PASSWORD_CHANGED } from "./password-changed.payload";
import { renderPasswordChanged } from "./password-changed.template";
import { PASSWORD_RESET_REQUESTED } from "./password-reset-requested.payload";
import { renderPasswordResetRequested } from "./password-reset-requested.template";
import { REGISTRATION_CONFIRMED } from "./registration-confirmed.payload";
import { renderRegistrationConfirmed } from "./registration-confirmed.template";
import { REGISTRATION_REJECTED } from "./registration-rejected.payload";
import { renderRegistrationRejected } from "./registration-rejected.template";
import type { RenderedEmail, TemplateContext } from "./template-types";
export type { RenderedEmail } from "./template-types";

export type EmailTemplate = (message: EmailMessage, context: TemplateContext) => RenderedEmail;

export const emailTemplates: Readonly<Record<string, EmailTemplate>> = {
  [ACCOUNT_DEACTIVATED]: (message) => renderAccountDeactivated(message.payload),
  [INVITATION_CREATED]: (message, context) => renderInvitationCreated(message.payload, context),
  [EMAIL_VERIFICATION_REQUESTED]: (message, context) =>
    renderEmailVerificationRequested(message.payload, context),
  [PASSWORD_CHANGED]: (message) => renderPasswordChanged(message.payload),
  [PASSWORD_RESET_REQUESTED]: (message, context) => renderPasswordResetRequested(message.payload, context),
  [REGISTRATION_CONFIRMED]: (message) => renderRegistrationConfirmed(message.payload),
  [REGISTRATION_REJECTED]: (message) => renderRegistrationRejected(message.payload),
};

export function renderEmail(message: EmailMessage, now: () => Date = () => new Date()) {
  if (!Object.hasOwn(emailTemplates, message.templateType)) {
    throw new PermanentEmailError(`No email template registered for type "${message.templateType}"`);
  }
  return emailTemplates[message.templateType]!(message, { now: now() });
}
