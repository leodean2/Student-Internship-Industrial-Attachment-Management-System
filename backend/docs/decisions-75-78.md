# Decision log addendum — Decisions #75–#78

*Refresh-token sessions and production topology. Approved after the first two backend implementation slices.
To be folded into the SRS consolidation pass (the SRS currently covers Decisions #1–48).*

> **Numbering.** The approvals were first labelled #74–#77, but **#74 was already taken** by the four integrity constraints added
> during Prisma translation. They are recorded here as follows:
>
> | Approved as | Recorded as | Subject |
> |---|---|---|
> | #74 | **#76** | Refresh-token reuse policy |
> | #75 | **#75** | `refresh_tokens.tokenHash` unique |
> | #76 | **#77** | Absolute session lifetime |
> | #77 | **#78** | Production deployment and cookie topology |

---

## Decision #75 — `refresh_tokens.tokenHash` is UNIQUE

**Status:** Approved.

**Rule.** `RefreshToken.tokenHash` carries a unique constraint (an index, hence also fast lookup).

**Why.** Every refresh finds its row by the hash of the presented token; the lookup must return exactly one record. The database, not
application code alone, enforces that. Decision #71 listed the other token tables (`PasswordResetToken`, `EmailVerificationToken`,
`Invitation`) but omitted this one.

**Where it lives.** `schema.prisma` (`@unique`), `data-model.md` §1, `verify-structure.sql` (28 ordinary unique indexes). Because the
table is created *with* the constraint by the baseline migration, there is no separate migration and no existing data to convert.

**Pre-flight for anyone who already applied an earlier baseline** (must return no rows):

```sql
SELECT "tokenHash", count(*) FROM refresh_tokens GROUP BY 1 HAVING count(*) > 1;
```

Nothing issues refresh tokens yet (login is not built), so the table should also be empty.

---

## Decision #76 — Refresh-token reuse policy

**Status:** Approved, with one clarification (below).

| Presented token | Result | Side effect |
|---|---|---|
| Rotated **≤ 10 s** ago | `409 CONFLICT` | None. The session and the user's other devices are untouched. The cookie is **not** cleared. |
| Rotated **> 10 s** ago | `401` | Possible theft: the rest of that rotation chain (the live session) is revoked and a warning is logged. Other devices are untouched. |
| Revoked by logout / password reset / deactivation | `401` | None |
| Unknown or expired | `401` | None (an expired token also ends its session — see #77). All `401`s look identical. |
| Valid, but the account is deactivated or unverified | `401 ACCOUNT_INACTIVE` | The token is not rotated |

**Logout** revokes the whole relevant chain — the presented token and everything after it — including when the presented token was
rotated moments ago (for example from a second tab). It always returns `204`.

**Clarification (approved).** The grace window is measured from the **recorded rotation time using one consistent server-side clock**,
and the implementation must make it impossible for the old token to refresh successfully a second time during the window.

- *Clock.* Every session decision reads the **database** clock (`repo.now(tx)`, i.e. PostgreSQL `now()`, fixed per transaction). Rotation
  times are written with it and the window is compared against it, so API instances with skewed clocks cannot disagree. The API process's
  own clock is never used.
- *Cannot succeed twice.* A rotated token's row is revoked in the same transaction that creates its successor, and the only code path
  that issues tokens requires `revokedAt IS NULL` (a conditional `UPDATE`). Inside the window the code path returns `409` and writes
  nothing.
- *Boundary.* Inclusive at exactly 10 s, strict after it.

**Verification.** Unit and integration tests replay a rotated token 5–10 times inside the window (always `409`, no new rows), prove the
window is measured from rotation time rather than issue time, and run 6 rounds of 8 simultaneous refreshes of one token against real
PostgreSQL (exactly one winner, no orphan rows). Re-introducing the process clock fails 25 tests.

---

## Decision #77 — Absolute session lifetime

**Status:** Approved.

**Rule.** A session ends **30 days after it starts**, however often its refresh token rotates.

- `refresh_tokens.sessionExpiresAt` (NOT NULL) is fixed when the session starts and **copied unchanged** by every rotation. It is never reset.
- Each token expires at `min(now + 7 days, sessionExpiresAt)`. The cookie's `Max-Age` is that token's remaining life, so it shrinks near the cap.
- `CHECK (expiresAt <= sessionExpiresAt)` — a token can never outlive its session (same-row, enforced by the database).
- **Expiry:** an expired token is refused and its chain is revoked; the user must log in again. Other devices are independent sessions
  with their own deadlines.
- **Idle limit — no extra mechanism.** Every rotation issues a fresh 7-day token, and rotation is the only way to extend a session, so the
  per-token lifetime already *is* a 7-day idle limit. Deferring a separate idle limit, as agreed, loses nothing.

**Why a column on each token row rather than a session table.** A dedicated session record is the cleaner long-term model but adds scope.
For V1 the value rides on every token, and the rule "every token in a chain carries the same value" is a **cross-row invariant**, so it
is enforced by the application and checked as data by `verify-structure.sql` (it returns the number of chains whose successor differs;
it must be 0). It cannot be a `CHECK`.

**Migration note.** `sessionExpiresAt` is a new required column. The baseline migration creates it, so a fresh database needs nothing. If
an earlier baseline was already applied *and* contains refresh-token rows, add the column nullable, backfill, then set NOT NULL:

```sql
ALTER TABLE refresh_tokens ADD COLUMN "sessionExpiresAt" TIMESTAMP(3);
UPDATE refresh_tokens SET "sessionExpiresAt" = GREATEST("issuedAt" + interval '30 days', "expiresAt");
ALTER TABLE refresh_tokens ALTER COLUMN "sessionExpiresAt" SET NOT NULL;
-- then apply prisma/constraints.sql's ck_refresh_token_within_session
```

---

## Decision #78 — Production deployment and cookie topology (amends #56)

**Status:** Approved.

**The facts.** `SameSite` is about the *site* (registrable domain), not the hostname or origin. Two HTTPS subdomains of one registrable
domain are same-site (though different origins). The SPA on `*.vercel.app` and the API on `*.onrender.com` are different sites, so the
refresh cookie would be third-party: `Strict`/`Lax` cookies are not sent on the SPA's `fetch`, and `SameSite=None` cookies are
increasingly blocked by browsers.

**Recommended production topology.**

| Piece | Setting |
|---|---|
| Frontend | `https://app.<domain>` |
| API | `https://api.<domain>` (same registrable domain → same-site) |
| Refresh cookie | `HttpOnly`, `Secure`, narrow `Path=/api/v1/auth`, `SameSite` from `REFRESH_COOKIE_SAMESITE` (default `strict`) |
| CORS | Explicit frontend origin(s) and credentials. **Never a wildcard** with credentialed requests — configuration validation rejects `*` at startup. |
| CSRF | The agreed `Origin` check, applied identically to `/refresh` and `/logout` |

`SameSite=None` is **not** automatically required just because the hosts differ. The cookie policy must be chosen only after the real
browser behaviour on the intended topology has been validated.

**Open.** Browser-based cookie, CORS and CSRF tests against the intended deployment topology have not been run (the sandbox has no browser or
deployed topology).

---

## Still open after these decisions

1. Prisma's own `generate` / `migrate dev` (engine downloads were blocked where this was built), and the `db pull` round-trip.
2. `src/server.ts` booted with the default-engine `new PrismaClient()`.
3. Real-PostgreSQL integration tests re-run on your machine against the **final** schema (it changed again with `sessionExpiresAt`).
4. Browser-based cookie / CORS / CSRF tests on the real topology (#78).
