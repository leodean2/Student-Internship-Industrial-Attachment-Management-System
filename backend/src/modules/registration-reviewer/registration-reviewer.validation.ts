import { z } from "zod";

export const departmentCodeSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2,10}$/, "Department code must be 2 to 10 letters or digits."));

export const grantReviewerSchema = z.strictObject({
  userId: z.string().uuid(),
  departmentCode: departmentCodeSchema,
});
export type GrantReviewerInput = z.infer<typeof grantReviewerSchema>;

export const listReviewersQuerySchema = z.strictObject({
  userId: z.string().uuid().optional(),
  departmentCode: departmentCodeSchema.optional(),
  active: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});
export type ListReviewersQuery = z.infer<typeof listReviewersQuerySchema>;

export const reviewerIdSchema = z.string().uuid();
