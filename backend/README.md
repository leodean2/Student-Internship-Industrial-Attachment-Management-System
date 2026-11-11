# Attachment System — Backend (authentication foundation)

API process for the Student Internship & Industrial Attachment Management System.
Architecture follows Decisions #49–#56. Implemented so far: **Decision #51's authentication path**, the HTTP
foundation from #50/#55, **refresh-token sessions**, and the University Supervisor invitation lifecycle.

## What is in this slice

| Area | Implemented |
|---|---|
| HTTP foundation | Express 5 app factory, `/api/v1/` prefix, Helmet, strict CORS allow-list, 100 kb JSON limit |
| Request handling | Server-generated `X-Request-Id`, one structured log line per request, **one** error handler producing `{ error: { code, message, requestId } }` |
| Authentication | Bearer token → verified `sub` → `ActorContext` loaded from **current** database state on every request |
| Role guard | `requireRole(...roles)` — coarse, any-of, 403 on mismatch |
| Probe route | `GET /api/v1/auth/me` returns exactly the `ActorContext` the rest of the system will see |
| Refresh sessions | `POST /api/v1/auth/refresh` (rotating, single-use, concurrency-safe) and `POST /api/v1/auth/logout`; `SessionService.startSession` / `revokeAllSessions` primitives for later flows |
| Login | `POST /api/v1/auth/login`; bcrypt verification, indistinguishable credential failures, and in-memory IP/email throttling |
| Invitations | Admin create/cancel/list/retrieve plus public accept; one-use opaque tokens, transactional account provisioning, lifecycle audit, safe status-derived pagination, seven-day expiry |
| Student registration | Transactional student account provisioning, one-use email verification, and audit events |
| Student registration cleanup | Externally scheduled one-shot cleanup for expired unverified and rejected student registrations |
| Registration reviewers | Admin-managed, department-scoped university-supervisor assignments with audited soft revocation |
| Student roster | Admin-only CSV preview/import, immutable additive roster entries, import history, and lookup for registration confirmation |
| Outbox worker | Separate worker entry point, lease renewal, retries, graceful shutdown, invitation and verification email templates |
| Config | Zod-validated environment, fails fast, never echoes values |

Login limits failed attempts to 10 per IP/email pair, 50 per IP, and 30 per normalized email across IPs in a
15-minute window. The global email limit can temporarily block the account owner if an attacker distributes enough
attempts across addresses. The throttle is in-memory and resets on process restart; it is not shared across API
instances.

Invitation creation enqueues a templated email but does not send it; delivery is left to the outbox worker. The raw
invitation token is carried only in the acceptance URL in the outbox payload. Set `APP_BASE_URL` to the frontend origin;
it defaults to `http://localhost:5173` outside production and is required to use HTTPS in production. The acceptance
frontend route still needs to be available before deploying the Resend worker. Acceptance requires
an allow-listed `Origin`, hashes the password before opening a transaction, serializes on the normalized invitation
email, and atomically claims the invitation while creating an ACTIVE user, University Supervisor role/profile, and
audit event. It does not create a login session. Unknown, expired, cancelled, and already-accepted tokens all return
the same 404 response so acceptance does not disclose token state. Failed unusable-token guesses are limited to 10
attempts per IP per 15-minute window. Admin cancellation returns state-specific 409 responses for known
accepted/cancelled/expired invitations. Acceptance and cancellation serialize on the same
normalized-email transaction lock and use conditional database-clock state changes.

Student registration is available at `POST /api/v1/auth/register`; it creates a `PENDING_VERIFICATION` student and
enqueues a 24-hour email verification link in the same transaction. `POST /api/v1/auth/verify-email` records
`emailVerifiedAt` and spends the token but deliberately does **not** activate the account. Activation awaits a later
authorized registration-number confirmation. Both endpoints require an allow-listed `Origin`, and verification
failures are limited per IP by `EMAIL_VERIFY_FAILED_ATTEMPT_LIMIT` and `EMAIL_VERIFY_WINDOW_MS`.

Admins can list invitations with `GET /api/v1/invitations?page=1&limit=20&status=PENDING&email=person%40example.com`
and retrieve one with `GET /api/v1/invitations/:id`. The optional email filter is normalized and exact-match.
Pagination reports `page`, `limit`, `total`, and `totalPages`. Status is derived in the order ACCEPTED, CANCELLED, EXPIRED, PENDING, using
the database clock. Responses exclude the token hash and accepted-user ID. Listing sorts by `createdAt DESC, id DESC`
and returns matching `data` and `pagination` metadata.

Admin reviewer endpoints are:

