interface DatabaseErrorShape {
  code?: unknown;
  meta?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isUniqueViolation(error: unknown): boolean {
  if (!isRecord(error)) return false;

  const databaseError = error as DatabaseErrorShape;
  if (databaseError.code === "23505" || databaseError.code === "P2002") return true;

  if (
    databaseError.code === "P2010" &&
    isRecord(databaseError.meta) &&
    databaseError.meta.code === "23505"
  ) {
    return true;
  }

  return typeof databaseError.message === "string" &&
    (/\b23505\b/.test(databaseError.message) ||
      /duplicate key value violates unique constraint/i.test(databaseError.message));
}
