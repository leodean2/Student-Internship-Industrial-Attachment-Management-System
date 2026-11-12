import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { postJson } from "../api/client";
import { Page } from "../components/Page";
import { TRY_AGAIN_MESSAGE, rateLimitMessage } from "../lib/messages";

type Status = "idle" | "submitting" | "sent" | "rate_limited" | "retry";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const inFlight = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setStatus("submitting");
    const result = await postJson("/api/v1/auth/request-password-reset", { email: trimmed });
    inFlight.current = false;
    if (result.ok) {
      setEmail("");
      setStatus("sent");
    } else if (result.failure === "rate_limited") {
      setRetryAfter(result.retryAfterSeconds);
      setStatus("rate_limited");
    } else {
      setStatus("retry");
    }
  }

  return (
    <Page title="Reset your password">
      <form method="post" onSubmit={submit}>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Sending…" : "Send reset link"}
        </button>
      </form>
      {status === "sent" && (
        <p role="status">If an account exists for that address, we have sent a link to reset the password.</p>
      )}
      {status === "rate_limited" && <p role="alert" className="error">{rateLimitMessage(retryAfter)}</p>}
      {status === "retry" && <p role="alert" className="error">{TRY_AGAIN_MESSAGE}</p>}
      <p><Link to="/login">Back to sign in</Link></p>
    </Page>
  );
}
