import { z } from "zod";

export const REGISTRATION_REJECTED = "REGISTRATION_REJECTED";

/** Deliberately empty: the reviewer's reason stays on the purgeable profile row and never enters an email. */
export const registrationRejectedPayloadSchema = z.strictObject({});
export type RegistrationRejectedPayload = z.infer<typeof registrationRejectedPayloadSchema>;

export const buildRegistrationRejectedPayload = (): RegistrationRejectedPayload =>
  registrationRejectedPayloadSchema.parse({});
