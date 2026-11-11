import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../../src/shared/db/errors";

describe("isUniqueViolation", () => {
  it.each([
    ["PostgreSQL error code", { code: "23505" }],
    ["Prisma unique constraint code", { code: "P2002" }],
    ["Prisma raw-query code", { code: "P2010", meta: { code: "23505" } }],
    ["SQLSTATE in the message", { message: "Query failed with SQLSTATE 23505" }],
    ["PostgreSQL unique-constraint message", { message: 'duplicate key value violates unique constraint "users_email_key"' }],
  ])("recognizes %s", (_label, error) => {
    expect(isUniqueViolation(error)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a primitive", "23505"],
    ["a different database error", { code: "23503", message: "foreign key violation" }],
  ])("rejects %s", (_label, error) => {
    expect(isUniqueViolation(error)).toBe(false);
  });
});
