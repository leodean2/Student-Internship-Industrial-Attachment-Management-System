export const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

export const isUtcInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));

/** `{appBaseUrl}{path}?token=<encoded raw token>`. A link only opens a page; it never completes an action. */
export function buildTokenLink(appBaseUrl: string, path: string, rawToken: string): string {
  if (!isHttpUrl(appBaseUrl)) throw new Error("appBaseUrl must be an absolute http(s) URL");
  if (!rawToken) throw new Error("rawToken must not be empty");
  if (!path.startsWith("/")) throw new Error("path must start with '/'");
  return `${appBaseUrl.replace(/\/+$/, "")}${path}?token=${encodeURIComponent(rawToken)}`;
}

/** `{appBaseUrl}{path}`: a plain page link that carries no token. */
export function buildPageLink(appBaseUrl: string, path: string): string {
  if (!isHttpUrl(appBaseUrl)) throw new Error("appBaseUrl must be an absolute http(s) URL");
  if (!path.startsWith("/")) throw new Error("path must start with '/'");
  return `${appBaseUrl.replace(/\/+$/, "")}${path}`;
}
