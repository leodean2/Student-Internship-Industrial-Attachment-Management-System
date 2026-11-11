/** Provisional shape for this version, e.g. CIT-221-029/2024. A format check does not prove ownership. */
export const REGISTRATION_NUMBER_PATTERN = /^[A-Z]{3}-\d{3}-\d{3}\/\d{4}$/;

export const normalizeRegistrationNumber = (raw: string): string => raw.trim().toUpperCase();

export const isValidRegistrationNumber = (normalized: string): boolean =>
  REGISTRATION_NUMBER_PATTERN.test(normalized);

/** Provisional reading: the segment before the first "-" is the department identifier. */
export function departmentCodeOf(normalized: string): string {
  if (!isValidRegistrationNumber(normalized)) throw new RangeError("not a valid registration number");
  return normalized.split("-", 1)[0]!;
}
