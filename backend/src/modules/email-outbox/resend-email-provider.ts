import type { EmailMessage, EmailProvider } from "./email-provider";
import { PermanentEmailError } from "./email-provider";
import { renderEmail, type RenderedEmail } from "./email-templates";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const PERMANENT_REJECTION_STATUSES = new Set([400, 404, 422]);

export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly render: (message: EmailMessage) => RenderedEmail = renderEmail,
  ) {}

  async send(message: EmailMessage, signal: AbortSignal): Promise<void> {
    const rendered = this.render(message);
    const response = await this.fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `outbox/${message.id}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: message.toEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
      signal,
    });

    if (response.ok) return;

    const error = `Resend rejected the email request with HTTP ${response.status}`;
    if (PERMANENT_REJECTION_STATUSES.has(response.status)) throw new PermanentEmailError(error);
    throw new Error(error);
  }
}
