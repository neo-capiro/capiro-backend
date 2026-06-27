/**
 * Display-time anonymization. The Anonymize toggle replaces direct client and
 * product names with neutral placeholders in the rendered document (the Phase 6
 * review modal will let the user approve per-term scope + export behavior; this
 * is the live toggle behavior).
 *
 * Server-side generation can also return anonymized content (useGenerateSection
 * → result.anonymized); this client pass covers content already in the doc.
 */

/** A persisted redaction from the Anonymize review modal (cfg.anonymizeMap). */
export interface StoredRedaction {
  from: string;
  to: string;
  scope?: 'all' | 'this';
}

/**
 * Build a name→placeholder map for the live display pass.
 *
 * When the draft carries a reviewed redaction map (cfg.anonymizeMap.redactions),
 * that is authoritative — each approved term maps to its chosen replacement
 * (generic/custom). Otherwise fall back to the simple client→"the client",
 * product→"the program" default (the toggle behavior before a review is run).
 *
 * Note: "this mention only" scope can't be expressed in a global string-replace
 * display pass, so the live canvas applies every approved redaction globally;
 * per-mention scope is honored at export time (server-side) where the offset is
 * known. The display pass is intentionally a superset (never leaks a name).
 */
export function anonymizeMap(
  client: string | null,
  product: string | null,
  redactions?: StoredRedaction[],
): Array<[RegExp, string]> {
  const pairs: Array<[string, string]> = [];
  if (redactions && redactions.length) {
    for (const r of redactions) if (r.from && r.to) pairs.push([r.from, r.to]);
  } else {
    if (client) pairs.push([client, 'the client']);
    if (product) pairs.push([product, 'the program']);
  }
  return (
    pairs
      // Longest names first so a multi-word match wins over a partial one.
      .sort((a, b) => b[0].length - a[0].length)
      .map(([from, to]) => [new RegExp(escapeRegExp(from), 'g'), to])
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Apply an anonymize map to a string when `on`. */
export function anonText(
  text: string | undefined | null,
  on: boolean,
  map: Array<[RegExp, string]>,
): string {
  if (!on || !text) return text ?? '';
  return map.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
