/**
 * APPROVED for V1 (C1-F decision D4). Every numeric rule lives here, so changing one is a
 * one-file edit. None of these is enforced in the database.
 */
export const PROFILE_TEXT_LENGTH = { min: 2, max: 150 } as const;
export const YEAR_OF_STUDY = { min: 1, max: 7 } as const;
/** Expected graduation: today or later, and no further than this many years ahead. */
export const GRADUATION_MAX_YEARS_AHEAD = 8;
/** Country code applied to a local number written with a leading 0. */
export const DEFAULT_PHONE_COUNTRY_CODE = "254";
