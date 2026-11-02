import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_CHARACTERS, checkPassword } from "../../src/modules/auth/password-policy";

describe("password policy (min 10 characters, max 72 UTF-8 bytes, no composition rules)", () => {
  it("has the approved limits", () => {
    expect(PASSWORD_MIN_CHARACTERS).toBe(10);
    expect(PASSWORD_MAX_BYTES).toBe(72);
  });

  it("minimum: 9 characters fail, 10 pass", () => {
    expect(checkPassword("a".repeat(9))).toEqual({ ok: false, reason: "too_short" });
    expect(checkPassword("a".repeat(10))).toEqual({ ok: true });
  });

  it("maximum is in BYTES: 72 ASCII characters pass, 73 fail", () => {
    expect(checkPassword("a".repeat(72))).toEqual({ ok: true });
    expect(checkPassword("a".repeat(73))).toEqual({ ok: false, reason: "too_long" });
  });

  it("multi-byte characters hit the byte limit before the character count", () => {
    expect(checkPassword("é".repeat(36))).toEqual({ ok: true });
    expect(checkPassword("é".repeat(37))).toEqual({ ok: false, reason: "too_long" });
    expect(checkPassword("日".repeat(24))).toEqual({ ok: true });
    expect(checkPassword("日".repeat(25))).toEqual({ ok: false, reason: "too_long" });
    expect(checkPassword("😀".repeat(18))).toEqual({ ok: true });
    expect(checkPassword("😀".repeat(19))).toEqual({ ok: false, reason: "too_long" });
  });

  it("the minimum counts characters, not bytes or UTF-16 units: ten emoji pass", () => {
    expect(checkPassword("😀".repeat(10))).toEqual({ ok: true });
    expect(checkPassword("😀".repeat(9))).toEqual({ ok: false, reason: "too_short" });
  });

  it("has no composition rules: all lower-case, all digits, all spaces are accepted", () => {
    expect(checkPassword("abcdefghij")).toEqual({ ok: true });
    expect(checkPassword("1234567890")).toEqual({ ok: true });
    expect(checkPassword(" ".repeat(10))).toEqual({ ok: true });
  });

  it("is never normalized: composed and decomposed forms are measured as typed", () => {
    expect(checkPassword("e\u0301".repeat(5))).toEqual({ ok: true });
    expect(checkPassword("é".repeat(5))).toEqual({ ok: false, reason: "too_short" });
  });

  it("refuses NUL (a technical hazard for bcrypt), whatever the length", () => {
    expect(checkPassword("abcdefghij\u0000klmn")).toEqual({ ok: false, reason: "contains_nul" });
  });
});
