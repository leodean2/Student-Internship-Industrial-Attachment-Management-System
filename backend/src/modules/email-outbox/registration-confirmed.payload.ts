import { z } from "zod";
import { buildPageLink, isHttpUrl } from "./email-link";

export const REGISTRATION_CONFIRMED = "REGISTRATION_CONFIRMED";
export const LOGIN_PATH = "/login";

export const registrationConfirmedPayloadSchema = z.strictObject({
  loginUrl: z.string().max(2048).refine(isHttpUrl, "loginUrl must be an http(s) URL"),
});
export type RegistrationConfirmedPayload = z.infer<typeof registrationConfirmedPayloadSchema>;

export function buildRegistrationConfirmedPayload(input: { appBaseUrl: string }): RegistrationConfirmedPayload {
  return registrationConfirmedPayloadSchema.parse({ loginUrl: buildPageLink(input.appBaseUrl, LOGIN_PATH) });
}
