import { codePointLength, utf8ByteLength } from "../../shared/validation/text";

/** Technical defaults (provisioning decision #85), not an institutional requirement. */
export const PASSWORD_MIN_CHARACTERS = 10;
/** bcrypt only uses the first 72 BYTES of its input, so longer passwords would be silently truncated. */
export const PASSWORD_MAX_BYTES = 72;

export type PasswordCheck = { ok: true } | { ok: false; reason: "too_short" | "too_long" | "contains_nul" };

/**
 * No composition rules (no required digits, symbols or case). The password is measured exactly as typed and is
 * NEVER normalized, so login hashes the same bytes that were hashed here. NUL is refused only because it is a
 * technical hazard (C-string truncation inside bcrypt), not a composition rule.
 */
export function checkPassword(password: string): PasswordCheck {
  if (password.includes("\u0000")) return { ok: false, reason: "contains_nul" };
  if (codePointLength(password) < PASSWORD_MIN_CHARACTERS) return { ok: false, reason: "too_short" };
  if (utf8ByteLength(password) > PASSWORD_MAX_BYTES) return { ok: false, reason: "too_long" };
  return { ok: true };
}

export const PASSWORD_POLICY_MESSAGE = `Password must be at least ${PASSWORD_MIN_CHARACTERS} characters and at most ${PASSWORD_MAX_BYTES} bytes (UTF-8).`;
