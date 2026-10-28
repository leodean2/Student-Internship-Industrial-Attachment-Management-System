import { describe, expect, it } from "vitest";
import { getDummyHash, hashPassword, verifyPassword } from "../../src/modules/auth/password";

describe("password hashing (Decision #51: bcrypt, cost 12)", () => {
  it("hashes at cost 12, salts every hash, and never contains the plaintext", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).toMatch(/^\$2[aby]\$12\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("a malformed stored hash (such as the SYSTEM user's '!') never matches and never throws", async () => {
    expect(await verifyPassword("anything", "!")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });

  it("the dummy hash is a real cost-12 hash, made once, and matches nothing a user would type", async () => {
    const first = await getDummyHash();
    expect(first).toMatch(/^\$2[aby]\$12\$/);
    expect(await getDummyHash()).toBe(first);
    expect(await verifyPassword("password", first)).toBe(false);
  });
});
