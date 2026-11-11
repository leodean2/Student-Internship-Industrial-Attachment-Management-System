import { PermanentEmailError } from "./email-provider";
import { accountDeactivatedPayloadSchema } from "./account-deactivated.payload";
import { escapeHtml, SYSTEM_NAME } from "./template-helpers";
import type { RenderedEmail } from "./template-types";

/** Generic wording only — no internal reason or admin notes (C3 §6). */
export function renderAccountDeactivated(payload: unknown): RenderedEmail {
  const parsed = accountDeactivatedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentEmailError("Invalid ACCOUNT_DEACTIVATED email payload");

  const body =
    "Your account has been deactivated. Please contact the university administration for assistance.";

  const text = ["Hello,", "", body].join("\n");
  const html = ["<p>Hello,</p>", `<p>${escapeHtml(body)}</p>`].join("\n");

  return {
    subject: `Your account on the ${SYSTEM_NAME} has been deactivated`,
    text,
    html,
  };
}
