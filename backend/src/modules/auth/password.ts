import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";

/** Decision #51: bcrypt, cost 12. bcrypt only uses the first 72 bytes, so the (later) registration slice must cap passwords there. */
export const BCRYPT_COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/** Never throws: a malformed stored hash (e.g. the SYSTEM user's "!") simply does not match. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * Compared against when the email is unknown, so that case costs the same as a real one. A hash of a random
 * value at the real cost, made once per process (server.ts primes it at startup).
 */
export function getDummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString("base64url")).catch((err) => {
    dummy = undefined; // do not cache a failure
    throw err;
  });
  return dummy;
}
