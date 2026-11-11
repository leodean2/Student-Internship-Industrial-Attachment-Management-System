import { z } from "zod";
import { normalizePhoneToE164 } from "./phone";
import { GRADUATION_MAX_YEARS_AHEAD, PROFILE_TEXT_LENGTH, YEAR_OF_STUDY } from "./student-profile.limits";

const collapse = (value: string): string => value.trim().replace(/\s+/g, " ");

const text = (label: string) =>
  z
    .string()
    .transform(collapse)
    .pipe(
      z
        .string()
        .min(PROFILE_TEXT_LENGTH.min, `${label} must be ${PROFILE_TEXT_LENGTH.min} to ${PROFILE_TEXT_LENGTH.max} characters.`)
        .max(PROFILE_TEXT_LENGTH.max, `${label} must be ${PROFILE_TEXT_LENGTH.min} to ${PROFILE_TEXT_LENGTH.max} characters.`),
    )
    .nullable()
    .optional();

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
}

/**
 * `null` clears a field; an omitted field is unchanged; an empty string is invalid. Only the seven profile fields are
 * accepted: registration fields, status and `isComplete` are rejected by the strict object. The clock is injectable.
 */
export function createUpdateStudentProfileSchema(now: () => Date = () => new Date()) {
  const expectedGraduation = z
    .string()
    .transform((value, ctx) => {
      const date = parseDateOnly(value);
      if (!date) {
        ctx.addIssue({ code: "custom", message: "Use a valid date in YYYY-MM-DD format." });
        return z.NEVER;
      }
      const today = startOfUtcDay(now());
      const latest = new Date(Date.UTC(today.getUTCFullYear() + GRADUATION_MAX_YEARS_AHEAD, today.getUTCMonth(), today.getUTCDate()));
      if (date < today) {
        ctx.addIssue({ code: "custom", message: "Expected graduation cannot be in the past." });
        return z.NEVER;
      }
      if (date > latest) {
        ctx.addIssue({ code: "custom", message: `Expected graduation cannot be more than ${GRADUATION_MAX_YEARS_AHEAD} years ahead.` });
        return z.NEVER;
      }
      return date;
    })
    .nullable()
    .optional();

  const phone = z
    .string()
    .transform((value, ctx) => {
      const normalized = normalizePhoneToE164(value);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: "Enter a Kenyan phone number, for example 0712345678 or +254712345678." });
        return z.NEVER;
      }
      return normalized;
    })
    .nullable()
    .optional();

  return z
    .strictObject({
      university: text("University"),
      faculty: text("Faculty"),
      department: text("Department"),
      course: text("Course"),
      yearOfStudy: z
        .number()
        .int()
        .min(YEAR_OF_STUDY.min, `Year of study must be ${YEAR_OF_STUDY.min} to ${YEAR_OF_STUDY.max}.`)
        .max(YEAR_OF_STUDY.max, `Year of study must be ${YEAR_OF_STUDY.min} to ${YEAR_OF_STUDY.max}.`)
        .nullable()
        .optional(),
      phone,
      expectedGraduation,
    })
    .refine((value) => Object.values(value).some((field) => field !== undefined), {
      message: "Provide at least one field to update.",
    });
}

export type UpdateStudentProfileInput = z.infer<ReturnType<typeof createUpdateStudentProfileSchema>>;
