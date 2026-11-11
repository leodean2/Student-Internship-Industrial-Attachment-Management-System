import type { Tx } from "../../infrastructure/transaction";
import { isRosterEntryEligible } from "./roster-eligibility";
import type { StudentRosterRepository } from "./student-roster.repository";

export type RosterMatch =
  | { result: "not_found" }
  | {
      result: "found" | "found_ineligible";
      entryId: string;
      importId: string;
      importedAt: Date;
      studentName: string | null;
    };

/** Three-state match, so a later eligibility rule never changes the response shape. */
export class RosterLookup {
  constructor(private readonly repo: Pick<StudentRosterRepository, "findEntryByNumber">) {}

  async match(tx: Tx, normalizedRegistrationNumber: string): Promise<RosterMatch> {
    const entry = await this.repo.findEntryByNumber(tx, normalizedRegistrationNumber);
    if (!entry) return { result: "not_found" };
    return {
      result: isRosterEntryEligible(entry) ? "found" : "found_ineligible",
      entryId: entry.id,
      importId: entry.importId,
      importedAt: entry.importedAt,
      studentName: entry.studentName,
    };
  }
}
