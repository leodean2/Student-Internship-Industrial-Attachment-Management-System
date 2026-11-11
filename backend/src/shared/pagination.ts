/** Fetch `limit + 1` rows, then page with this: a cursor exists only when a further row does. */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  idOf: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? idOf(items.at(-1)!) : null };
}
