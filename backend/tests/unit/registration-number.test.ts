import { describe, expect, it } from "vitest";
import {
  departmentCodeOf,
  isValidRegistrationNumber,
  normalizeRegistrationNumber,
} from "../../src/shared/registration-number";

describe("registration number helpers", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(normalizeRegistrationNumber("  cit-221-029/2024 ")).toBe("CIT-221-029/2024");
  });

  it("accepts the provisional shape and rejects noncanonical values", () => {
    expect(isValidRegistrationNumber("CIT-221-029/2024")).toBe(true);
    for (const bad of [
      "",
      "cit-221-029/2024",
      "CIT-22-029/2024",
      "CIT-221-029/24",
      "CIT221029/2024",
      "CIT-221-029-2024",
      "CITY-221-029/2024",
      "CIT-221-029/2024 ",
    ]) {
      expect(isValidRegistrationNumber(bad)).toBe(false);
    }
  });

  it("derives the department segment only from a valid number", () => {
    expect(departmentCodeOf("CIT-221-029/2024")).toBe("CIT");
    expect(() => departmentCodeOf("nonsense")).toThrow(RangeError);
  });
});
