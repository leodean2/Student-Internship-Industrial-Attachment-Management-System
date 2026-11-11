import { describe, expect, it } from "vitest";
import { invitationEmailLockKey } from "../../src/infrastructure/advisory-lock";
import { toUtcDate } from "../../src/infrastructure/db-clock";
import { normalizeEmail } from "../../src/shared/validation/email";

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Jane.Doe@Example.TEST \n")).toBe("jane.doe@example.test");
  });

  it("is idempotent", () => {
    const once = normalizeEmail(" A@B.C ");
    expect(normalizeEmail(once)).toBe(once);
  });

  it("does not remove dots or plus tags", () => {
    expect(normalizeEmail("a.b+tag@x.test")).toBe("a.b+tag@x.test");
    expect(normalizeEmail("a.b@x.test")).not.toBe(normalizeEmail("ab@x.test"));
  });

  it("agrees with the lowercase email database constraint for ASCII addresses", () => {
    for (const email of ["ABC@X.TEST", "MiXed+Tag@Sub.Example.Test"]) {
      expect(normalizeEmail(email)).toBe(email.toLowerCase());
    }
  });
});

describe("invitation advisory lock key", () => {
  it("uses the invitation-email prefix and normalized email", () => {
    expect(invitationEmailLockKey("jane@example.test")).toBe("invitation-email:jane@example.test");
  });

  it("maps differently-cased email inputs to one key", () => {
    expect(invitationEmailLockKey(normalizeEmail(" Jane@Example.TEST ")))
      .toBe(invitationEmailLockKey(normalizeEmail("jane@example.test")));
  });
});

describe("toUtcDate", () => {
  it("passes a Date through untouched", () => {
    const date = new Date("2026-11-06T10:00:00.000Z");
    expect(toUtcDate(date)).toBe(date);
  });

  it("reads a zone-less timestamp as UTC", () => {
    expect(toUtcDate("2026-11-06 10:00:00.123").toISOString()).toBe("2026-11-06T10:00:00.123Z");
    expect(toUtcDate("2026-11-06T10:00:00.123").toISOString()).toBe("2026-11-06T10:00:00.123Z");
  });

  it("respects explicit timezone designators", () => {
    expect(toUtcDate("2026-11-06T10:00:00.000Z").toISOString()).toBe("2026-11-06T10:00:00.000Z");
    expect(toUtcDate("2026-11-06T12:00:00+02:00").toISOString()).toBe("2026-11-06T10:00:00.000Z");
  });
});
