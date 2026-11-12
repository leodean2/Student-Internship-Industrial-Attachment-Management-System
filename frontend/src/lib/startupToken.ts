let startupToken: string | null = null;

export function captureStartupToken(): void {
  const url = new URL(window.location.href);
  const values = url.searchParams.getAll("token");
  if (values.length === 0) return;
  startupToken = values[0] || null;
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export const getStartupToken = (): string | null => startupToken;

export function clearStartupToken(): void {
  startupToken = null;
}
