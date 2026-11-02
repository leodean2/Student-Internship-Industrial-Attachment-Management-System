import { createHash, randomBytes } from "node:crypto";

/** SHA-256 of a raw opaque token, hex. Only this hash is ever stored; the raw token is shown once. */
export const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

/** A fresh opaque token: 256 bits of entropy, base64url, plus the hash to store. */
export function mintOpaqueToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}
