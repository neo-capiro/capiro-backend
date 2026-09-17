/**
 * Pure normalizers for the client Portfolio → Capabilities →
 * "Where capabilities create fit" card.
 *
 * This module deliberately contains NO scoring logic. The card is a
 * *projection* of scores that already exist upstream (PE relevance, tracker
 * bill recommendations, funding-opportunity relevance); inventing a fourth
 * matcher here would silently diverge from those surfaces. Everything below
 * only filters, re-labels and rescales upstream output.
 *
 * PURE module: no DB, no NestJS, no I/O — unit-testable in isolation.
 */

import type { PathResult, RelevancePath } from '../intelligence/client-pe-relevance.scoring.js';
import type { RecommendationBill } from '../tracker/tracker.types.js';
import type { OpportunityMatchedSignal } from '../funding-opportunities/funding-opportunities.types.js';
import { explainOpportunity } from '../funding-opportunities/opportunity-explanation.js';

/** The kinds of target that can appear on the capability-fit card. */
export type CapabilityFitKind = 'pe' | 'bill' | 'fo';

/**
 * One row of the "Where capabilities create fit" card.
 *
 * `score01` is the canonical, comparable score; `fit` is the 0..100 integer the
 * `FitChip` renders. Both are stored so the UI never has to rescale (and so an
 * FO score, natively 0..100, cannot be multiplied by 100 twice).
 */
export interface CapabilityFitMatch {
  /** Stable, kind-namespaced row id — `pe:0605053A`, `bill:<uuid>`, `fo:<id>`. */
  id: string;
  kind: CapabilityFitKind;
  /** The upstream target's own identifier (PE code, bill id, FO id). */
  targetId: string;
  /** Display label, e.g. `PE 0605053A · Ground Robotics`. */
  target: string;
  /** Verbatim upstream evidence for why this matched. Never LLM-generated. */
  why: string;
  /** 0..100 integer for the FitChip. */
  fit: number;
  /** Canonical 0..1 score (FO = relevanceScore / 100). */
  score01: number;
  /** PE-only: the upstream relevance paths, kept for drill-down/debugging. */
  paths?: PathResult[];
  /** Capability areas this row is attributed to (may be empty in Phase A). */
  capabilityIds: string[];
  matchedTags?: string[];
  /** In-app deep link to the target, or null when the kind has no route. */
  href?: string | null;
}

/**
 * Rescale a canonical 0..1 score to the 0..100 integer the `FitChip` UI expects.
 * Clamps out-of-band values and treats non-finite input as 0 so a single bad
 * upstream score cannot render as `NaN%` on the card.
 *
 * FO relevance is ALREADY 0..100 — never send it through here.
 */
export function pct01(score01: number): number {
  if (!Number.isFinite(score01)) return 0;
  const clamped = Math.min(1, Math.max(0, score01));
  return Math.round(clamped * 100);
}

/**
 * PE relevance paths that count as "this capability created the fit".
 *
 * Facility/prior-award/ecosystem relevance is general *client* relevance — real,
 * but it is not evidence that a capability area drove the match, so it must not
 * appear on the capabilities card.
 */
export const CAPABILITY_GROUNDED_PE_PATHS: readonly RelevancePath[] = [
  'capability_pe_direct',
  'capability_keyword',
];

/** True when at least one PE relevance path is capability-derived. */
export function isCapabilityGroundedPe(paths: PathResult[] | null | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  return paths.some((p) => CAPABILITY_GROUNDED_PE_PATHS.includes(p.path));
}

/** Shown when a capability path matched but carried no usable evidence string. */
export const GENERIC_CAPABILITY_WHY = 'Matched this client’s capability profile';

/**
 * Human-readable "why" for a PE row, taken verbatim from the upstream scorer's
 * evidence — no LLM, no re-phrasing, so the card can never claim a reason the
 * scorer did not actually record.
 *
 * Only capability paths may supply the reason (a facility-district string would
 * be a lie on a card titled "where capabilities create fit"), and
 * `capability_pe_direct` wins over `capability_keyword` because an explicit PE
 * number is the stronger, more specific claim.
 */
export function whyFromPePaths(paths: PathResult[] | null | undefined): string {
  const byPath = (path: RelevancePath): string | null => {
    const hit = (paths ?? []).find((p) => p.path === path);
    // evidence[0] is the human sentence; later entries are numeric detail
    // ("similarity 0.82"), which reads as noise on the card.
    return hit?.evidence?.[0]?.trim() || null;
  };
  return byPath('capability_pe_direct') ?? byPath('capability_keyword') ?? GENERIC_CAPABILITY_WHY;
}

