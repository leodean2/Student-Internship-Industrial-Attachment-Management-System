import { parse } from "csv-parse/sync";
import {
  departmentCodeOf,
  isValidRegistrationNumber,
  normalizeRegistrationNumber,
} from "../../shared/registration-number";
import { ROSTER_COLUMN_ALIASES, mapHeaders, type RosterField } from "./roster-columns";

export const MAX_ROSTER_ROWS = 20_000;
const MAX_NAME_LENGTH = 200;
const MAX_STATUS_LENGTH = 50;

export type RosterFileErrorCode =
  | "empty_file"
  | "malformed_csv"
  | "missing_columns"
  | "ambiguous_columns"
  | "too_many_rows";

export class RosterFileError extends Error {
  constructor(
    readonly code: RosterFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RosterFileError";
  }
}

/** `row` is the 1-based data row number, not counting the header. */
export interface RowProblem {
  row: number;
  reason: string;
}

export interface RosterCandidate {
  row: number;
  registrationNumber: string;
  departmentCode: string;
  studentName: string | null;
  rosterStatus: string | null;
}

export interface ParsedRoster {
  totalRows: number;
  invalid: RowProblem[];
  duplicates: RowProblem[];
  candidates: RosterCandidate[];
}

const canonicalName = (field: RosterField): string => ROSTER_COLUMN_ALIASES[field][0];

/**
 * Every data row ends up in exactly one bucket: invalid, duplicate (every row of a repeated number), or candidate.
 * A duplicated number is rejected in full, never "first one wins".
 */
export function parseRosterCsv(text: string): ParsedRoster {
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];
  } catch {
    throw new RosterFileError("malformed_csv", "The file is not valid CSV.");
  }

  const [header, ...rows] = records;
  if (!header || header.length === 0) throw new RosterFileError("empty_file", "The file has no header row.");
  const { indexes, missingRequired, ambiguous } = mapHeaders(header);
  if (ambiguous.length > 0) {
    throw new RosterFileError(
      "ambiguous_columns",
      `More than one column matches: ${ambiguous.map(canonicalName).join(", ")}.`,
    );
  }
  if (missingRequired.length > 0) {
    throw new RosterFileError(
      "missing_columns",
      `Missing required column: ${missingRequired.map(canonicalName).join(", ")}.`,
    );
  }
  if (rows.length === 0) throw new RosterFileError("empty_file", "The file has no data rows.");
  if (rows.length > MAX_ROSTER_ROWS) {
    throw new RosterFileError("too_many_rows", `The file has more than ${MAX_ROSTER_ROWS} rows.`);
  }

  const invalid: RowProblem[] = [];
  const byNumber = new Map<string, RosterCandidate[]>();

  rows.forEach((cells, index) => {
    const row = index + 1;
    const reject = (reason: string): void => {
      invalid.push({ row, reason });
    };
    if (cells.length !== header.length) return reject("wrong_column_count");

    const cell = (field: RosterField): string | undefined => {
      const position = indexes[field];
      return position === undefined ? undefined : (cells[position] ?? "");
    };

    const rawNumber = cell("registrationNumber") ?? "";
    if (rawNumber === "") return reject("missing_registration_number");
    const registrationNumber = normalizeRegistrationNumber(rawNumber);
    if (!isValidRegistrationNumber(registrationNumber)) return reject("invalid_registration_number");

    const name = cell("studentName");
    if (name !== undefined && name.length > MAX_NAME_LENGTH) return reject("student_name_too_long");
    const status = cell("status");
    if (status !== undefined) {
      if (status === "") return reject("missing_student_status");
      if (status.length > MAX_STATUS_LENGTH) return reject("student_status_too_long");
    }

    const candidate: RosterCandidate = {
      row,
      registrationNumber,
      departmentCode: departmentCodeOf(registrationNumber),
      studentName: name === undefined || name === "" ? null : name,
      rosterStatus: status ?? null,
    };
    const group = byNumber.get(registrationNumber);
    if (group) group.push(candidate);
    else byNumber.set(registrationNumber, [candidate]);
  });

  const duplicates: RowProblem[] = [];
  const candidates: RosterCandidate[] = [];
  for (const group of byNumber.values()) {
    if (group.length > 1) group.forEach(({ row }) => duplicates.push({ row, reason: "duplicate_in_file" }));
    else candidates.push(group[0]!);
  }
  duplicates.sort((a, b) => a.row - b.row);
  candidates.sort((a, b) => a.row - b.row);
  return { totalRows: rows.length, invalid, duplicates, candidates };
}
