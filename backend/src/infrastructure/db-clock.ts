import type { Tx } from "./transaction";

/** Reads the database's current UTC instant; unlike now(), clock_timestamp() advances within a transaction. */
export async function dbClockNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date | string }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
  const value = rows[0]?.now;
  if (value === undefined) throw new Error("Database clock query returned no result.");
  return toUtcDate(value);
}

/** Interprets zone-less PostgreSQL TIMESTAMP values as UTC, not as the application server's local time. */
export function toUtcDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const hasZone = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/.test(value);
  const parsed = new Date(hasZone ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Database returned an invalid timestamp.");
  return parsed;
}
