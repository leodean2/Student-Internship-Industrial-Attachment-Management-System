import { z } from "zod";

export const ACCOUNT_DEACTIVATED = "ACCOUNT_DEACTIVATED";

/** No dynamic data: the amendment mandates generic wording only (C3 §6). */
export const accountDeactivatedPayloadSchema = z.strictObject({}).default({});
export type AccountDeactivatedPayload = z.infer<typeof accountDeactivatedPayloadSchema>;

export function buildAccountDeactivatedPayload(): AccountDeactivatedPayload {
  return {};
}
