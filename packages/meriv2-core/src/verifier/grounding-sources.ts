/**
 * Rich grounding source serialization for the verifier gate (P0-6 hardening).
 *
 * Flattens a tool-result record (budget figures, appropriation type, markup
 * status, per-FY tables) into a compact "key: value" body the grounding
 * verifier can judge claims against — richer than a thin title+snippet, which
 * previously caused false "unsupported" verdicts on real budget figures.
 *
 * Pure + dependency-free. Only `serializeRecordForGrounding` (the piece the
 * in-editor assistant needs) is ported here — `extractGroundingFromToolResult`
 * and `buildVerifierSources` are apps/api's full-chat citation-numbering
 * machinery and are out of scope for the in-editor surface.
 *
 * SYNC NOTE: apps/api keeps the full module (including the two functions above)
 * at `apps/api/src/meri/meri-verifier-sources.helpers.ts` (apps/api does not
 * depend on this package) — keep `serializeRecordForGrounding` in sync between
 * the two.
 */

/** Per-source grounding budget (chars). Enough to carry budget tables + status. */
export const GROUNDING_CHARS = 1_800;

/**
 * Flatten one record into a compact, human/LLM-readable "key: value" grounding
 * body, preserving numbers (budget figures!), short strings, and one level of
 * nested arrays/objects (the per-FY budget rows). Skips noisy/huge fields.
 */
export function serializeRecordForGrounding(record: unknown, maxChars = GROUNDING_CHARS): string {
  if (!record || typeof record !== 'object') {
    return typeof record === 'string' ? record.slice(0, maxChars) : '';
  }
  const parts: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      // Skip obviously noisy / non-grounding fields.
      if (/^(embedding|vector|raw|html|_|id$)/i.test(k) && typeof v !== 'number') continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${key}: ${v}`);
      } else if (typeof v === 'string') {
        const s = v.trim();
        if (s) parts.push(`${key}: ${s.length > 300 ? `${s.slice(0, 300)}…` : s}`);
      } else if (Array.isArray(v) && depth < 2) {
        // Per-FY budget rows etc. — keep a compact form of each entry.
        const items = v.slice(0, 12).map((item) => {
          if (item && typeof item === 'object') {
            return `{${Object.entries(item as Record<string, unknown>)
              .filter(
                ([, iv]) =>
                  iv != null &&
                  (typeof iv === 'number' || typeof iv === 'string' || typeof iv === 'boolean'),
              )
              .map(
                ([ik, iv]) => `${ik}=${typeof iv === 'string' ? (iv as string).slice(0, 80) : iv}`,
              )
              .join(', ')}}`;
          }
          return String(item);
        });
        if (items.length) parts.push(`${key}: [${items.join('; ')}]`);
      } else if (v && typeof v === 'object' && depth < 2) {
        walk(v as Record<string, unknown>, key, depth + 1);
      }
    }
  };
  walk(record as Record<string, unknown>, '', 0);
  const body = parts.join(' | ');
  return body.length > maxChars ? `${body.slice(0, maxChars - 1)}…` : body;
}
