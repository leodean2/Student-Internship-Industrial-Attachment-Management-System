/** Canonical email comparison form. Dots and plus tags remain significant. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
