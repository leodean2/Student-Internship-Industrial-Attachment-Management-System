import { z } from "zod";

export const requestPasswordResetBodySchema = z.strictObject({
  email: z
    .string()
    .max(254)
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.string().email()),
});

export const confirmPasswordResetBodySchema = z.strictObject({
  token: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(512),
});

export type RequestPasswordResetBody = z.infer<typeof requestPasswordResetBodySchema>;
export type ConfirmPasswordResetBody = z.infer<typeof confirmPasswordResetBodySchema>;
