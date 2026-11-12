import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { postJsonForData } from "../api/client";
import { Page } from "../components/Page";

const SIGN_IN_FAILURE_MESSAGE = "We couldn't sign you in. Check your details and try again.";

type LoginResponse = {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
};

function isLoginResponse(value: unknown): value is LoginResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return typeof response.accessToken === "string"
    && response.accessToken.length > 0
    && response.tokenType === "Bearer"
    && typeof response.expiresIn === "number"
    && Number.isSafeInteger(response.expiresIn)
    && response.expiresIn > 0;
}

export function LoginPage({ onLogin }: { onLogin: (accessToken: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "failed">("idle");
  const inFlight = useRef(false);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password || inFlight.current) return;

    inFlight.current = true;
    setStatus("submitting");
    const result = await postJsonForData(
      "/api/v1/auth/login",
      { email: normalizedEmail, password },
      { credentials: "include" },
    );
    inFlight.current = false;
    setPassword("");

    if (!result.ok || !isLoginResponse(result.data)) {
      setStatus("failed");
      return;
    }

    onLogin(result.data.accessToken);
    navigate("/home");
  }

  return (
    <Page title="Sign in">
      <form method="post" onSubmit={submit}>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="hint">New students can sign in once their department has confirmed their registration.</p>
      {status === "failed" && <p role="alert" className="error">{SIGN_IN_FAILURE_MESSAGE}</p>}
      <p><Link to="/forgot-password">Forgot your password?</Link></p>
    </Page>
  );
}
