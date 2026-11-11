/** Provisional rule from the proposed sample. A file with no status column carries no status to judge. */
export const ELIGIBLE_ROSTER_STATUSES: ReadonlySet<string> = new Set(["ACTIVE"]);

export function isRosterEntryEligible(entry: { rosterStatus: string | null }): boolean {
  if (entry.rosterStatus === null) return true;
  return ELIGIBLE_ROSTER_STATUSES.has(entry.rosterStatus.trim().toUpperCase());
}
