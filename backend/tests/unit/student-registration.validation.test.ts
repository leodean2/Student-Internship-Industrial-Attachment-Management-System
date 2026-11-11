import { describe, expect, it } from "vitest";
import { registerStudentSchema, verifyEmailSchema } from "../../src/modules/student-registration/student-registration.validation";

const valid = {
  name: "  Jane   Student ",
  email: "  JANE@Example.test ",
  registrationNumber: " cit-221-001/2024 ",
  password: "Correct-Horse-9!",
};

describe("registerStudentSchema", () => {
  it("normalizes name, email and registration number", () => {
    expect(registerStudentSchema.parse(valid)).toMatchObject({
      name: "Jane Student",
      email: "jane@example.test",
      registrationNumber: "CIT-221-001/2024",
    });
  });

  it("requires exactly the four registration fields", () => {
    for (const key of ["name", "email", "registrationNumber", "password"] as const) {
      const { [key]: _omitted, ...rest } = valid;
      expect(registerStudentSchema.safeParse(rest).success).toBe(false);
    }
    for (const extra of ["programme", "role", "status", "phone"]) {
      expect(registerStudentSchema.safeParse({ ...valid, [extra]: "x" }).success).toBe(false);
    }
  });

  it("rejects malformed registration numbers, short names and invalid passwords", () => {
    expect(registerStudentSchema.safeParse({ ...valid, registrationNumber: "<script>" }).success).toBe(false);
    expect(registerStudentSchema.safeParse({ ...valid, name: "J" }).success).toBe(false);
    expect(registerStudentSchema.safeParse({ ...valid, password: "short" }).success).toBe(false);
  });
});

describe("verifyEmailSchema", () => {
  it("accepts only a non-empty bounded token", () => {
    expect(verifyEmailSchema.safeParse({ token: "abc" }).success).toBe(true);
    expect(verifyEmailSchema.safeParse({ token: "abc", extra: 1 }).success).toBe(false);
    expect(verifyEmailSchema.safeParse({ token: "" }).success).toBe(false);
  });
});