- `POST /api/v1/admin/registration-reviewers` to grant an assignment.
- `GET /api/v1/admin/registration-reviewers` to list assignments.
- `DELETE /api/v1/admin/registration-reviewers/:id` to revoke an assignment while retaining audit history.

Assignments are scoped by normalized department code. Registration-decision services must call
`RegistrationReviewPolicy` inside their transaction so a concurrent revocation waits until the decision completes.

Admins import student rosters at `POST /api/v1/admin/student-roster/imports`; `text/csv` is required and `dryRun`
defaults to `true`. Use `?dryRun=false` to commit. Header aliases and the provisional registration-number format are
defined in the roster parser and shared registration-number helper. Imports are additive: they never overwrite
entries, report exact repeats as skipped and differing rows as conflicts, and store only a hash/count summary in
import history and audit metadata. `GET /api/v1/admin/student-roster/imports` lists history and
`GET /api/v1/admin/student-roster/imports/:id` retrieves one summary.

Assigned registration reviewers use `/api/v1/registration-reviews` to list and inspect department-scoped registrations,
confirm or reject pending claims, and correct pending or rejected registration numbers. Confirmation requires a
verified email and an eligible roster match; correction never confirms or activates an account. Reviewer assignments
are checked and locked inside each service transaction, including for admins.

**Deliberately not built yet:** verification-link resend, password reset, account deactivation, and
application/attachment policies.

## Request flow

```
request ─▶ requestContext (id + logger) ─▶ requestLogger ─▶ helmet ─▶ cors ─▶ json
        ─▶ authenticate  : Bearer token → verify (HS256 pinned, exp) → userId
                           → ActorContextService.load(userId) → req.actor
        ─▶ requireRole   : coarse role check (403)
        ─▶ controller / service (later slices: policies live in services, #50)
        ─▶ errorHandler  : the only place an error becomes an HTTP response
```

The token proves **identity only** (`sub`, `iat`, `exp`). Roles, status and profiles always come from PostgreSQL, so a
role removal or deactivation applies on the very next request even though the old token is still unexpired.

## Refresh-token sessions (Decisions #51 / #52 / #55, #75–#78 — see `decisions-75-78.md`)

- The refresh token is 256 random bits; **only its SHA-256 hash is stored**. It travels in an `httpOnly` cookie
  (`refresh_token`, `Path=/api/v1/auth`, `Secure` in production, `SameSite` from `REFRESH_COOKIE_SAMESITE`, default `strict`).
  The access token is returned in the JSON body and held in memory by the SPA. The cookie's `Max-Age` is that token's remaining life.
