import { describe, expect, it, vi } from "vitest";
import { loadWorkerEnv } from "../../src/config/env";
import { createLogger } from "../../src/infrastructure/logger";
import { PermanentEmailError, type EmailMessage } from "../../src/modules/email-outbox/email-provider";
import { renderEmail } from "../../src/modules/email-outbox/email-templates";
import { createEmailProvider } from "../../src/modules/email-outbox/create-email-provider";
import { LogEmailProvider } from "../../src/modules/email-outbox/log-email-provider";
import { ResendEmailProvider } from "../../src/modules/email-outbox/resend-email-provider";
import { captureLogs } from "./helpers";

const message: EmailMessage = {
  id: "email-1",
  toEmail: "person@example.com",
  templateType: "UNKNOWN_TEMPLATE",
  payload: { token: "secret-token" },
  attempt: 2,
};

describe("email templates", () => {
  it("fails permanently for an unregistered template without exposing its payload", () => {
    try {
      renderEmail(message);
      throw new Error("expected renderEmail to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentEmailError);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("UNKNOWN_TEMPLATE");
      expect(error.message).not.toContain("secret-token");
    }
  });
});

describe("LogEmailProvider", () => {
  it("logs safe metadata and resolves without logging the recipient or payload", async () => {
    const logs = captureLogs();
    const provider = new LogEmailProvider(createLogger("info", logs.stream));
    await provider.send(message, new AbortController().signal);
    expect(logs.text()).toContain("email-1");
    expect(logs.text()).toContain("UNKNOWN_TEMPLATE");
    expect(logs.text()).toContain("no message was sent");
    expect(logs.text()).not.toContain("person@example.com");
    expect(logs.text()).not.toContain("secret-token");
  });

  it("redacts verification links from structured logs", () => {
    const logs = captureLogs();
    const logger = createLogger("info", logs.stream);
    const verificationUrl = "https://app.example.test/verify-email?token=secret-verification-token";

    logger.info({ verificationUrl, email: { verificationUrl } }, "verification message");

    expect(logs.text()).toContain("[REDACTED]");
    expect(logs.text()).not.toContain("secret-verification-token");
  });

  it("redacts password-reset links from structured logs", () => {
    const logs = captureLogs();
    const logger = createLogger("info", logs.stream);
    const resetUrl = "https://app.example.test/reset-password?token=secret-reset-token";

    logger.info({ resetUrl, email: { resetUrl } }, "password reset message");

    expect(logs.text()).toContain("[REDACTED]");
    expect(logs.text()).not.toContain("secret-reset-token");
  });
});

describe("createEmailProvider", () => {
  it("allows the local log sink and creates Resend when a template is registered", () => {
    const logger = createLogger("silent");
    const local = loadWorkerEnv({ DATABASE_URL: "postgresql://localhost/db" });
    const resend = loadWorkerEnv({
      DATABASE_URL: "postgresql://localhost/db",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "api-secret",
      EMAIL_FROM: "noreply@example.com",
    });

    expect(createEmailProvider(local, logger)).toBeInstanceOf(LogEmailProvider);
    expect(createEmailProvider(resend, logger)).toBeInstanceOf(ResendEmailProvider);
  });
});

describe("ResendEmailProvider", () => {
  const render = vi.fn(() => ({ subject: "Subject", html: "<p>Body</p>", text: "Body" }));

  it("sends a rendered message with a stable outbox idempotency key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const provider = new ResendEmailProvider("api-secret", "noreply@example.com", fetchImpl, render);
    await provider.send(message, new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer api-secret",
      "Idempotency-Key": "outbox/email-1",
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      from: "noreply@example.com",
      to: "person@example.com",
      subject: "Subject",
      html: "<p>Body</p>",
      text: "Body",
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 404, 422])("classifies HTTP %s as a permanent rejection", async (status) => {
    const provider = new ResendEmailProvider(
      "api-secret",
      "noreply@example.com",
      vi.fn<typeof fetch>(async () => new Response(null, { status })),
      render,
    );

    await expect(provider.send(message, new AbortController().signal)).rejects.toBeInstanceOf(PermanentEmailError);
  });

  it.each([401, 403, 408, 429, 500, 503])("classifies HTTP %s as transient", async (status) => {
    const provider = new ResendEmailProvider(
      "api-secret",
      "noreply@example.com",
      vi.fn<typeof fetch>(async () => new Response(null, { status })),
      render,
    );

    const error = await provider.send(message, new AbortController().signal).catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(PermanentEmailError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("api-secret");
    expect((error as Error).message).not.toContain(message.toEmail);
    expect((error as Error).message).not.toContain("secret-token");
  });
});