/**
 * Project one scored PE from `ClientPeRelevanceService.getRelevantPesForClient`
 * onto a card row, or `null` when the PE is not capability-grounded.
 *
 * Returning null (rather than filtering upstream) keeps the capability-grounded
 * rule in one tested place: general client relevance — facility district, prior
 * award, ecosystem — belongs on the Intelligence tab, not on a card that claims
 * the client's *capabilities* created the fit.
 */
export function peToMatch(
  pe: { peCode: string; title?: string | null; score: number; paths: PathResult[] },
  opts: { capabilityIds?: string[] } = {},
): CapabilityFitMatch | null {
  if (!isCapabilityGroundedPe(pe.paths)) return null;

  const peCode = pe.peCode.trim().toUpperCase();
  const title = pe.title?.trim();

  return {
    id: `pe:${peCode}`,
    kind: 'pe',
    targetId: peCode,
    target: title ? `PE ${peCode} · ${title}` : `PE ${peCode}`,
    why: whyFromPePaths(pe.paths),
    fit: pct01(pe.score),
    score01: pe.score,
    paths: pe.paths,
    capabilityIds: opts.capabilityIds ?? [],
    href: `/program-elements/${peCode}`,
  };
}

/**
 * Project one tracker recommendation onto a card row, or `null` when the
 * tracker already ruled it out (below its own floor, or a non-positive fit).
 *
 * Capability grounding for bills is upstream: tags feed
 * `getClientRelevanceTerms` → the tracker matcher, and this service short-
 * circuits to `profile_too_thin` before any fan-out when the client has zero
 * capabilities. We do NOT invent a second bill floor here.
 *
 * `why` is taken verbatim from the tracker — it already humanizes the primary
 * match reason.
 */
export function billToMatch(
  rec: RecommendationBill,
  opts: { capabilityIds?: string[] } = {},
): CapabilityFitMatch | null {
  if (rec.belowFloor || !(rec.fit > 0)) return null;

  const billId = rec.billId.trim();
  const displayNum = rec.displayNum.trim();
  const title = rec.title.trim();

  return {
    id: `bill:${billId}`,
    kind: 'bill',
    targetId: billId,
    target: title ? `${displayNum} · ${title}` : displayNum,
    why: rec.why,
    fit: pct01(rec.fit),
    score01: rec.fit,
    capabilityIds: opts.capabilityIds ?? [],
    matchedTags: rec.matchedTags,
    // Bill 360 canonical route — verified via VNextBillRoutes `/bills/:billId`.
    href: `/bills/${encodeURIComponent(billId)}`,
  };
}

/**
 * The FO list path attaches the scorer floor as `_meetsFloor` (see
 * the canonical V2 search projection). Some callers / future public
 * shapes may use `meetsSuggestionFloor`. Accept either; invent no numeric
 * threshold here.
 */
export interface FoCapabilityFitInput {
  id: string;
  source: string;
  sourceRecordId: string;
  title: string;
  /** Already 0..100 from the FO scorer — never run through {@link pct01}. */
  relevanceScore: number;
  matchedSignals: Array<Omit<OpportunityMatchedSignal, 'weight'> & { weight?: number }>;
  eligibility: { state: string; reason: string };
  _meetsFloor?: boolean;
  meetsSuggestionFloor?: boolean;
}

/** Shown when neither matched signals nor eligibility.reason supply a why. */
export const GENERIC_FO_WHY = 'Matched this client’s capability profile';

/**
 * Clamp a native 0..100 FO relevance score to the FitChip integer. FO scores
 * are ALREADY percent-scale — do not call {@link pct01}.
 */
export function fitFromFoRelevance(relevanceScore: number): number {
  if (!Number.isFinite(relevanceScore)) return 0;
  return Math.round(Math.min(100, Math.max(0, relevanceScore)));
}

/** Canonical 0..1 companion for an FO relevanceScore already on 0..100. */
export function score01FromFoRelevance(relevanceScore: number): number {
  if (!Number.isFinite(relevanceScore)) return 0;
  return Math.min(100, Math.max(0, relevanceScore)) / 100;
}

/**
 * Human "why" for an FO row. Prefer the strongest matched-signal explanation
 * from the existing FO label map (`explainOpportunity`) — that prose already
 * cites the verbatim matched value. Fall back to eligibility.reason, then a
 * generic capability line. No LLM, no re-phrasing beyond the shared map.
 */
