import { z } from "zod";

/** Unknown fields are a 400, not silently ignored (a typo or a smuggled `role` must not pass). */
export const loginBodySchema = z.strictObject({
  email: z
    .string()
    .max(254)
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.string().email()),
  // A cheap abuse guard only; password policy belongs to registration.
  password: z.string().min(1).max(256),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
