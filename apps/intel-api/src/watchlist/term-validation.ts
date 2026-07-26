/**
 * Canonical watchlist term validation (P0-05). The old flat MIN_TERM_LEN = 3
 * silently dropped strategically critical identifiers — AI, 5G, VA, EU, C2, F-1 —
 * at four separate enforcement points. Length policy is now term-shape aware.
 *
 * Mirrored byte-for-byte at apps/web/src/pages/clients/tracker/term-validation.ts
 * (the two runtimes cannot share a module). If you change one side, change the
 * other — term-validation.test.ts on the web side asserts they agree.
 */
export const MIN_TERM_LEN = 3;
/** Floor for a term whose SHAPE marks it as an identifier rather than a word. */
export const MIN_SHORT_TERM_LEN = 2;

/**
 * True when a 2-character term is a legitimate identifier rather than a stray
 * fragment: an all-caps acronym (AI, VA, EU, UK, C2, C3), anything containing a
 * digit (5G, F-1, F-35), or anything carrying identifier punctuation (H.R., PE
 * codes like 0604256F, BLIN designators).
 *
 * Deliberately NOT a general "allow short terms" switch: a lower-case 2-char
 * fragment ("of", "to") stays rejected, because it would substring-match everything.
 */
export function isIdentifierShapedTerm(raw: string): boolean {
  const v = (raw ?? '').trim();
  if (!v) return false;
  if (/\d/.test(v)) return true; // 5G, F-1, F-35, C2, 0604256F
  if (/[./\-+]/.test(v)) return true; // H.R., A-10, S/N
  return v === v.toUpperCase() && /^[A-Z]{2,}$/.test(v); // AI, VA, EU, UK — caps only
}

/** The minimum acceptable length for THIS term's shape. */
export function minLenFor(raw: string): number {
  return isIdentifierShapedTerm(raw) ? MIN_SHORT_TERM_LEN : MIN_TERM_LEN;
}

/** The single accept/reject predicate. Every enforcement point calls this. */
export function isAcceptableTerm(raw: string): boolean {
  const v = (raw ?? '').trim();
  return v.length >= minLenFor(v);
}

/** Human reason a term was rejected, for the inline validation the editor shows. */
export function termRejectionReason(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return 'Term cannot be empty.';
  if (isAcceptableTerm(v)) return null;
  return `"${v}" is too short to match safely. Short terms are allowed only when they are an all-caps acronym (AI, VA), contain a digit (5G, F-35), or contain identifier punctuation (H.R., A-10).`;
}

/**
 * Short identifier-shaped terms match CASE-SENSITIVELY with word boundaries against
 * the ORIGINAL-case text. "AI" must not match the letters "ai" inside ordinary prose,
 * and "VA" must not match a lower-case "va".
 */
export function isShortExactTerm(raw: string): boolean {
  const v = (raw ?? '').trim();
  return v.length < MIN_TERM_LEN && isIdentifierShapedTerm(v);
}
