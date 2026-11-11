import { z } from "zod";

export const PASSWORD_CHANGED = "PASSWORD_CHANGED";

/** No dynamic data: a generic security notice only. */
export const passwordChangedPayloadSchema = z.strictObject({}).default({});
export type PasswordChangedPayload = z.infer<typeof passwordChangedPayloadSchema>;

export function buildPasswordChangedPayload(): PasswordChangedPayload {
  return {};
}
