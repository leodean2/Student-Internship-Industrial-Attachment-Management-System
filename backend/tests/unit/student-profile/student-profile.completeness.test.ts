import { describe, expect, it } from "vitest";
import { isProfileComplete, type ProfileFields } from "../../../src/modules/student-profile/student-profile.completeness";

const full: ProfileFields = {
  university: "Example University",
  faculty: "Computing",
  department: "Information Technology",
  course: "BSc Information Technology",
  yearOfStudy: 3,
  phone: "+254712345678",
  expectedGraduation: new Date("2027-06-30T00:00:00.000Z"),
};

describe("isProfileComplete", () => {
  it("is true only when all seven fields are valid", () => {
    expect(isProfileComplete(full)).toBe(true);
  });

  it("is false when any single field is missing or invalid", () => {
    const broken: Partial<ProfileFields>[] = [
      { university: null }, { faculty: null }, { department: null }, { course: null },
      { yearOfStudy: null }, { phone: null }, { expectedGraduation: null },
      { university: " " }, { yearOfStudy: 0 }, { yearOfStudy: 99 }, { phone: "0712345678" },
      { expectedGraduation: new Date("invalid") },
    ];
    for (const change of broken) {
      expect(isProfileComplete({ ...full, ...change }), JSON.stringify(change)).toBe(false);
    }
  });

  it("does not flip to incomplete as a stored graduation date passes", () => {
    expect(isProfileComplete({ ...full, expectedGraduation: new Date("2001-01-01T00:00:00.000Z") })).toBe(true);
  });
});
