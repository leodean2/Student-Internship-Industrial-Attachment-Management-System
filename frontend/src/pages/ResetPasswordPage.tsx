import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { postJson } from "../api/client";
import { Page } from "../components/Page";
import { clearStartupToken, getStartupToken } from "../lib/startupToken";
import { INVALID_LINK_MESSAGE, TRY_AGAIN_MESSAGE, rateLimitMessage } from "../lib/messages";

type Status = "ready" | "submitting" | "done" | "invalid" | "mismatch" | "weak" | "rate_limited" | "retry";

export function ResetPasswordPage() {
  const [token] = useState(getStartupToken);
  const [status, setStatus] = useState<Status>(token ? "ready" : "invalid");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const inFlight = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || inFlight.current) return;
    if (password !== confirmation) {
      setStatus("mismatch");
      return;
    }
    inFlight.current = true;
    setStatus("submitting");
    const result = await postJson("/api/v1/auth/confirm-password-reset", { token, newPassword: password });
    inFlight.current = false;
    if (result.ok) {
      clearStartupToken();
      setPassword("");
      setConfirmation("");
      setStatus("done");
    } else if (result.failure === "validation") {
      setStatus("weak");
    } else if (result.failure === "rate_limited") {
      setRetryAfter(result.retryAfterSeconds);
      setStatus("rate_limited");
    } else if (result.failure === "network" || result.failure === "server") {
      setStatus("retry");
    } else {
      clearStartupToken();
      setPassword("");
      setConfirmation("");
      setStatus("invalid");
    }
  }

  if (status === "done") {
    return (
      <Page title="Password updated">
        <p role="status">Your password has been changed. You can now <Link to="/login">sign in</Link>.</p>
      </Page>
    );
  }

  if (status === "invalid") {
    return (
      <Page title="Reset your password">
        <p role="alert" className="error">{INVALID_LINK_MESSAGE}</p>
        <p><Link to="/forgot-password">Request a new link</Link></p>
      </Page>
    );
  }

  return (
    <Page title="Choose a new password">
      <form method="post" onSubmit={submit}>
        <label htmlFor="password">New password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <label htmlFor="confirmation">Confirm new password</label>
        <input
          id="confirmation"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Saving…" : "Change password"}
        </button>
      </form>
      {status === "mismatch" && <p role="alert" className="error">The two passwords do not match.</p>}
      {status === "weak" && (
        <p role="alert" className="error">
          That password does not meet the requirements. Choose a longer, less common password.
        </p>
      )}
      {status === "rate_limited" && <p role="alert" className="error">{rateLimitMessage(retryAfter)}</p>}
      {status === "retry" && <p role="alert" className="error">{TRY_AGAIN_MESSAGE}</p>}
    </Page>
  );
}
