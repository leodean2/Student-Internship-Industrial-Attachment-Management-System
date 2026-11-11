import { z } from "zod";
import { buildTokenLink, isHttpUrl, isUtcInstant } from "./email-link";

export const EMAIL_VERIFICATION_REQUESTED = "EMAIL_VERIFICATION_REQUESTED";
export const VERIFY_EMAIL_PATH = "/verify-email";

/** The raw token lives only inside `verificationUrl`: no second copy in the payload. */
export const emailVerificationRequestedPayloadSchema = z
  .object({
    verificationUrl: z.string().max(2048).refine(isHttpUrl, "verificationUrl must be an http(s) URL"),
    expiresAt: z.string().refine(isUtcInstant, "expiresAt must be a UTC ISO-8601 instant"),
  })
  .strict();

export type EmailVerificationRequestedPayload = z.infer<typeof emailVerificationRequestedPayloadSchema>;

export function buildVerificationUrl(appBaseUrl: string, rawToken: string): string {
  return buildTokenLink(appBaseUrl, VERIFY_EMAIL_PATH, rawToken);
}

export function buildEmailVerificationRequestedPayload(input: {
  appBaseUrl: string;
  rawToken: string;
  expiresAt: Date;
}): EmailVerificationRequestedPayload {
  return emailVerificationRequestedPayloadSchema.parse({
    verificationUrl: buildVerificationUrl(input.appBaseUrl, input.rawToken),
    expiresAt: input.expiresAt.toISOString(),
  });
}
