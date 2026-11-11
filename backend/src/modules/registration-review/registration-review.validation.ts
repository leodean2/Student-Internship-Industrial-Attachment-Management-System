import { z } from "zod";
import { isValidRegistrationNumber, normalizeRegistrationNumber } from "../../shared/registration-number";

const registrationNumberField = z
  .string()
  .transform(normalizeRegistrationNumber)
  .pipe(z.string().refine(isValidRegistrationNumber, "Registration number must look like CIT-221-029/2024."));

const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(min, `${label} must be at least ${min} characters.`)
        .max(max, `${label} must be at most ${max} characters.`),
    );

export const listQuerySchema = z.strictObject({
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED"]).default("PENDING"),
  emailVerified: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  registrationNumber: registrationNumberField.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const confirmBodySchema = z.strictObject({ basis: trimmed(1, 200, "Basis") });
export type ConfirmInput = z.infer<typeof confirmBodySchema>;

export const rejectBodySchema = z.strictObject({ reason: trimmed(10, 500, "Reason") });
export type RejectInput = z.infer<typeof rejectBodySchema>;

/** The registration number only: the department is always derived on the server, never supplied. */
export const correctBodySchema = z.strictObject({ registrationNumber: registrationNumberField });
export type CorrectInput = z.infer<typeof correctBodySchema>;

export const profileIdSchema = z.string().uuid();
