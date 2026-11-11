import { DEFAULT_PHONE_COUNTRY_CODE } from "./student-profile.limits";

/** Approved rule (C1-F decision D4): a Kenyan E.164 number, +254 followed by exactly 9 digits. */
const KENYA_E164 = /^\+254\d{9}$/;

export const isKenyanE164 = (value: string): boolean => KENYA_E164.test(value);

/**
 * Returns the stored form (+254XXXXXXXXX) or null. Accepts:
 *   - +254XXXXXXXXX  (E.164, stored as-is)
 *   - 00254XXXXXXXXX (international format with 00 prefix)
 *   - 0XXXXXXXXX     (local Kenyan format; leading 0 is replaced with +254)
 *
 * Any non-Kenyan number is rejected. A bare 9-digit or 10-digit string with no prefix is ambiguous and rejected.
 * Whitespace, hyphens, dots and parentheses are stripped before parsing.
 */
export function normalizePhoneToE164(raw: string): string | null {
  const stripped = raw.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(stripped)) return null;

  let digits: string;
  if (stripped.startsWith("+")) digits = stripped.slice(1);
  else if (stripped.startsWith("00")) digits = stripped.slice(2);
  else if (stripped.startsWith("0")) digits = DEFAULT_PHONE_COUNTRY_CODE + stripped.slice(1);
  else return null;

  const e164 = `+${digits}`;
  return KENYA_E164.test(e164) ? e164 : null;
}
