import type { Logger } from "pino";
import type { EmailMessage, EmailProvider } from "./email-provider";

/** Local development sink only. Resolving marks the outbox row SENT; no email is delivered. */
export class LogEmailProvider implements EmailProvider {
  constructor(private readonly logger: Logger) {}

  async send(message: EmailMessage, _signal: AbortSignal): Promise<void> {
    this.logger.info(
      { messageId: message.id, templateType: message.templateType },
      "email suppressed by log provider; no message was sent",
    );
  }
}
