# Attachment System — Backend (authentication foundation)

API process for the Student Internship & Industrial Attachment Management System.
Architecture follows Decisions #49–#56. Implemented so far: **Decision #51's authentication path**, the HTTP
foundation from #50/#55, and **refresh-token sessions** (rotation, reuse detection, logout). No business modules exist yet.

## What is in this slice

| Area | Implemented |
|---|---|
| HTTP foundation | Express 5 app factory, `/api/v1/` prefix, Helmet, strict CORS allow-list, 100 kb JSON limit |
| Request handling | Server-generated `X-Request-Id`, one structured log line per request, **one** error handler producing `{ error: { code, message, requestId } }` |
| Authentication | Bearer token → verified `sub` → `ActorContext` loaded from **current** database state on every request |
| Role guard | `requireRole(...roles)` — coarse, any-of, 403 on mismatch |
| Probe route | `GET /api/v1/auth/me` returns exactly the `ActorContext` the rest of the system will see |
| Refresh sessions | `POST /api/v1/auth/refresh` (rotating, single-use, concurrency-safe) and `POST /api/v1/auth/logout`; `SessionService.startSession` / `revokeAllSessions` primitives for later flows |
| Config | Zod-validated environment, fails fast, never echoes values |

**Deliberately not built yet:** login (nothing issues the first refresh token yet — tests use `startSession` directly),
registration, invitations, password reset, account deactivation, any role-specific business route, any
application/attachment policy, the worker process, email.

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

Requires Node ≥ 20 and PostgreSQL.

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

## Tests

```bash
npm test                          # 98 unit/HTTP tests, no database needed
TEST_DATABASE_URL=postgresql://... npm run test:integration   # 25 tests against a DISPOSABLE database (parallel-refresh races, atomic rollback, session cap)
```

Integration tests need a database that already has the baseline migration **and** `prisma/constraints.sql` applied
(the latter seeds the `SYSTEM` user they assert on). They create and remove their own fixture rows.
`prisma/verification/verify-structure.sql` and `verify-behaviour.sql` check the schema itself (run behaviour only on a scratch DB).

## Verification status — read this

Verified in the build sandbox (Node 22, PostgreSQL 16):
- TypeScript typecheck clean; production build emits `dist/server.js`.
- 98/98 unit and HTTP tests; 25/25 integration tests against real PostgreSQL through Prisma Client, including 6 rounds of 8 simultaneous
  refreshes of one token (exactly one winner each time, no orphan rows), a rollback test for a crash mid-rotation, and database-level tests
  of the 30-day cap, its CHECK constraint and chain inheritance. Time is read from the database clock; tests "travel in time" by backdating stored timestamps.
- Critical behaviours were mutation-checked: removing the single-use guard, the transaction, chain revocation, the grace window or its boundary,
  the Origin check, token hashing, the account-status check, the session cap, cap inheritance, expiry revocation, the cookie Max-Age, the
  CORS wildcard rejection, the database CHECK, or switching back to the process clock each makes at least one test fail. (One breakage initially
  survived — the explicit session-deadline check — and a test for it was added.)
- The compiled build was booted and driven over real HTTP with curl (refresh, replay, logout, `/auth/me`); no token appears in the logs and none is stored unhashed.
- `prisma/verification/verify-structure.sql`: 15/15 checks pass (28 unique indexes, 23 CHECKs, chain-inheritance data check). `verify-behaviour.sql`: 92/92.

**NOT verified — please run locally:**
1. `npx prisma generate` / `migrate dev` with Prisma's own engines. The sandbox blocks Prisma's engine downloads, so tests ran against an
   engine-less client (driver adapter) and against DDL generated from the schema by a script — not Prisma's migration output.
2. `src/server.ts` itself. It calls `new PrismaClient()`; the sandbox client requires an adapter, so I booted the same wiring with an
   adapter-based client instead. Your default-engine client should work without one.
3. The Prisma introspection round-trip (`npx prisma db pull --print`, diff against `schema.prisma`).
4. Other Node versions, and anything deployment-related.

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
