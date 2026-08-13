/**
 * Human document numbers (`architecture.md` §4.15): `<PREFIX>-<7 base32 chars>`.
 * The 7 characters are RFC 4648 base32 (35 random bits) — no digit/letter
 * ambiguity, no lookalike pairs. `UNIQUE` on the number column is the caller's
 * retry point: the collision probability at retail volume (~10k docs) is
 * ~0.14%, so a caller that sees a UNIQUE violation simply regenerates.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function docNumber(prefix: string): string {
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += BASE32_ALPHABET[byte & 31]!;
  }
  return `${prefix}-${out}`;
}
