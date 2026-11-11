import { z } from "zod";

/** Defaults to a dry run: committing needs an explicit dryRun=false. */
export const importQuerySchema = z.strictObject({
  dryRun: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
});

export const listImportsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});
export type ListImportsQuery = z.infer<typeof listImportsQuerySchema>;

export const importIdSchema = z.string().uuid();
