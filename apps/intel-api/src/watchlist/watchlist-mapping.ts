/**
 * Pure legacy→unified watchlist mapping (Phase 2, plan §3.3 / §5.4).
 *
 * Maps one apps/api `client_watchlist` row (issue_areas + tags JSON) into the
 * unified topic/term shape. No side effects, no DB — unit-testable in isolation
 * (parallels apps/api's pure tracker-relevance.util). The DB orchestration
 * (advisory locks, withSystem reads, upserts) lives in watchlist-sync.service.
 *
 * Bindings from plan §3 (authoritative): riskTerms → term_type `risk` (NOT
 * `risk_phrase`); MIN_TERM_LEN = 3; topic idempotency key = (watchlist, label).
 */
import { createHash } from 'node:crypto';
import { isAcceptableTerm } from './term-validation.js';

export { MIN_TERM_LEN } from './term-validation.js';

export type TagPosition = 'support' | 'oppose' | 'monitor';
export type TagPriority = 'low' | 'med' | 'high';
export type ExpandedTermType = 'synonym' | 'entity' | 'risk';

/** One tag object inside `client_watchlist.tags` (jsonb array). */
export interface LegacyTag {
  tag: string;
  issueArea?: string | null;
  synonyms?: string[];
  relatedEntities?: string[];
  riskTerms?: string[];
  position?: TagPosition;
  priority?: TagPriority;
}

/** A raw `client_watchlist` row as read by $queryRawUnsafe (snake_case). */
export interface LegacyWatchlistRow {
  client_id: string;
  tenant_id: string;
  issue_areas: string[] | null;
  tags: unknown; // jsonb → LegacyTag[]
  updated_by: string | null;
}

export interface ExpandedTerm {
  termType: ExpandedTermType;
  value: string;
}
export interface ExpandedTopic {
  label: string;
  issueArea: string | null;
  position: TagPosition;
  priority: TagPriority;
  terms: ExpandedTerm[];
}
export interface ExpandedWatchlist {
  clientId: string;
  tenantId: string;
  issueAreas: string[];
  createdBy: string;
  topics: ExpandedTopic[];
}

type NormalizeIssueArea = (raw: string | null | undefined) => string | null;

/** Trim, drop < MIN_TERM_LEN, case-insensitively de-dupe within a term type. */
function cleanTerms(values: string[] | undefined, termType: ExpandedTermType): ExpandedTerm[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: ExpandedTerm[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!isAcceptableTerm(v)) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ termType, value: v });
  }
  return out;
}

/**
 * Expand a legacy `client_watchlist` row into the unified topic/term shape.
 * FOR EACH tag → one topic; synonyms→`synonym`, relatedEntities→`entity`,
 * riskTerms→`risk`. Duplicate tag labels (case-insensitive) collapse to the
 * first (topic idempotency key = label).
 */
export function expandLegacyWatchlist(
  cw: LegacyWatchlistRow,
  normalizeIssueArea: NormalizeIssueArea,
): ExpandedWatchlist {
  const tags: LegacyTag[] = Array.isArray(cw.tags) ? (cw.tags as LegacyTag[]) : [];
  const topics: ExpandedTopic[] = [];
  const seenLabels = new Set<string>();
  for (const tag of tags) {
    if (!tag || typeof tag.tag !== 'string' || !tag.tag.trim()) continue;
    const label = tag.tag.trim();
    const key = label.toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    topics.push({
      label,
      issueArea: tag.issueArea ? normalizeIssueArea(tag.issueArea) : null,
      position: tag.position ?? 'monitor',
      priority: tag.priority ?? 'med',
      terms: [
        ...cleanTerms(tag.synonyms, 'synonym'),
        ...cleanTerms(tag.relatedEntities, 'entity'),
        ...cleanTerms(tag.riskTerms, 'risk'),
      ],
    });
  }
  return {
    clientId: cw.client_id,
    tenantId: cw.tenant_id,
    issueAreas: Array.isArray(cw.issue_areas) ? cw.issue_areas : [],
    createdBy: cw.updated_by ?? 'legacy-sync',
    topics,
  };
}

/**
 * Order-independent content signature for skip-if-unchanged (§3.4 E). Computed
 * identically from expanded-legacy and from persisted-unified rows, so equal
 * content ⇒ equal hash regardless of row order or timestamps.
 */
export function watchlistContentHash(w: { issueAreas: string[]; topics: ExpandedTopic[] }): string {
  const areas = [...w.issueAreas].map((a) => a.trim()).sort().join(',');
  const topics = [...w.topics]
    .map((t) => {
      const terms = [...t.terms].map((x) => `${x.termType}:${x.value}`).sort().join('|');
      return `${t.label}${t.issueArea ?? ''}${t.position}${t.priority}${terms}`;
    })
    .sort()
    .join('');
  return createHash('sha256').update(`${areas}${topics}`).digest('hex');
}
