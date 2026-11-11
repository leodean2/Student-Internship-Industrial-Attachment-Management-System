import { z } from "zod";

export const deactivateAccountParamsSchema = z.object({
  userId: z.string().uuid(),
});
