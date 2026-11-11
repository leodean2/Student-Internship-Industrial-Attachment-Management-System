import { describe, expect, it } from "vitest";
import { createInvitationBodySchema } from "../../src/modules/invitations/invitation.validation";

const valid = { email: "jane@example.test", role: "UNIVERSITY_SUPERVISOR" };

describe("create-invitation request validation", () => {
  it("accepts a University Supervisor invitation", () => {
    expect(createInvitationBodySchema.parse(valid)).toEqual(valid);
  });

  it("normalizes the email by trimming and lower-casing", () => {
    expect(createInvitationBodySchema.parse({ ...valid, email: "  Jane@Example.TEST " }).email).toBe("jane@example.test");
  });

  it.each(["STUDENT", "ORGANIZATION_SUPERVISOR", "ADMIN", "university_supervisor", "", "SUPERUSER"])(
    "rejects unsupported role %j",
    (role) => {
      expect(createInvitationBodySchema.safeParse({ ...valid, role }).success).toBe(false);
    },
  );

  it("requires both fields", () => {
    expect(createInvitationBodySchema.safeParse({ role: valid.role }).success).toBe(false);
    expect(createInvitationBodySchema.safeParse({ email: valid.email }).success).toBe(false);
    expect(createInvitationBodySchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown fields, including organization and expiry fields", () => {
    expect(createInvitationBodySchema.safeParse({ ...valid, organizationId: "org-1" }).success).toBe(false);
    expect(createInvitationBodySchema.safeParse({ ...valid, expiresAt: "2030-01-01" }).success).toBe(false);
  });

  it("rejects malformed and oversized emails", () => {
    expect(createInvitationBodySchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
    expect(createInvitationBodySchema.safeParse({ ...valid, email: `${"a".repeat(250)}@x.test` }).success).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(createInvitationBodySchema.safeParse({ email: 5, role: valid.role }).success).toBe(false);
    expect(createInvitationBodySchema.safeParse({ email: valid.email, role: ["UNIVERSITY_SUPERVISOR"] }).success).toBe(false);
  });
});
