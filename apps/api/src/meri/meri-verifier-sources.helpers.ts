/**
 * Rich grounding sources for the verifier gate (P0-6 hardening).
 *
 * THE BUG THIS FIXES: the grounding verifier was fed only each citation's
 * `title` (≤200 chars) + `snippet` (≤240 chars). The actual substance — budget
 * figures, appropriation type, markup status, the per-FY tables — lives in the
 * full tool-result records the agent saw (up to 12k chars each), which the
 * verifier never received. So the verifier asked "is '$525.22M FAMM request'
 * supported?" against a source list whose entry was just the title with no
 * dollar figure, and returned EVERY claim unsupported (the "18 of 18 claims
 * aren't backed" false-negative). This module reconstructs a fuller, verifier-
 * facing grounding body per source, numbered identically to the citations, so
 * the verifier judges claims against the real records.
 *
 * `extractGroundingFromToolResult` MIRRORS `extractCitationsFromToolResult`'s
 * row selection (same `rowsOf`, same "must have a title" filter, same
 * `maxPerTool`, same `startN`) so the grounding map's keys line up 1:1 with the
 * citation marker numbers. Keep the two in lockstep when either changes.
 *
 * Pure + dependency-free for `src/**.spec.ts`.
 */

import type { MeriCitation } from './meri-citations.helpers.js';

const TITLE_FIELDS = [
  'title',
  'name',
  'subject',
  'companyName',
  'registrantName',
  'identifier',
  'billNumber',
  'headline',
] as const;

/** Per-source grounding budget (chars). Enough to carry budget tables + status. */
export const GROUNDING_CHARS = 1_800;
/** Default number of rows pulled per tool — matches the citation extractor. */
export const GROUNDING_MAX_PER_TOOL = 5;

function rowsOf(payload: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(payload.data)) return payload.data as unknown[];
  if (Array.isArray(payload.results)) return payload.results as unknown[];
  return null;
}

function firstString(rec: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const f of fields) {
    const v = rec[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const inner = (v as Record<string, unknown>).text;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    }
  }
  return null;
}

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
              .filter(([, iv]) => iv != null && (typeof iv === 'number' || typeof iv === 'string' || typeof iv === 'boolean'))
              .map(([ik, iv]) => `${ik}=${typeof iv === 'string' ? (iv as string).slice(0, 80) : iv}`)
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

/**
 * Build N -> rich-grounding-body for one tool result, numbering rows from
 * `startN` exactly as the citation extractor does so keys align with `[N]`
 * markers. Returns an empty map for errors / empty / titleless rows.
 */
export function extractGroundingFromToolResult(
  payload: unknown,
  startN: number,
  maxPerTool = GROUNDING_MAX_PER_TOOL,
): Map<number, string> {
  const out = new Map<number, string>();
  if (!payload || typeof payload !== 'object') return out;
  const rec = payload as Record<string, unknown>;
  if (typeof rec.error === 'string') return out;
  const rows = rowsOf(rec);
  if (!rows || rows.length === 0) return out;

  let n = startN;
  let taken = 0;
  for (const row of rows) {
    if (taken >= maxPerTool) break;
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (!firstString(r, TITLE_FIELDS)) continue; // mirror citation "must have title"
    out.set(n, serializeRecordForGrounding(r));
    n += 1;
    taken += 1;
  }
  return out;
}

/**
 * Build the verifier source list: same `{n, title, snippet}` shape the verifier
 * already consumes, but `snippet` carries the RICH grounding body when we have
 * it (falling back to the thin citation snippet). This is the actual fix — the
 * verifier now sees budget figures, appropriation type, and markup status.
 */
export function buildVerifierSources(
  citations: MeriCitation[],
  groundingByN: Map<number, string>,
): Array<{ n: number; title: string; snippet: string | null }> {
  return citations.map((c) => ({
    n: c.n,
    title: c.title,
    snippet: groundingByN.get(c.n) ?? c.snippet,
  }));
}
