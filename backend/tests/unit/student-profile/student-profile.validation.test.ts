import { describe, expect, it } from "vitest";
import { createUpdateStudentProfileSchema } from "../../../src/modules/student-profile/student-profile.validation";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const schema = createUpdateStudentProfileSchema(() => NOW);
const ok = (value: unknown) => schema.safeParse(value).success;

describe("createUpdateStudentProfileSchema", () => {
  it("normalizes text, phone and dates", () => {
    const parsed = schema.parse({ university: "  Example   University ", phone: "0712 345 678", expectedGraduation: "2028-06-30" });
    expect(parsed.university).toBe("Example University");
    expect(parsed.phone).toBe("+254712345678");
    expect(parsed.expectedGraduation).toEqual(new Date("2028-06-30T00:00:00.000Z"));
  });

  it("lets null clear a field and rejects an empty string", () => {
    expect(schema.parse({ phone: null, university: null }).university).toBeNull();
    expect(ok({ university: "" })).toBe(false);
    expect(ok({ university: "   " })).toBe(false);
  });

  it("requires at least one field", () => {
    expect(ok({})).toBe(false);
  });

  it("rejects registration fields, status, isComplete and any unknown key", () => {
    for (const extra of ["name", "email", "registrationNumber", "registrationStatus", "status", "isComplete", "userId", "role"]) {
      expect(ok({ phone: "0712345678", [extra]: "x" }), extra).toBe(false);
    }
  });

  it("checks each proposed bound at its edge", () => {
    expect(ok({ university: "ab" })).toBe(true);
    expect(ok({ university: "a" })).toBe(false);
    expect(ok({ university: "x".repeat(150) })).toBe(true);
    expect(ok({ university: "x".repeat(151) })).toBe(false);
    expect(ok({ yearOfStudy: 1 })).toBe(true);
    expect(ok({ yearOfStudy: 7 })).toBe(true);
    expect(ok({ yearOfStudy: 0 })).toBe(false);
    expect(ok({ yearOfStudy: 8 })).toBe(false);
    expect(ok({ yearOfStudy: 2.5 })).toBe(false);
    expect(ok({ yearOfStudy: "3" })).toBe(false);
  });

  it("accepts a graduation date from today to eight years ahead, nothing else", () => {
    expect(ok({ expectedGraduation: "2026-11-10" })).toBe(true);  // today
    expect(ok({ expectedGraduation: "2026-11-09" })).toBe(false); // yesterday
    expect(ok({ expectedGraduation: "2034-11-10" })).toBe(true);  // exactly 8 years ahead
    expect(ok({ expectedGraduation: "2034-11-11" })).toBe(false); // one day over
    expect(ok({ expectedGraduation: "2027-02-30" })).toBe(false); // not a real date
    expect(ok({ expectedGraduation: "30/06/2028" })).toBe(false);
    expect(ok({ expectedGraduation: "2028-06-30T00:00:00Z" })).toBe(false);
  });

  it("rejects an invalid phone number", () => {
    expect(ok({ phone: "12345" })).toBe(false);
    expect(ok({ phone: "+14155552671" })).toBe(false); // non-Kenyan E.164 is now rejected (C1-F decision D4)
  });
});
