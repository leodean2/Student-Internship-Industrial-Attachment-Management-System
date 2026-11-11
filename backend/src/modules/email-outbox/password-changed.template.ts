import { PermanentEmailError } from "./email-provider";
import { passwordChangedPayloadSchema } from "./password-changed.payload";
import { escapeHtml, SYSTEM_NAME } from "./template-helpers";
import type { RenderedEmail } from "./template-types";

/** Security notice sent after a successful password reset. No sensitive data included. */
export function renderPasswordChanged(payload: unknown): RenderedEmail {
  const parsed = passwordChangedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentEmailError("Invalid PASSWORD_CHANGED email payload");

  const body =
    "Your password on the " +
    SYSTEM_NAME +
    " was recently changed. If you made this change, no action is needed. " +
    "If you did not make this change, contact the university administration immediately.";

  const text = ["Hello,", "", body].join("\n");
  const html = ["<p>Hello,</p>", `<p>${escapeHtml(body)}</p>`].join("\n");

  return {
    subject: `Your password was changed on the ${SYSTEM_NAME}`,
    text,
    html,
  };
}
