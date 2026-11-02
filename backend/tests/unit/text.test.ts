import { describe, expect, it } from "vitest";
import { checkText, codePointLength, hasControlCharacters, utf8ByteLength } from "../../src/shared/validation/text";

describe("code points versus UTF-16 units and bytes", () => {
  it("counts characters, not UTF-16 units: an emoji is one character", () => {
    expect("😀".length).toBe(2);
    expect(codePointLength("😀")).toBe(1);
    expect(codePointLength("a😀b")).toBe(3);
    expect(codePointLength("")).toBe(0);
  });

  it("utf8ByteLength matches the real UTF-8 encoding for 1-, 2-, 3- and 4-byte characters", () => {
    for (const s of ["", "abc", "é", "ñandú", "€", "日本語", "😀", "a😀é€日", "\u00e9\u0301"]) {
      expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
    }
  });

  it("a lone surrogate counts like TextEncoder does (3 bytes)", () => {
    expect(utf8ByteLength("\ud800")).toBe(new TextEncoder().encode("\ud800").length);
  });

  it("detects control characters including NUL, newline, tab, DEL and C1", () => {
    for (const s of ["a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\u0085b"]) expect(hasControlCharacters(s)).toBe(true);
    for (const s of ["", "plain", "José", "日本語", "😀"]) expect(hasControlCharacters(s)).toBe(false);
  });
});

describe("checkText (names, titles, staff ids)", () => {
  it("accepts and trims normal text", () => {
    expect(checkText("  Ada Lovelace  ", 100)).toEqual({ ok: true, value: "Ada Lovelace" });
  });

  it("normalizes to NFC so composed and decomposed forms are the same stored value", () => {
    const composed: string = "José";
    const decomposed: string = "Jose\u0301";
    expect(composed === decomposed).toBe(false);
    const a = checkText(decomposed, 100);
    expect(a).toEqual({ ok: true, value: composed });
  });

  it("the limit is in characters: exactly the limit passes, one more fails, astral characters count once", () => {
    expect(checkText("a".repeat(100), 100).ok).toBe(true);
    expect(checkText("a".repeat(101), 100)).toEqual({ ok: false, reason: "too_long" });
    expect(checkText("😀".repeat(100), 100).ok).toBe(true);
    expect(checkText("😀".repeat(101), 100)).toEqual({ ok: false, reason: "too_long" });
    expect(checkText("日".repeat(64), 64).ok).toBe(true);
  });

  it("rejects empty and whitespace-only input", () => {
    expect(checkText("", 100)).toEqual({ ok: false, reason: "empty" });
    expect(checkText("   \u00a0  ", 100)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects control characters, newlines and NUL", () => {
    expect(checkText("a\u0000b", 100)).toEqual({ ok: false, reason: "control_characters" });
    expect(checkText("line1\nline2", 100)).toEqual({ ok: false, reason: "control_characters" });
  });

  it("measures the limit AFTER normalization and trimming", () => {
    expect(checkText(`${"e\u0301".repeat(50)}   `, 50).ok).toBe(true);
  });
});
