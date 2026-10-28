# Decision log addendum — Decisions #79–#82

*Login slice. Approved after the session hardening and the first backend slices. To be folded into the SRS consolidation pass (the SRS covers Decisions #1–48; #75–#78 are in `decisions-75-78.md`).*

---

## Decision #79 — Login throttling

**Status:** Approved (V1: in-memory storage).

**Rule.** Failed login attempts are limited over a 15-minute sliding window:

- 10 failed attempts per **IP address + normalized email**.
- 50 failed attempts per **IP address**, whatever email is used, so changing the email cannot bypass it.

Over a limit the API answers `429 RATE_LIMITED` with a `Retry-After` header (whole seconds until a slot frees). This extends the error taxonomy of #55. The message never says which limit was hit.

- An attempt counted at time `t` expires at exactly `t + 15 min`.
- Only failures count: an unknown email or wrong password. A correct password gives the slot back; so does an inactive account probed with the correct password, and so does an infrastructure error.
- A successful login forgets the IP+email count. It never resets the IP-wide count, otherwise an attacker holding one valid account could reset their own budget.
- Refused attempts are not recorded, so hammering a locked account cannot extend the lock.
- A request with an invalid body (400) or a wrong `Origin` (403) uses no attempt.

**Why.** The IP+email key stops guessing one account from one place, without letting an attacker elsewhere lock the real user out. The IP-wide key stops one place trying many accounts. An attempt reserves its slot **before** the password is checked and gives it back if it was not a failure, so simultaneous guesses cannot exceed the limit (25 parallel wrong guesses let exactly 10 through).

**Storage and limits.**

- Counters live in memory behind an `AttemptStore` interface. They reset on restart and are **not shared between API instances**. If the API is scaled to several instances, revisit shared storage (for example PostgreSQL); callers do not change.
- Memory is bounded: expired entries are swept, and past 50,000 keys the oldest are forgotten (fails open).
- Many users behind one shared address (for example a campus network) share the IP-wide budget of 50. Whether 10 / 50 / 15 minutes suit MMU's real usage is a **Requirement to Validate**.

**Where it lives.** `src/modules/auth/login-throttle.ts`, `login.service.ts`; tests in `login-throttle.test.ts`, `login.service.test.ts`, `login.http.test.ts`.

---

## Decision #80 — Login failure and account-state disclosure

**Status:** Approved.

**Rule.**

- Unknown email and wrong password return the **same** `401 UNAUTHENTICATED` with the message "Invalid email or password."
- Exactly one bcrypt comparison runs in both cases. For an unknown email it is made against a dummy hash of the same cost, so response time does not reveal whether the account exists. The dummy hash is generated once per process at startup (not a fixed constant) and is a hash of a random value.
- `ACCOUNT_INACTIVE` is returned **only after the password was verified** for a deactivated or unverified account. With a wrong password the answer is the generic failure.
- A user with no role (the seeded `SYSTEM` user) always gets the generic failure and never a session.
- Passwords are hashed with bcrypt at cost 12 (#51). The library is `bcrypt` (6.0.0). `bcryptjs` is used only if the native package cannot be installed or operated reliably; hash format and tests stay the same, and only the import in `password.ts` changes.
- bcrypt uses only the first 72 bytes of a password. The login body allows up to 256 characters as an abuse guard. The registration slice must enforce its own policy and cap.

**Why.** Non-enumeration (#51, #55): an attacker must not learn whether an account exists, or is inactive, without knowing its password.

**Where it lives.** `login.service.ts`, `password.ts`, `credentials.repository.ts`.

---

## Decision #81 — Login request protection and client address

**Status:** Approved.

**Rule.**

- `POST /api/v1/auth/login` requires an allow-listed `Origin`; a missing or foreign `Origin` is a `403` (the same defence as `/refresh` and `/logout`, #55), checked before the body.
- The body is strict: unknown fields are a `400`, not ignored. Email is trimmed and lower-cased; a validation error never echoes submitted values.
- Responses carry `Cache-Control: no-store`. The access token is in the JSON body and the refresh token in the existing `HttpOnly` cookie (`Max-Age` 604800 seconds for a new session).
- The client address used by #79 comes from `req.ip`. `TRUST_PROXY_HOPS` (default `0`) sets how many reverse proxies to trust: `0` ignores `X-Forwarded-For`; on Render it should be `1`. A value that is too high lets clients spoof their address and dodge the throttle.

**Why.** CSRF defence and strict input handling follow #55. The proxy setting is required for the IP limits in #79 to be correct behind Render.

**Where it lives.**

- `backend/src/modules/auth/login.routes.ts` (route and cookie)
- `backend/src/modules/auth/login.schemas.ts` (strict body)
- `backend/src/shared/http/origin-guard.ts` (existing `Origin` check, reused)
- `backend/src/app.ts` (`trust proxy` setting, router mount)
- `backend/src/config/env.ts` and `backend/.env.example` (`TRUST_PROXY_HOPS`)
- Tests: `backend/tests/unit/login.http.test.ts`, `backend/tests/unit/env-proxy.test.ts`, `backend/tests/integration/login.integration.test.ts`

**Open.** The right `TRUST_PROXY_HOPS` value on Render is not yet verified on a deployed request. Browser-level cookie, CORS and CSRF behaviour on the real topology (#78) is still untested.

---

## Decision #82 — Ratified implementation choices

**Status:** Approved, provided neither contradicts #51 or #55.

**Rule.**

- **Choice 1 — 401 codes.** `UNAUTHENTICATED` (missing or invalid token, unknown user, bad credentials), `TOKEN_EXPIRED` (so the client knows to refresh) and `ACCOUNT_INACTIVE` (deactivated or unverified). The code is reachable only with a validly signed token, a valid refresh cookie, or a correct password, so it does not enable enumeration.
- **Choice 3 — JWT.** HS256 with the algorithm pinned on verification; the signed payload is empty apart from `sub`, `iat` and `exp`.

**Why.** Both were implementation choices made in the first authentication slice and not separately locked. They are recorded here with their rationale, and they stay within #51 (identity only in the token, authority from the database on every request) and #55 (uniform error body, stable codes).

**Where it lives.**

- `backend/src/shared/errors.ts` (error codes, including `RATE_LIMITED` from #79)
- `backend/src/shared/http/error-handler.ts` (the single place an error becomes a response)
- `backend/src/modules/auth/token.ts` (HS256 pinned, empty payload)
- `backend/src/modules/auth/actor-context.service.ts` (`ACCOUNT_INACTIVE` / `UNAUTHENTICATED` decisions)
- Tests: `backend/tests/unit/token.test.ts`, `backend/tests/unit/http.test.ts`, `backend/tests/unit/actor-context.service.test.ts`, `backend/tests/unit/login.service.test.ts`
