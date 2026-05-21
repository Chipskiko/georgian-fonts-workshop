import { timingSafeEqual } from "node:crypto";

/**
 * Shared workshop admin password. Reads from env in production; falls back
 * to the original local-dev workshop password so `npm run dev` works out
 * of the box. In Vercel, set ADMIN_PASSWORD so it isn't visible in the repo.
 */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "vividxura";

/**
 * Constant-time password comparison. timingSafeEqual requires equal-length
 * buffers — pad both to the same length and AND with a length check so the
 * total work is constant regardless of where (or whether) the mismatch is.
 */
export function passwordsMatch(provided: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(ADMIN_PASSWORD, "utf8");
  const max = Math.max(a.length, b.length);
  const ap = Buffer.alloc(max);
  const bp = Buffer.alloc(max);
  a.copy(ap);
  b.copy(bp);
  const equal = timingSafeEqual(ap, bp);
  return equal && a.length === b.length;
}
