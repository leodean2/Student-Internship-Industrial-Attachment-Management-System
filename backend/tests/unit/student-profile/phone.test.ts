import { describe, expect, it } from "vitest";
import { isKenyanE164, normalizePhoneToE164 } from "../../../src/modules/student-profile/phone";

describe("isKenyanE164", () => {
  it("accepts valid Kenyan E.164 numbers", () => {
    expect(isKenyanE164("+254712345678")).toBe(true);
    expect(isKenyanE164("+254112345678")).toBe(true);
    expect(isKenyanE164("+254999999999")).toBe(true);
  });

  it("rejects non-Kenyan and malformed numbers", () => {
    expect(isKenyanE164("+14155552671")).toBe(false);   // US number
    expect(isKenyanE164("0712345678")).toBe(false);      // local format, no +
    expect(isKenyanE164("+25471234567")).toBe(false);    // 8 digits after +254
    expect(isKenyanE164("+2547123456789")).toBe(false);  // 10 digits after +254
    expect(isKenyanE164("")).toBe(false);
  });
});

describe("normalizePhoneToE164", () => {
  it.each([
    ["0712345678",        "+254712345678"],
    ["0112345678",        "+254112345678"],
    ["+254712345678",     "+254712345678"],
    ["+254 712 345 678",  "+254712345678"],
    ["(0712) 345-678",    "+254712345678"],
    ["00254712345678",    "+254712345678"],
    ["0202123456",        "+254202123456"],  // 9 digits after +254 — landlines pass the literal rule
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePhoneToE164(input)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "0712",                    // too short
    "07123456789",             // 10 digits — +254 + 10 = 13 digits total, fails /^\+254\d{9}$/
    "+254 71234567",           // 8 digits after +254
    "+25471234567890",         // 11 digits after +254
    "+2540712345678",          // starts with 0 after +254, still 10 digits — fails rule
    "254712345678",            // no leading + or 0, ambiguous
    "712345678",               // 9 bare digits, no prefix
    "+0123456789",             // + followed by 0
    "+",
    "+14155552671",            // non-Kenyan E.164
    "+447911123456",           // UK number
  ])("rejects %j", (input) => {
    expect(normalizePhoneToE164(input)).toBeNull();
  });
});
