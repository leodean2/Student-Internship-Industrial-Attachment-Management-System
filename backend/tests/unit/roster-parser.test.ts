import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRosterEntryEligible } from "../../src/modules/student-roster/roster-eligibility";
import {
  MAX_ROSTER_ROWS,
  RosterFileError,
  parseRosterCsv,
} from "../../src/modules/student-roster/roster-parser";

const FIXTURE = readFileSync("tests/fixtures/student_roster_sample.csv", "utf8");
const errorCode = (text: string): string | undefined => {
  try {
    parseRosterCsv(text);
  } catch (error) {
    return error instanceof RosterFileError ? error.code : "other";
  }
  return undefined;
};

describe("parseRosterCsv", () => {
  it("accepts the version-one fixture and ignores unneeded columns", () => {
    const parsed = parseRosterCsv(FIXTURE);
    expect(parsed).toMatchObject({ totalRows: 10, invalid: [], duplicates: [] });
    expect(parsed.candidates).toHaveLength(10);
    expect(parsed.candidates[0]).toEqual({
      row: 1,
      registrationNumber: "CIT-221-001/2024",
      departmentCode: "CIT",
      studentName: "STUDENT_001",
      rosterStatus: "ACTIVE",
    });
  });

  it("maps header aliases, a BOM, and surrounding whitespace", () => {
    const parsed = parseRosterCsv("\uFEFFReg No , Full Name\r\nCIT-221-001/2024, A Student\r\n");
    expect(parsed.candidates).toEqual([
      {
        row: 1,
        registrationNumber: "CIT-221-001/2024",
        departmentCode: "CIT",
        studentName: "A Student",
        rosterStatus: null,
      },
    ]);
  });

  it("normalizes registration numbers and keeps them strings", () => {
    expect(parseRosterCsv("registration_number\n cit-221-001/2024 \n").candidates[0]!.registrationNumber).toBe(
      "CIT-221-001/2024",
    );
  });

  it("rejects whole files with missing or ambiguous headers and malformed or oversized data", () => {
    expect(errorCode("student_name\nA\n")).toBe("missing_columns");
    expect(errorCode("registration_number,reg_no\nCIT-221-001/2024,x\n")).toBe("ambiguous_columns");
    expect(errorCode("")).toBe("empty_file");
    expect(errorCode("registration_number\n")).toBe("empty_file");
    expect(errorCode('registration_number\n"unterminated\n')).toBe("malformed_csv");
    const tooManyRows =
      "registration_number\n" + Array.from({ length: MAX_ROSTER_ROWS + 1 }, () => "CIT-221-001/2024").join("\n");
    expect(errorCode(tooManyRows)).toBe("too_many_rows");
  });

  it("reports invalid rows with row numbers and reasons", () => {
    const parsed = parseRosterCsv(
      [
        "registration_number,student_name,student_status",
        "CIT-221-001/2024,A,ACTIVE",
        ",B,ACTIVE",
        "XX-1-1/1,C,ACTIVE",
        "CIT-221-004/2024,D",
        "CIT-221-005/2024,E,",
        `CIT-221-006/2024,${"x".repeat(201)},ACTIVE`,
      ].join("\n"),
    );
    expect(parsed.invalid).toEqual([
      { row: 2, reason: "missing_registration_number" },
      { row: 3, reason: "invalid_registration_number" },
      { row: 4, reason: "wrong_column_count" },
      { row: 5, reason: "missing_student_status" },
      { row: 6, reason: "student_name_too_long" },
    ]);
    expect(parsed.candidates).toHaveLength(1);
  });

  it("rejects all rows of repeated numbers, including case and whitespace variants", () => {
    const parsed = parseRosterCsv(
      ["registration_number", "CIT-221-001/2024", "cit-221-001/2024", "CIT-221-002/2024", " CIT-221-001/2024 "].join(
        "\n",
      ),
    );
    expect(parsed.duplicates).toEqual([
      { row: 1, reason: "duplicate_in_file" },
      { row: 2, reason: "duplicate_in_file" },
      { row: 4, reason: "duplicate_in_file" },
    ]);
    expect(parsed.candidates.map((candidate) => candidate.registrationNumber)).toEqual(["CIT-221-002/2024"]);
  });

  it("puts every data row in exactly one parse bucket", () => {
    const parsed = parseRosterCsv(
      ["registration_number", "CIT-221-001/2024", "CIT-221-001/2024", "bad", "CIT-221-003/2024"].join("\n"),
    );
    expect(parsed.candidates.length + parsed.invalid.length + parsed.duplicates.length).toBe(parsed.totalRows);
  });
});

describe("isRosterEntryEligible", () => {
  it("allows ACTIVE status in any case or a missing status column", () => {
    expect(isRosterEntryEligible({ rosterStatus: "ACTIVE" })).toBe(true);
    expect(isRosterEntryEligible({ rosterStatus: " active " })).toBe(true);
    expect(isRosterEntryEligible({ rosterStatus: null })).toBe(true);
  });

  it("rejects other statuses", () => {
    for (const status of ["WITHDRAWN", "DEFERRED", "GRADUATED", ""]) {
      expect(isRosterEntryEligible({ rosterStatus: status })).toBe(false);
    }
  });
});
