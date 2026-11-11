/** Header aliases (normalized form). A different export layout is an edit here, not a code change. */
export const ROSTER_COLUMN_ALIASES = {
  registrationNumber: ["registration_number", "reg_number", "reg_no", "registration_no", "regno"],
  studentName: ["student_name", "name", "full_name"],
  status: ["student_status", "status"],
} as const;

export type RosterField = keyof typeof ROSTER_COLUMN_ALIASES;
export const REQUIRED_ROSTER_FIELDS: readonly RosterField[] = ["registrationNumber"];

export const normalizeHeader = (header: string): string =>
  header
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function mapHeaders(header: readonly string[]): {
  indexes: Partial<Record<RosterField, number>>;
  missingRequired: RosterField[];
  ambiguous: RosterField[];
} {
  const normalized = header.map(normalizeHeader);
  const indexes: Partial<Record<RosterField, number>> = {};
  const ambiguous: RosterField[] = [];
  for (const field of Object.keys(ROSTER_COLUMN_ALIASES) as RosterField[]) {
    const aliases: readonly string[] = ROSTER_COLUMN_ALIASES[field];
    const matches = normalized.flatMap((name, index) => (aliases.includes(name) ? [index] : []));
    if (matches.length > 1) ambiguous.push(field);
    else if (matches.length === 1) indexes[field] = matches[0]!;
  }
  const missingRequired = REQUIRED_ROSTER_FIELDS.filter(
    (field) => indexes[field] === undefined && !ambiguous.includes(field),
  );
  return { indexes, missingRequired, ambiguous };
}
