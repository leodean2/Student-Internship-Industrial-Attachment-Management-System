import { z } from "zod";
import { normalizeEmail } from "../../shared/validation/email";
import { checkPassword, PASSWORD_POLICY_MESSAGE } from "../auth/password-policy";
import { checkText } from "../../shared/validation/text";
import { INVITABLE_ROLE } from "./invitation.types";

export const createInvitationBodySchema = z.strictObject({
  email: z.string().max(254).transform(normalizeEmail).pipe(z.string().email()),
  role: z.literal(INVITABLE_ROLE),
});

const passwordSchema = z.string().superRefine((password, context) => {
  if (!checkPassword(password).ok) {
    context.addIssue({ code: "custom", message: PASSWORD_POLICY_MESSAGE });
  }
});

function textSchema(maxCharacters: number) {
  return z.string().transform((value, context) => {
    const checked = checkText(value, maxCharacters);
    if (!checked.ok) {
      const message = checked.reason === "too_long"
        ? `Must be at most ${maxCharacters} characters.`
        : checked.reason === "control_characters"
          ? "Must not contain control characters."
          : "Must not be empty.";
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return checked.value;
  });
}

export const acceptInvitationBodySchema = z.strictObject({
  token: z.string().max(256),
  password: passwordSchema,
  name: textSchema(100),
  staffId: textSchema(64).optional().transform((value) => value ?? null),
  title: textSchema(100).optional().transform((value) => value ?? null),
});

export const invitationListQuerySchema = z.strictObject({
  page: z.coerce.number().int().safe().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().safe().min(1).max(100).default(20),
  status: z.enum(["ACCEPTED", "CANCELLED", "EXPIRED", "PENDING"]).optional(),
  email: z.string().max(254).transform(normalizeEmail).pipe(z.string().email()).optional(),
});

export const invitationIdParamsSchema = z.strictObject({
  id: z.string().min(1).max(128),
});

export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>;
export type InvitationListQuery = z.infer<typeof invitationListQuerySchema>;
