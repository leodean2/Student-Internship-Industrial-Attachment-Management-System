import { z } from "zod";
import { buildTokenLink, isHttpUrl, isUtcInstant } from "./email-link";

export const PASSWORD_RESET_REQUESTED = "PASSWORD_RESET_REQUESTED";
export const PASSWORD_RESET_PATH = "/reset-password";

/** The raw token lives only inside `resetUrl`; no second copy in the payload. */
export const passwordResetRequestedPayloadSchema = z
  .object({
    resetUrl: z.string().max(2048).refine(isHttpUrl, "resetUrl must be an http(s) URL"),
    expiresAt: z.string().refine(isUtcInstant, "expiresAt must be a UTC ISO-8601 instant"),
  })
  .strict();

export type PasswordResetRequestedPayload = z.infer<typeof passwordResetRequestedPayloadSchema>;

export function buildResetUrl(appBaseUrl: string, rawToken: string): string {
  return buildTokenLink(appBaseUrl, PASSWORD_RESET_PATH, rawToken);
}

export function buildPasswordResetRequestedPayload(input: {
  appBaseUrl: string;
  rawToken: string;
  expiresAt: Date;
}): PasswordResetRequestedPayload {
  return passwordResetRequestedPayloadSchema.parse({
    resetUrl: buildResetUrl(input.appBaseUrl, input.rawToken),
    expiresAt: input.expiresAt.toISOString(),
  });
}