export function whyFromFo(row: {
  matchedSignals: Array<Omit<OpportunityMatchedSignal, 'weight'> & { weight?: number }>;
  eligibility?: { reason?: string } | null;
}): string {
  const explained = explainOpportunity(row.matchedSignals ?? []);
  if (explained.strongest?.detail?.trim()) return explained.strongest.detail.trim();
  const eligibilityWhy = row.eligibility?.reason?.trim();
  if (eligibilityWhy) return eligibilityWhy;
  return GENERIC_FO_WHY;
}

/**
 * Project one scored funding opportunity onto a card row, or `null` when the
 * upstream scorer already ruled it below its suggestion floor.
 *
 * Scale contract (the bug this helper exists to prevent):
 *   fit     = round(clamp(relevanceScore, 0, 100))   // already 0..100
 *   score01 = fit / 100                              // NOT pct01(relevanceScore)
 */
export function foToMatch(
  row: FoCapabilityFitInput,
  opts: { capabilityIds?: string[] } = {},
): CapabilityFitMatch | null {
  const meetsFloor = row._meetsFloor === true || row.meetsSuggestionFloor === true;
  if (!meetsFloor) return null;

  const source = row.source.trim();
  const sourceRecordId = row.sourceRecordId.trim();
  if (!source || !sourceRecordId) return null;

  const fit = fitFromFoRelevance(row.relevanceScore);
  const title = row.title.trim();

  return {
    // FO ids are source-scoped; bare fo:${id} can collide across catalogs.
    id: `fo:${source}:${sourceRecordId}`,
    kind: 'fo',
    targetId: sourceRecordId,
    target: title || sourceRecordId,
    why: whyFromFo(row),
    fit,
    score01: score01FromFoRelevance(row.relevanceScore),
    capabilityIds: opts.capabilityIds ?? [],
    // FO detail route verified via VNextFundingOpportunitiesRoutes.
    href: `/intelligence/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}`,
  };
}

/** Max rows persisted in the cache; the UI shows a shorter slice of these. */
export const MAX_STORED_MATCHES = 12;

/**
 * Order rows for display: strongest fit first, ties broken by target label.
 *
 * There is deliberately NO blended cross-kind meta-score — a PE at 82 and a
 * bill at 82 are simply both "82 from their own scorer". Sorting on the
 * displayed number is the only comparison the card claims to make. Returns a
 * new array; callers often hold the upstream result.
 */
export function sortMatches(matches: CapabilityFitMatch[]): CapabilityFitMatch[] {
  return [...matches].sort((a, b) => b.fit - a.fit || a.target.localeCompare(b.target));
}

/** Cap the row count (defaults to {@link MAX_STORED_MATCHES}). */
export function takeTop(
  matches: CapabilityFitMatch[],
  limit: number = MAX_STORED_MATCHES,
): CapabilityFitMatch[] {
  return matches.slice(0, Math.max(0, limit));
}

/** Normalize a PE code for comparison: trimmed, upper-cased. */
function normalizePeCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase();
}

/** Normalize free-text capability signals for case/whitespace-insensitive matching. */
function normalizeCapabilityToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/**
 * Find capabilities whose JSON tags or keyword arrays contain any matched token.
 * Capability order is preserved and each id is returned once.
 */
export function capsForMatchedTags(
  capabilities: Array<{ id: string; tags?: unknown; keywords?: unknown }>,
  matchedTags: string[] | null | undefined,
): string[] {
  const matched = new Set((matchedTags ?? []).map(normalizeCapabilityToken).filter(Boolean));
  if (matched.size === 0) return [];
  return capabilities
    .filter((cap) => {
      const tags = Array.isArray(cap.tags) ? cap.tags : [];
      const keywords = Array.isArray(cap.keywords) ? cap.keywords : [];
      return [...tags, ...keywords].some((value) => matched.has(normalizeCapabilityToken(value)));
    })
    .map((cap) => cap.id);
}

/**
 * Capability areas that explicitly name `peCode` — the attribution behind a
 * `capability_pe_direct` hit. Checks `peNumbers[]` and the legacy `peNumber`
 * column, because both are still populated in live data.
 */
export function capsForPeDirect(
  capabilities: Array<{ id: string; peNumbers?: string[] | null; peNumber?: string | null }>,
  peCode: string,
): string[] {
  const target = normalizePeCode(peCode);
  if (!target) return [];
  return capabilities
    .filter((cap) => {
      const codes = [...(cap.peNumbers ?? []), cap.peNumber].map(normalizePeCode);
      return codes.includes(target);
    })
    .map((cap) => cap.id);
}