- **One clock (#76):** every comparison and stored timestamp uses the **database** clock (`repo.now(tx)`), never the API process's, so
  instances with skewed clocks cannot disagree about whether a token was "just rotated". The grace window is measured from the recorded rotation time.
- **Absolute lifetime (#77):** a session ends 30 days after it starts. `sessionExpiresAt` is fixed at start, copied unchanged by every
  rotation, and each token expires at `min(now + 7 days, sessionExpiresAt)` (enforced by `CHECK expiresAt <= sessionExpiresAt`). The 7-day
  per-token lifetime doubles as the idle limit. An expired token is refused and ends its session.
- **Single use, atomic:** one transaction inserts the successor, then conditionally updates the old row
  (`WHERE revokedAt IS NULL AND expiresAt > now`). Under READ COMMITTED a concurrent rotation of the same row blocks, re-evaluates, matches
  nothing, and rolls its own insert back — so exactly one request wins and no orphan token is left behind.
- **Reuse policy (explicit):**

  | Presented token | Result | Side effect |
  |---|---|---|
  | rotated ≤ 10 s ago (two tabs, retry) | `409 CONFLICT` | none; cookie is **not** cleared (it could delete the winner's new one). Can never succeed. |
  | rotated > 10 s ago (possible theft) | `401` | rest of that rotation chain revoked, warning logged; the user's other devices are untouched |
  | revoked by logout / reset / deactivation | `401` | none |
  | unknown or expired | `401` | none for unknown; an expired token's session is ended. All `401`s look identical |
  | valid, but account deactivated / unverified | `401 ACCOUNT_INACTIVE` | token not rotated |

- **Logout** ends the session the presented token belongs to (that token and everything after it in its chain), so logging out from a
  second tab with a just-rotated token still ends the live session. Always `204`.
- Both endpoints are POST-only and **require an allow-listed `Origin` header** (a missing one is rejected) — the CSRF defence from #55.

### Deployment: the SPA and API must be the same *site* (Decision #78)

`SameSite` is about the **site** (registrable domain), not the hostname: `app.<domain>` and `api.<domain>` are same-site (different
origins). The SPA on `*.vercel.app` and the API on `*.onrender.com` are different sites, so the refresh cookie would be third-party —
`Strict`/`Lax` cookies are not sent on the SPA's `fetch`, and `SameSite=None` is increasingly blocked. For production use a custom
domain with both under it and keep `SameSite=Strict`. Do not reach for `SameSite=None` just because the hosts differ; validate real
browser behaviour on the intended topology first. CORS lists explicit origins with credentials — a `*` origin is rejected at startup.
The `Origin` check applies identically to `/refresh` and `/logout`. **Browser-level cookie/CORS/CSRF tests on the real topology are still to be run.**

## Setup

Requires Node ≥ 22.12 and PostgreSQL.

```bash
npm install
cp .env.example .env              # set DATABASE_URL, DATABASE_URL_UNPOOLED, and a real JWT_ACCESS_SECRET (>= 32 chars)
npx prisma generate

# 1) baseline migration from schema.prisma (Neon app traffic uses pooled DATABASE_URL;
#    Prisma Migrate uses direct DATABASE_URL_UNPOOLED)
npx prisma migrate dev --name init

# 2) supplemental constraints (partial unique indexes, CHECKs, singleton + SYSTEM seed)
npx prisma migrate dev --create-only --name constraints
#    paste the contents of prisma/constraints.sql into the new migration.sql, then:
npx prisma migrate dev

npm run dev                       # http://localhost:4000/api/v1/health
```

### Local outbox worker

Run the worker separately from the API with `npm run dev:worker` (or `npm run start:worker` after `npm run build`).
The local `EMAIL_PROVIDER=log` sink suppresses delivery but resolves successfully, so claimed rows are persisted as
`SENT`. Run it only against a local database whose outbox rows you are willing to consume; do not point it at a
shared/Neon branch. `log` is rejected in production. The Resend adapter is implemented, but worker startup refuses
Resend can render invitation-created messages. Missing templates are permanent failures.

### Student registration cleanup

The registration cleanup is a one-shot command; it does not run inside the API or email-worker loop.
Build the backend, then invoke `npm run cleanup:student-registrations` from an external scheduler.
The default invocation is a dry run: it logs the number of eligible candidates in the next batch
(at most 100) and makes no changes. Review those counts before scheduling execution; use
`npm run cleanup:student-registrations -- --execute` to delete eligible records. Each execution
processes at most 100 eligible registrations using the database clock and a fixed,
inclusive 14-day retention period. It records a `student-registration-cleanup` row in `job_runs`.
Unverified registrations must still be email-unverified and pending registration review; verified
students awaiting review and ACTIVE accounts are retained. Rejected registrations use
`registrationDecidedAt` as their retention timestamp. Audit records are retained and attributed to the
seeded SYSTEM actor while their prior actor ID is preserved in metadata. Related tokens are removed,
all related outbox rows are deleted under row locks so an active worker claim is not raced, and
recipient notifications are removed without touching other users' notifications.

## Tests

```bash
npm test                          # 273 expected unit/HTTP tests, no database needed
TEST_DATABASE_URL=postgresql://... npm run test:integration   # PostgreSQL integration tests against a DISPOSABLE database
```

The outbox repository, worker, and invitation-enqueue PostgreSQL suites are additionally opt-in: set
`RUN_EMAIL_OUTBOX_INTEGRATION=true` and `OUTBOX_TEST_DB_DISPOSABLE=true` alongside `TEST_DATABASE_URL`. They refuse
to run against `NEON_BRANCH=production`, require the database name `test_db`, and require an empty outbox before
starting. The worker suite deletes only its uniquely prefixed fixtures and job runs it created. Do not run these
suites in parallel against the same database.

Integration tests need a disposable database with all migrations applied, including
`20261106090000_provisioning_limits`, `20261109050133_user_email_verified_at`, and
`20261109123000_registration_reviewers`, and `prisma/constraints.sql` applied (the latter seeds the `SYSTEM` user some
tests assert on). Leave `TEST_DB_DRIVER` unset to use Prisma Client over the PostgreSQL adapter. The B-4/B-5 lifecycle
tests are opt-in with `RUN_INVITATION_MANAGEMENT_INTEGRATION=true` and refuse to run when `NEON_BRANCH=production`.
Student registration cleanup PostgreSQL tests are opt-in with
`RUN_STUDENT_REGISTRATION_CLEANUP_INTEGRATION=true` and `OUTBOX_TEST_DB_DISPOSABLE=true`; they use a unique fixture
prefix and refuse to run outside `test_db` or on `NEON_BRANCH=production`.
The suite contains 23 invitation-creation, 5 acceptance, and 3 lifecycle-management integration cases (62 total
expected); it includes acceptance/cancellation lock-wait races, database-clock, rollback, reissue-policy,
single-claim concurrency, and two-connection-pool checks. It creates and removes its own fixture rows. Never point
integration tests at production.

For a verified PostgreSQL run, set `NEON_BRANCH=test` and
`OUTBOX_TEST_DB_DISPOSABLE=true`, then run `npm run test:integration:verified`. It loads `.env`, requires a direct
`TEST_DATABASE_URL` for `test_db`, enables the opt-in suites, and fails if any test fails, is skipped, or is marked
todo. To split long verification runs into batches, pass Vitest file filters after `--`, for example:
`npm run test:integration:verified -- tests/integration/password-reset.integration.test.ts`.
`prisma/verification/verify-structure.sql` and `verify-behaviour.sql` check the schema itself (run behaviour only on a scratch DB).

## Render deployment

For a Render service whose root directory is `backend`, use this Build Command:

```bash
npm ci --include=dev && npm run build
```

The build script generates the Prisma client before compiling. Set the Start Command to `npm start`, and configure
`NODE_ENV=production` and `TRUST_PROXY_HOPS=1` for the Render proxy topology.
Do not create a Render worker service yet. With no registered templates the Resend worker refuses to start, and
production log mode is rejected.

## Verification status — read this

For Delivery 1, the full suite passed 240/240 unit/HTTP tests and 54/54 PostgreSQL integration tests. The final-tree
structure verification passed 15/15 (27 CHECK constraints), behavior verification passed 94/94 on `verify_db`, and
the Prisma schema diff was empty after dropping `_results`.

After adding invitation acceptance, `npm run typecheck` and `npm run build` passed; the full unit suite passed 256/256,
and the full PostgreSQL integration suite passed 58/58 (382.76 seconds). For B-4/B-5, the full unit suite passed
273/273, and the initial targeted PostgreSQL run passed 3 lifecycle-management, 4 acceptance, and 23
invitation-creation cases. Later additions require a fresh verification run. Prisma reported all migrations applied
and an empty schema diff against the test database before the latest acceptance response-policy correction.

Versions tested: Express 5, TypeScript 5.9 (TypeScript 7 removed the `Node` module-resolution mode this CommonJS setup uses, so it is pinned),
Prisma/@prisma/client 6.19, Vitest 5, Zod 4, pino 10.

## Implementation choices in this slice (not separately locked — veto any)

1. **401 codes:** `UNAUTHENTICATED` (missing/invalid token, unknown user), `TOKEN_EXPIRED` (so the client knows to refresh), `ACCOUNT_INACTIVE` (deactivated or unverified).
2. **Zero-role users are rejected as `UNAUTHENTICATED`.** Every real user holds ≥ 1 role (#62), so this rejects the `SYSTEM` sentinel structurally (#69), without hard-coding its id, and indistinguishably from an unknown user.
3. **JWT:** HS256 with the algorithm pinned on verify; the signed payload is empty apart from `sub`/`iat`/`exp`.
4. **`GET /api/v1/auth/me`** exists as an identity probe; it is not part of the locked API surface.
5. **Request ids are always server-generated**; a client-supplied id is ignored.
6. **Log fields:** `requestId, method, path (query string stripped), status, durationMs, userId, roles, errorCode`. Bodies and headers are never logged; credential fields are redacted.
7. **`ActorContext`** keeps `status` (from the #51 sketch) although only `ACTIVE` users ever get one.
8. Helmet, the CORS allow-list and request logging were added now because they are cheap and #55 already specifies them.

Approved since (see `decisions-75-78.md`): the reuse policy and its 10-second grace window (#76), the unique `tokenHash` (#75), the 30-day
absolute session cap (#77) and the deployment/cookie topology (#78). Their implementation details:

9. **Lost race and recent replay are `409`** (matches #55's "409 for lost conditional-write races"); every other failure is a uniform `401`. The cookie is cleared on `401`, never on `409`.
10. **`Origin` is required** on `/refresh` and `/logout`; a missing header is rejected.
11. **Cookie:** name `refresh_token`, `Path=/api/v1/auth`, no `__Host-` prefix (it requires `Path=/`, which would send the cookie with every request).
12. **Refresh checks account status before rotating** (via `ActorContextService`), so a deactivated user cannot mint new access tokens even if their tokens were not revoked.
13. **Logout ends the presented token's whole chain**, not just that token.
14. **The session cap is stored per token row** (`sessionExpiresAt`), not in a separate session table — the simpler V1 option you approved. "Same value across a chain" is an application rule, checked as data by `verify-structure.sql`.
15. **A wildcard `CORS_ORIGIN` is rejected at startup** (credentialed requests).

**Still open:** no idle limit beyond the 7-day token lifetime (which already acts as one); a dedicated session table remains the cleaner long-term model.
