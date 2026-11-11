# Decision log addendum — Decisions #83–#87

*Batch B: Admin invitations and University Supervisor account provisioning. Approved after the login slice.
To be folded into the SRS consolidation pass (the SRS covers Decisions #1–48; #75–#82 are in earlier addenda).*

---

## Decision #83 — Invitation handler remains in `invitation.routes.ts`; no separate controller

**Status:** Approved.

**Rule.** The invitation route handler is a thin handler inside `invitation.routes.ts`. No separate invitation controller file is introduced.

**Why.** The existing pattern for all other routes (auth, session, login) is a thin handler directly in the routes file. The invitation handler delegates all business logic to `InvitationService` and all database work to `InvitationRepository`. There is no logic in the handler that would justify a separate controller layer. Introducing one would add a file and an indirection with no benefit.

**Where it lives.** `backend/src/modules/invitations/invitation.routes.ts`.

---

## Decision #84 — Invitation repositories use parameterized raw SQL for PostgreSQL-specific behavior

**Status:** Approved.

**Rule.** `PrismaInvitationRepository` uses `$queryRaw` / `$executeRaw` (parameterized tagged-template raw SQL) for operations that require PostgreSQL-specific behavior:

- `insert` — uses a CTE with `clock_timestamp() AT TIME ZONE 'UTC'` to derive both `createdAt` and `expiresAt` from one database-clock reading, and `make_interval(days => ...)` for the seven-day offset.
- `findBlocking` — uses `clock_timestamp()` for expiry comparison within the query.
- `findLifecycleForUpdate` — uses `FOR UPDATE` row-level locking, which Prisma's ORM layer does not expose.
- `claim` — conditional `UPDATE ... WHERE ... RETURNING` with all lifecycle guards in one atomic statement.
- `cancel` — conditional `UPDATE ... WHERE ... RETURNING` with all lifecycle guards in one atomic statement.
- `insertUser` — uses `clock_timestamp()` for `createdAt` and `updatedAt` to avoid a second round-trip.
- `insertRole`, `insertUniversitySupervisorProfile` — plain inserts with explicit field lists; raw SQL is used for consistency and to avoid Prisma's `updatedAt` auto-management on tables that have no such column.

Prisma ORM (`findMany`, `count`, `findUnique`) is used where no PostgreSQL-specific behavior is required (listing, counting, single-record retrieval).

**Why.** Prisma's query builder does not expose `FOR UPDATE`, `clock_timestamp()`, or conditional `UPDATE ... RETURNING`. These are required for correctness of the advisory-lock protocol and the race-safe claim/cancel operations.

**Where it lives.** `backend/src/modules/invitations/invitation.repository.ts`.

---

## Decision #85 — Raw inserts supply client-generated fields without database defaults

**Status:** Approved.

**Rule.** Raw `INSERT` statements in `PrismaInvitationRepository` explicitly supply every field that does not have a database default, including `id` (a client-generated UUID) and `updatedAt` where the column exists. They do not rely on Prisma's `@default(uuid())` or `@updatedAt` directives, because those are ORM-layer features that do not apply to raw SQL.

For `insertUser`, both `createdAt` and `updatedAt` are set to the same `clock_timestamp()` value from a CTE, so the new user's timestamps are consistent with the database clock rather than the application server's clock.

**Why.** Raw SQL bypasses Prisma's model layer entirely. Omitting a required column in a raw insert causes a PostgreSQL `NOT NULL` violation at runtime. Explicit field lists make the insert self-documenting and immune to schema changes that add new required columns without defaults.

**Where it lives.** `backend/src/modules/invitations/invitation.repository.ts` (`insertUser`, `insertRole`, `insertUniversitySupervisorProfile`, `insert`).

---

## Decision #86 — Invitation timestamps derive from one database-clock reading after acquiring the advisory lock

**Status:** Approved.

**Rule.** The `insert` repository method uses a single CTE — `WITH t AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now)` — to derive both `createdAt` and `expiresAt` in one SQL statement. This guarantees:

1. Both timestamps come from the same instant.
2. `expiresAt` is exactly `createdAt + 7 days` with no rounding or drift.
3. The clock is read **after** the advisory lock has been acquired (the lock is acquired before `insert` is called), so the expiry is computed against the real wall-clock time at which the invitation was actually created, not the time at which the transaction started.

The `clock_timestamp()` function is used (not `now()` / `CURRENT_TIMESTAMP`) because `now()` is frozen at transaction start and would give a stale reading if the transaction waited for the advisory lock.

**Why.** Using two separate clock readings (one for `createdAt`, one for `expiresAt`) would risk a tiny discrepancy. Using `now()` would give a stale expiry if the transaction queued behind the lock. One CTE with `clock_timestamp()` after lock acquisition is the only approach that satisfies both requirements.

**Column type note.** The `invitations` table uses `TIMESTAMP(3)` (without time zone, matching Prisma's `DateTime` mapping). The expression `clock_timestamp() AT TIME ZONE 'UTC'` produces a `TIMESTAMP WITH TIME ZONE` value; PostgreSQL silently strips the zone when storing it into a `TIMESTAMP` column, which is the intended behavior — the value is always UTC and the zone annotation is redundant. `toUtcDate()` in `db-clock.ts` handles the reverse: it re-attaches the UTC zone when deserializing zone-less strings returned by the driver.

**Where it lives.** `backend/src/modules/invitations/invitation.repository.ts` (`insert`); `backend/src/infrastructure/db-clock.ts` (`toUtcDate`).

---

## Decision #87 — Admin invitation creation uses distinct 409 messages for three conflict cases

**Status:** Approved.

**Rule.** `POST /api/v1/invitations` returns `409 CONFLICT` for three distinct situations, each with a different human-readable message:

| Situation | Message |
|---|---|
| A user account already exists for the email | `"An account already exists for this email address."` |
| A pending (unexpired, uncancelled) invitation exists | `"A pending invitation already exists for this email address."` |
| A previously accepted invitation exists | `"An invitation for this email address has already been accepted."` |

All three share the same HTTP status (`409`) and error code (`CONFLICT`). The distinction is in the message only, so the Admin UI can display a meaningful explanation without the API leaking internal state beyond what the Admin is authorized to see.

The checks are performed in this order — account, then accepted, then pending — after acquiring the advisory lock, so the result is consistent under concurrent requests.

**Why.** A single generic "conflict" message would force the Admin to investigate manually. The three cases require different remediation actions (no action possible; no action possible; cancel and reissue), so distinguishing them in the response is operationally useful. The Admin is already authorized to know the invitation state for any email, so the disclosure is appropriate.

**Where it lives.** `backend/src/modules/invitations/invitation.service.ts` (`create`); `backend/src/modules/invitations/invitation.repository.ts` (`accountExists`, `findBlocking`).
