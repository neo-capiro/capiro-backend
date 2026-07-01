import { Injectable } from '@nestjs/common';

export interface WatchTerm {
  id: string;
  watchlistId: string;
  clientId: string;
  termType: string;
  value: string;
  weight: number;
}

export interface SegmentMatch {
  termId: string;
  watchlistId: string;
  clientId: string;
  termType: string;
  termValue: string;
  score: number;
}

/**
 * Deterministic watchlist matching engine (H2). Scores a transcript segment
 * against a tenant's active watchlist terms. Pure + side-effect free so it is
 * unit-testable for the precision target (SC2.3 >= 0.8).
 *
 * Matching rules (kept conservative to avoid a false-positive flood):
 *  - case-insensitive, word-boundary match for multi-word/phrase terms
 *  - short terms (< 4 chars) require an exact token match (avoids "AI" hitting
 *    "again"); long terms allow substring-on-word-boundary
 *  - bill-number terms are normalized (strip spaces/periods: "S B 410"~"SB410")
 *  - score = term.weight * typeBoost, capped at 1.0
 */
@Injectable()
export class WatchlistMatcherService {
  private readonly typeBoost: Record<string, number> = {
    bill: 1.0,
    program_element: 1.0,
    risk_phrase: 0.95,
    opposition_language: 0.9,
    support_language: 0.9,
    legislator: 0.85,
    agency: 0.8,
    committee: 0.8,
    company: 0.8,
    competitor: 0.85,
    topic: 0.7,
  };

  match(segmentText: string, terms: WatchTerm[]): SegmentMatch[] {
    const hay = segmentText.toLowerCase();
    const hayNorm = normalizeBill(hay);
    const tokens = new Set(hay.split(/[^a-z0-9]+/i).filter(Boolean));
    const out: SegmentMatch[] = [];

    for (const term of terms) {
      const value = term.value.trim().toLowerCase();
      if (!value) continue;
      let hit = false;

      if (term.termType === 'bill' || term.termType === 'program_element') {
        // normalized exact-ish match (SB 410 == sb410)
        hit = hayNorm.includes(normalizeBill(value));
      } else if (value.length < 4 || !value.includes(' ')) {
        // short/single-token term → require a whole-token match
        hit = tokens.has(value);
      } else {
        // multi-word phrase → word-boundary substring
        hit = wordBoundaryIncludes(hay, value);
      }

      if (hit) {
        const boost = this.typeBoost[term.termType] ?? 0.7;
        const score = Math.min(1, term.weight * boost);
        out.push({
          termId: term.id,
          watchlistId: term.watchlistId,
          clientId: term.clientId,
          termType: term.termType,
          termValue: term.value,
          score,
        });
      }
    }
    // de-dupe by termId, keep highest score
    const best = new Map<string, SegmentMatch>();
    for (const m of out) {
      const cur = best.get(m.termId);
      if (!cur || m.score > cur.score) best.set(m.termId, m);
    }
    return Array.from(best.values());
  }
}

function normalizeBill(s: string): string {
  return s.replace(/[\s.]+/g, '');
}

function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}
