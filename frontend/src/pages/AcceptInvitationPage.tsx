import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { postJson } from "../api/client";
import { Page } from "../components/Page";
import { INVALID_LINK_MESSAGE, TRY_AGAIN_MESSAGE, rateLimitMessage } from "../lib/messages";
import { clearStartupToken, getStartupToken } from "../lib/startupToken";

type Status = "ready" | "submitting" | "done" | "invalid" | "mismatch" | "validation" | "rate_limited" | "retry";

function isValidPassword(password: string): boolean {
  return !password.includes("\u0000")
    && Array.from(password).length >= 10
    && new TextEncoder().encode(password).length <= 72;
}

function normalizedText(value: string): string {
  return value.normalize("NFC").trim();
}

function isValidText(value: string, maxCharacters: number): boolean {
  const normalized = normalizedText(value);
  return normalized.length > 0
    && !/\p{Cc}/u.test(normalized)
    && Array.from(normalized).length <= maxCharacters;
}

export function AcceptInvitationPage() {
  const [token] = useState(() => {
    const startupToken = getStartupToken();
    if (!startupToken || startupToken.length > 256) {
      clearStartupToken();
      return null;
    }
    return startupToken;
  });
  const [status, setStatus] = useState<Status>(token ? "ready" : "invalid");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [staffId, setStaffId] = useState("");
  const [title, setTitle] = useState("");
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const inFlight = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || inFlight.current) return;
    if (password !== confirmation) {
      setStatus("mismatch");
      return;
    }

    const normalizedName = normalizedText(name);
    const normalizedStaffId = normalizedText(staffId);
    const normalizedTitle = normalizedText(title);
    if (
      !isValidText(name, 100)
      || (normalizedStaffId && !isValidText(staffId, 64))
      || (normalizedTitle && !isValidText(title, 100))
      || !isValidPassword(password)
    ) {
      setStatus("validation");
      return;
    }

    inFlight.current = true;
    setStatus("submitting");
    const result = await postJson("/api/v1/invitations/accept", {
      token,
      password,
      name: normalizedName,
      staffId: normalizedStaffId || undefined,
      title: normalizedTitle || undefined,
    });
    inFlight.current = false;

    if (result.ok) {
      clearStartupToken();
      setPassword("");
      setConfirmation("");
      setStatus("done");
    } else if (result.failure === "rate_limited") {
      setRetryAfter(result.retryAfterSeconds);
      setStatus("rate_limited");
    } else if (result.failure === "network" || result.failure === "server") {
      setStatus("retry");
    } else if (result.failure === "validation") {
      setStatus("validation");
    } else {
      clearStartupToken();
      setPassword("");
      setConfirmation("");
      setStatus("invalid");
    }
  }

  if (status === "done") {
    return (
      <Page title="Invitation accepted">
        <p role="status">Your account is ready. <Link to="/login">Sign in</Link>.</p>
      </Page>
    );
  }

  if (status === "invalid") {
    return (
      <Page title="Accept invitation">
        <p role="alert" className="error">{INVALID_LINK_MESSAGE}</p>
      </Page>
    );
  }

  return (
    <Page title="Accept invitation">
      <form method="post" onSubmit={submit}>
        <label htmlFor="name">Full name</label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="password">Create a password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <label htmlFor="confirmation">Confirm password</label>
        <input
          id="confirmation"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <p className="hint">
          At least 10 characters and no more than 72 UTF-8 bytes. NUL characters are not allowed; no composition rules apply.
        </p>
        <label htmlFor="staffId">Staff ID (optional)</label>
        <input
          id="staffId"
          type="text"
          value={staffId}
          onChange={(event) => setStaffId(event.target.value)}
        />
        <label htmlFor="title">Job title (optional)</label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Accepting…" : "Accept invitation"}
        </button>
      </form>
      {status === "mismatch" && <p role="alert" className="error">The two passwords do not match.</p>}
      {status === "validation" && (
        <p role="alert" className="error">Check your details. The password must meet the requirements above.</p>
      )}
      {status === "rate_limited" && <p role="alert" className="error">{rateLimitMessage(retryAfter)}</p>}
      {status === "retry" && <p role="alert" className="error">{TRY_AGAIN_MESSAGE}</p>}
    </Page>
  );
}
