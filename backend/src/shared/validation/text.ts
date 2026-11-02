/**
 * Unicode-aware text helpers for request validation. Limits are in CHARACTERS (Unicode code points), never
 * UTF-16 code units: "😀".length is 2 in JavaScript but it is one character, and PostgreSQL's char_length()
 * counts code points, so request validation and the database CHECK constraints agree.
 */

/** Number of Unicode code points (not UTF-16 code units, and not user-perceived graphemes). */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Number of bytes the string occupies in UTF-8 (a lone surrogate counts as U+FFFD, 3 bytes, like TextEncoder). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Control characters (C0, DEL, C1), including NUL, which PostgreSQL text cannot store. */
const CONTROL = /\p{Cc}/u;
export const hasControlCharacters = (value: string): boolean => CONTROL.test(value);

export type TextCheck = { ok: true; value: string } | { ok: false; reason: "empty" | "too_long" | "control_characters" };

/**
 * For human-readable free text such as a name or a title: normalizes to NFC (so "é" typed composed or
 * decomposed is the same string), trims surrounding whitespace, then checks it is non-empty, within
 * `maxCharacters` code points and free of control characters (newlines and tabs included).
 * Homoglyphs, bidirectional overrides and zero-width characters are NOT filtered.
 */
export function checkText(input: string, maxCharacters: number): TextCheck {
  const value = input.normalize("NFC").trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (hasControlCharacters(value)) return { ok: false, reason: "control_characters" };
  if (codePointLength(value) > maxCharacters) return { ok: false, reason: "too_long" };
  return { ok: true, value };
}
