import { describe, expect, it } from "vitest";
import {
  grantReviewerSchema,
  listReviewersQuerySchema,
} from "../../src/modules/registration-reviewer/registration-reviewer.validation";

const USER_ID = "7d2b8c1e-3f4a-4b5c-8d6e-9f0a1b2c3d4e";

describe("grantReviewerSchema", () => {
  it("normalizes the department code", () => {
    expect(grantReviewerSchema.parse({ userId: USER_ID, departmentCode: " cit " }).departmentCode).toBe("CIT");
  });

  it("rejects bad codes, bad ids, and extra fields", () => {
    for (const departmentCode of ["", "C", "TOOLONGCODE1", "CI T", "CIT-1"]) {
      expect(grantReviewerSchema.safeParse({ userId: USER_ID, departmentCode }).success).toBe(false);
    }
    expect(grantReviewerSchema.safeParse({ userId: "nope", departmentCode: "CIT" }).success).toBe(false);
    expect(grantReviewerSchema.safeParse({ userId: USER_ID, departmentCode: "CIT", role: "ADMIN" }).success).toBe(
      false,
    );
  });
});

describe("listReviewersQuerySchema", () => {
  it("applies defaults and parses booleans", () => {
    expect(listReviewersQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(listReviewersQuerySchema.parse({ active: "true", limit: "10" })).toMatchObject({
      active: true,
      limit: 10,
    });
    expect(listReviewersQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(listReviewersQuerySchema.safeParse({ active: "yes" }).success).toBe(false);
  });
});
