export const INVALID_LINK_MESSAGE = "This link is invalid or has expired.";
export const TRY_AGAIN_MESSAGE = "Something went wrong. Please try again.";

export function rateLimitMessage(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return "Too many attempts. Please wait a while and try again.";
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
