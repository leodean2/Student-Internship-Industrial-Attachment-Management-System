import { createHash } from "node:crypto";
import type { ActorContext } from "../auth/actor-context";
import { hasRole } from "../auth/actor-context";
import type { AuditRepository } from "../audit/audit.repository";
import { acquireTransactionLock } from "../../infrastructure/advisory-lock";
import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { Errors } from "../../shared/errors";
import { RosterFileError, parseRosterCsv, type RowProblem } from "./roster-parser";
import type { RosterImportRecord, StudentRosterRepository } from "./student-roster.repository";
import type { ListImportsQuery } from "./student-roster.validation";

const IMPORT_LOCK_KEY = "student-roster-import";
const MAX_REPORTED_DETAILS = 200;

export interface RosterImportReport {
  dryRun: boolean;
  importId: string | null;
  fileSha256: string;
  counts: { rows: number; inserted: number; skipped: number; conflicts: number; invalid: number; duplicates: number };
  invalid: RowProblem[];
  duplicates: RowProblem[];
  conflicts: { row: number; fields: string[] }[];
  detailsTruncated: boolean;
}

export interface StudentRosterServiceDeps {
  repo: StudentRosterRepository;
  audit: Pick<AuditRepository, "record">;
  runTx: TxRunner;
  acquireLock?: (tx: Tx, key: string) => Promise<void>;
}

export class StudentRosterService {
  private readonly acquireLock: (tx: Tx, key: string) => Promise<void>;

  constructor(private readonly deps: StudentRosterServiceDeps) {
    this.acquireLock = deps.acquireLock ?? acquireTransactionLock;
  }

  async importCsv(actor: ActorContext, csvText: string, options: { dryRun: boolean }): Promise<RosterImportReport> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();

    let parsed;
    try {
      parsed = parseRosterCsv(csvText);
    } catch (error) {
      if (error instanceof RosterFileError) throw Errors.validation([{ path: "file", message: error.message }]);
      throw error;
    }
    const fileSha256 = createHash("sha256").update(csvText).digest("hex");
    const { repo, audit, runTx } = this.deps;

    return runTx(async (tx) => {
      if (!options.dryRun) await this.acquireLock(tx, IMPORT_LOCK_KEY);

      const existing = new Map(
        (await repo.findEntriesByNumbers(tx, parsed.candidates.map((candidate) => candidate.registrationNumber))).map(
          (entry) => [entry.registrationNumber, entry],
        ),
      );

      const toInsert = [];
      const conflicts: { row: number; fields: string[] }[] = [];
      let skipped = 0;
      for (const candidate of parsed.candidates) {
        const current = existing.get(candidate.registrationNumber);
        if (!current) {
          toInsert.push(candidate);
          continue;
        }
        const fields: string[] = [];
        if (current.studentName !== candidate.studentName) fields.push("student_name");
        if (current.rosterStatus !== candidate.rosterStatus) fields.push("student_status");
        if (fields.length > 0) conflicts.push({ row: candidate.row, fields });
        else skipped += 1;
      }

      const counts = {
        rows: parsed.totalRows,
        inserted: toInsert.length,
        skipped,
        conflicts: conflicts.length,
        invalid: parsed.invalid.length,
        duplicates: parsed.duplicates.length,
      };
      const detailsTruncated =
        parsed.invalid.length > MAX_REPORTED_DETAILS ||
        parsed.duplicates.length > MAX_REPORTED_DETAILS ||
        conflicts.length > MAX_REPORTED_DETAILS;
      const report: RosterImportReport = {
        dryRun: options.dryRun,
        importId: null,
        fileSha256,
        counts,
        invalid: parsed.invalid.slice(0, MAX_REPORTED_DETAILS),
        duplicates: parsed.duplicates.slice(0, MAX_REPORTED_DETAILS),
        conflicts: conflicts.slice(0, MAX_REPORTED_DETAILS),
        detailsTruncated,
      };
      if (options.dryRun) return report;

      const record = await repo.createImport(tx, {
        importedByUserId: actor.userId,
        fileSha256,
        rowCount: counts.rows,
        insertedCount: counts.inserted,
        skippedCount: counts.skipped,
        conflictCount: counts.conflicts,
        invalidCount: counts.invalid,
        duplicateCount: counts.duplicates,
      });
      await repo.insertEntries(
        tx,
        record.id,
        toInsert.map(({ registrationNumber, departmentCode, studentName, rosterStatus }) => ({
          registrationNumber,
          departmentCode,
          studentName,
          rosterStatus,
        })),
      );
      await audit.record(tx, {
        actorUserId: actor.userId,
        action: "STUDENT_ROSTER_IMPORTED",
        targetType: "StudentRosterImport",
        targetId: record.id,
        metadata: { fileSha256, ...counts },
      });
      return { ...report, importId: record.id };
    });
  }

  async listImports(actor: ActorContext, query: ListImportsQuery): Promise<RosterImportRecord[]> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();
    return this.deps.runTx((tx) => this.deps.repo.listImports(tx, { ...query, limit: query.limit + 1 }));
  }

  async getImport(actor: ActorContext, id: string): Promise<RosterImportRecord> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();
    const record = await this.deps.runTx((tx) => this.deps.repo.findImport(tx, id));
    if (!record) throw Errors.notFound("Roster import not found.");
    return record;
  }
}
