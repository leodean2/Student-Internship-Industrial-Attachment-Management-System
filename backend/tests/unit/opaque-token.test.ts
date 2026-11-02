import { describe, expect, it } from "vitest";
import { hashToken, mintOpaqueToken } from "../../src/shared/security/opaque-token";

describe("opaque tokens", () => {
  it("mints 256 bits as base64url (43 characters) with the SHA-256 hex hash of the raw value", () => {
    const { raw, hash } = mintOpaqueToken();
    expect(raw).toHaveLength(43);
    expect(raw.length > 0 && /^[A-Za-z0-9_-]+$/.test(raw)).toBe(true);
    expect(hash).toBe(hashToken(raw));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(raw);
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(mintOpaqueToken().raw);
    expect(seen.size).toBe(200);
  });

  it("hashes to a known SHA-256 value (the stored format must never change silently)", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
