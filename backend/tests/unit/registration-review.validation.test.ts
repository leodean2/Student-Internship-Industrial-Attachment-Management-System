import { describe, expect, it } from "vitest";
import {
  confirmBodySchema,
  correctBodySchema,
  listQuerySchema,
  rejectBodySchema,
} from "../../src/modules/registration-review/registration-review.validation";

describe("correctBodySchema", () => {
  it("accepts only a normalized, well-shaped registration number", () => {
    expect(correctBodySchema.parse({ registrationNumber: " cit-221-029/2024 " })).toEqual({
      registrationNumber: "CIT-221-029/2024",
    });
    expect(correctBodySchema.safeParse({ registrationNumber: "nonsense" }).success).toBe(false);
  });

  it("rejects a reason and any client-supplied department or status", () => {
    const base = { registrationNumber: "CIT-221-029/2024" };
    for (const extra of [
      { reason: "typo" },
      { departmentCode: "BUS" },
      { department: "BUS" },
      { status: "CONFIRMED" },
    ]) {
      expect(correctBodySchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
});

describe("decision bodies", () => {
  it("requires a basis of 1 to 200 characters and a reason of 10 to 500", () => {
    expect(confirmBodySchema.safeParse({ basis: "checked against the roster" }).success).toBe(true);
    expect(confirmBodySchema.safeParse({ basis: "   " }).success).toBe(false);
    expect(confirmBodySchema.safeParse({ basis: "x".repeat(201) }).success).toBe(false);
    expect(rejectBodySchema.safeParse({ reason: "too short" }).success).toBe(false);
    expect(rejectBodySchema.safeParse({ reason: "not on the official roster" }).success).toBe(true);
    expect(rejectBodySchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });
});

describe("listQuerySchema", () => {
  it("defaults to PENDING and 50 and parses filters", () => {
    expect(listQuerySchema.parse({})).toEqual({ status: "PENDING", limit: 50 });
    expect(listQuerySchema.parse({
      status: "REJECTED",
      emailVerified: "false",
      registrationNumber: "cit-221-001/2024",
    })).toMatchObject({
      status: "REJECTED",
      emailVerified: false,
      registrationNumber: "CIT-221-001/2024",
    });
    expect(listQuerySchema.safeParse({ status: "DONE" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});
