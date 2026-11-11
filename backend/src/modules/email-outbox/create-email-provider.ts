import type { Logger } from "pino";
import type { WorkerEnv } from "../../config/env";
import type { EmailProvider } from "./email-provider";
import { emailTemplates } from "./email-templates";
import { LogEmailProvider } from "./log-email-provider";
import { ResendEmailProvider } from "./resend-email-provider";

export function createEmailProvider(env: WorkerEnv, logger: Logger): EmailProvider {
  if (env.EMAIL_PROVIDER === "log") return new LogEmailProvider(logger);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error("Resend provider configuration is incomplete");
  }
  if (Object.keys(emailTemplates).length === 0) {
    throw new Error("Cannot start the Resend worker until at least one email template is registered");
  }
  return new ResendEmailProvider(env.RESEND_API_KEY, env.EMAIL_FROM);
}
