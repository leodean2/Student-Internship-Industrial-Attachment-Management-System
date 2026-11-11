import { z } from "zod";
import { checkPassword, PASSWORD_POLICY_MESSAGE } from "../auth/password-policy";
import { normalizeEmail } from "../../shared/validation/email";
import { isValidRegistrationNumber, normalizeRegistrationNumber } from "../../shared/registration-number";
import { checkText } from "../../shared/validation/text";

const nameSchema = z
  .string()
  .transform((value, context) => {
    const checked = checkText(value, 100);
    if (!checked.ok) {
      const message = checked.reason === "too_long"
        ? "Full name is too long."
        : checked.reason === "control_characters"
          ? "Full name must not contain control characters."
          : "Full name must not be empty.";
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return checked.value.replace(/ +/g, " ");
  })
  .pipe(z.string().min(2, "Full name must be at least 2 characters."));

const registrationNumberSchema = z
  .string()
  .transform(normalizeRegistrationNumber)
  .pipe(z.string().refine(isValidRegistrationNumber, "Registration number must look like CIT-221-029/2024."));

const passwordSchema = z.string().superRefine((password, context) => {
  if (!checkPassword(password).ok) {
    context.addIssue({ code: "custom", message: PASSWORD_POLICY_MESSAGE });
  }
});

export const registerStudentSchema = z.strictObject({
  name: nameSchema,
  email: z.string().max(254).transform(normalizeEmail).pipe(z.string().email("Enter a valid email address.")),
  registrationNumber: registrationNumberSchema,
  password: passwordSchema,
});

export type RegisterStudentInput = z.infer<typeof registerStudentSchema>;

export const verifyEmailSchema = z.strictObject({
  token: z.string().min(1).max(512),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
