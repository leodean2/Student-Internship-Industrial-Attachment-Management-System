import { useRef, useState } from "react";
import { postJson } from "../api/client";
import { Page } from "../components/Page";
import { clearStartupToken, getStartupToken } from "../lib/startupToken";
import { INVALID_LINK_MESSAGE, TRY_AGAIN_MESSAGE, rateLimitMessage } from "../lib/messages";

type Status = "ready" | "submitting" | "done" | "invalid" | "rate_limited" | "retry";

export function VerifyEmailPage() {
  const [token] = useState(getStartupToken);
  const [status, setStatus] = useState<Status>(token ? "ready" : "invalid");
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const inFlight = useRef(false);

  async function confirm() {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    setStatus("submitting");
    const result = await postJson("/api/v1/auth/verify-email", { token });
    inFlight.current = false;
    if (result.ok) {
      clearStartupToken();
      setStatus("done");
    } else if (result.failure === "rate_limited") {
      setRetryAfter(result.retryAfterSeconds);
      setStatus("rate_limited");
    } else if (result.failure === "network" || result.failure === "server") {
      setStatus("retry");
    } else {
      clearStartupToken();
      setStatus("invalid");
    }
  }

  if (status === "done") {
    return (
      <Page title="Email verified">
        <p role="status">
          Thank you. Your email address is verified. Your registration number now needs to be confirmed by your
          department. You will receive an email when your account is active.
        </p>
      </Page>
    );
  }

  if (status === "invalid") {
    return (
      <Page title="Verify your email">
        <p role="alert" className="error">{INVALID_LINK_MESSAGE}</p>
      </Page>
    );
  }

  return (
    <Page title="Verify your email">
      <p>Confirm that this is your email address to continue your registration.</p>
      <button type="button" onClick={confirm} disabled={status === "submitting"}>
        {status === "submitting" ? "Confirming…" : "Confirm my email"}
      </button>
      {status === "rate_limited" && <p role="alert" className="error">{rateLimitMessage(retryAfter)}</p>}
      {status === "retry" && <p role="alert" className="error">{TRY_AGAIN_MESSAGE}</p>}
    </Page>
  );
}
