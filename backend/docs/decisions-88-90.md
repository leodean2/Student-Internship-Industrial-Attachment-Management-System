# Decisions 88–90: Admin Bootstrap CLI

## Decision #88 — Session-scoped advisory lock for bootstrap serialisation

**Context:** The bootstrap script runs as a one-shot CLI process. Two operators could
accidentally run it concurrently against the same database, creating duplicate admin rows
before either transaction commits.

**Decision:** Acquire `pg_advisory_lock(hashtext('bootstrap:admin:lock'))` on the direct
connection *before* opening the transaction. Session-scoped (not transaction-scoped) so the
lock is held for the lifetime of the connection, not just the transaction. A second concurrent
process blocks on this call until the first disconnects.

**Alternatives considered:**
- Transaction-scoped `pg_advisory_xact_lock`: released at transaction end, leaving a window
  between the commit and the next process's check. Rejected.
- Application-level file lock: does not protect against processes on different machines.
  Rejected.

**Consequence:** `DATABASE_URL_UNPOOLED` (direct connection) is required. A pooled connection
cannot hold a session-scoped advisory lock reliably across pool hops.

---

## Decision #89 — SERIALIZABLE isolation as defence-in-depth

**Context:** The advisory lock is sufficient to prevent concurrent bootstraps in practice.
However, defence-in-depth is warranted for a one-time, irreversible operation.

**Decision:** Run the bootstrap inserts inside a `SERIALIZABLE` transaction. If two processes
somehow both pass the lock (e.g. different lock servers, or a bug), the serialization failure
on one of them prevents a duplicate admin row from being committed.

**Consequence:** Negligible performance cost for a one-shot CLI operation.

---

## Decision #90 — SYSTEM user (00000000-0000-0000-0000-000000000001) as audit actor

**Context:** `audit_logs.actorUserId` is a non-null FK into `users`. There is no human actor
for a CLI bootstrap operation.

**Decision:** Use the seeded SYSTEM user (`00000000-0000-0000-0000-000000000001`) as
`actorUserId` for the `ADMIN_BOOTSTRAP` audit record. This user is seeded by the initial
migration for exactly this purpose (confirmed by verify-behaviour.sql test #9).

**Audit record shape:**
```
actorUserId = '00000000-0000-0000-0000-000000000001'
action      = 'ADMIN_BOOTSTRAP'
targetType  = 'User'
targetId    = <new admin userId>
metadata    = { email: <normalized email> }
```

**Alternatives considered:**
- Nullable `actorUserId`: requires a schema change and weakens the FK guarantee. Rejected.
- Self-referential (new admin as actor): the admin row does not exist yet at audit-record
  time within the same transaction. Rejected.

**Consequence:** The SYSTEM user row must exist before bootstrap runs. It is guaranteed by
the seed migration and must never be deleted (requirement #11).
