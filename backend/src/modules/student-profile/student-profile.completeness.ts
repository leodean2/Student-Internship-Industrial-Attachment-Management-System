import { isKenyanE164 } from "./phone";
import { PROFILE_TEXT_LENGTH, YEAR_OF_STUDY } from "./student-profile.limits";

export const REQUIRED_PROFILE_FIELDS = [
  "university",
  "faculty",
  "department",
  "course",
  "yearOfStudy",
  "phone",
  "expectedGraduation",
] as const;
export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number];

export interface ProfileFields {
  university: string | null;
  faculty: string | null;
  department: string | null;
  course: string | null;
  yearOfStudy: number | null;
  phone: string | null;
  expectedGraduation: Date | null;
}

const validText = (value: string | null): boolean => {
  if (value === null) return false;
  const length = value.trim().length;
  return length >= PROFILE_TEXT_LENGTH.min && length <= PROFILE_TEXT_LENGTH.max;
};

/**
 * Computed from stored values only, never from client input. A graduation date counts as valid when it is a real date:
 * the "not in the past" rule applies when it is entered, so a profile does not become incomplete as time passes.
 */
export function isProfileComplete(fields: ProfileFields): boolean {
  return (
    validText(fields.university) &&
    validText(fields.faculty) &&
    validText(fields.department) &&
    validText(fields.course) &&
    fields.yearOfStudy !== null &&
    Number.isInteger(fields.yearOfStudy) &&
    fields.yearOfStudy >= YEAR_OF_STUDY.min &&
    fields.yearOfStudy <= YEAR_OF_STUDY.max &&
    fields.phone !== null &&
    isKenyanE164(fields.phone) &&
    fields.expectedGraduation !== null &&
    !Number.isNaN(fields.expectedGraduation.getTime())
  );
}
