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

/**
 * Draws a fresh document number that passes the caller's `isTaken` check
 * (regenerated on collision, `architecture.md` §4.15 — the collision
 * probability at retail volume is ~0.14%, so a caller that hits a UNIQUE
 * violation simply redraws). Throws only if the 35-bit space is somehow
 * exhausted after 10 draws — practically unreachable.
 */
export function freshDocNumber(prefix: string, isTaken: (candidate: string) => boolean): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = docNumber(prefix);
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error("document number space exhausted");
}
