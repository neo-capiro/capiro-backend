/**
 * §4.4: relevance currently collapses to `Matches your watchlist term "X".` /
 * `In your tracked issue area "X".` A government-affairs explanation
 * distinguishes WHY it matters, not just THAT it matched.
 *
 * DETERMINISTIC — the LLM never picks the kind. Every kind is derived from a
 * signal we actually hold: the term type that matched, the client's stated
 * position on the topic, the detector's severity, and the change type.
 *
 * Two kinds are gated on signals intel-api does NOT have and must never be
 * guessed (§6.6):
 *   - `relationship_opportunity` needs target offices / committee assignments,
 *     which live in apps/api.
 *   - `district_impact` needs a client facility in the bill's jurisdiction.
 * Both are emitted ONLY when the caller passes the backing flag.
 */

export type RelevanceKind =
  | 'direct_impact'
  | 'strategic_opportunity'
  | 'political_risk'
  | 'procedural_urgency'
  | 'competitive_impact'
  | 'district_impact'
  | 'funding_impact'
  | 'relationship_opportunity';

/** Term types that mean the client (or a bill it tracks) is named outright. */
const DIRECT_TERM_TYPES = new Set(['company', 'bill']);
/** Change types whose whole point is a deadline. */
const DEADLINE_CHANGE_TYPES = new Set([
  'state_bill_deadline_approaching',
  'state_bill_dead_by_deadline',
]);

export interface RelevanceKindInput {
  matchedTermTypes: string[];
  position: string | null;
  severity: string;
  changeType: string;
  /** A client facility sits in this bill's jurisdiction. Never inferred. */
  hasFacilityInJurisdiction: boolean;
  /** A tracked target sits on the deciding committee. Never inferred. */
  hasTargetInCommittee: boolean;
}

/**
 * The relevance kinds that apply, in a stable order so two runs over the same
 * input produce the same array (the value is stored on the alert).
 */
export function relevanceKindsFor(input: RelevanceKindInput): RelevanceKind[] {
  const kinds = new Set<RelevanceKind>();
  const types = new Set((input.matchedTermTypes ?? []).map((t) => (t ?? '').toLowerCase()));
  const position = (input.position ?? '').toLowerCase();
  const severity = (input.severity ?? '').toLowerCase();

  for (const t of types) {
    if (DIRECT_TERM_TYPES.has(t)) kinds.add('direct_impact');
    if (t === 'competitor') kinds.add('competitive_impact');
    if (t === 'program_element') kinds.add('funding_impact');
    if ((t === 'risk_phrase' || t === 'opposition_language') && position === 'oppose') {
      kinds.add('political_risk');
    }
    if (t === 'support_language' && position === 'support') {
      kinds.add('strategic_opportunity');
    }
  }

  if (severity === 'critical' || DEADLINE_CHANGE_TYPES.has(input.changeType)) {
    kinds.add('procedural_urgency');
  }
  // Gated on real signals — see the module comment.
  if (input.hasFacilityInJurisdiction) kinds.add('district_impact');
  if (input.hasTargetInCommittee) kinds.add('relationship_opportunity');

  // Stable ordering, most client-specific first.
  const ORDER: RelevanceKind[] = [
    'direct_impact',
    'funding_impact',
    'district_impact',
    'competitive_impact',
    'political_risk',
    'strategic_opportunity',
    'relationship_opportunity',
    'procedural_urgency',
  ];
  return ORDER.filter((k) => kinds.has(k));
}

/** One human clause per kind, for the second sentence of `why`. */
const KIND_CLAUSE: Record<RelevanceKind, string> = {
  direct_impact: 'It names the client directly',
  funding_impact: 'It moves funding on a program element the client tracks',
  district_impact: 'The client has a facility in the affected jurisdiction',
  competitive_impact: 'It names a tracked competitor',
  political_risk: 'It carries language the client has taken a position against',
  strategic_opportunity: 'It carries language the client supports',
  relationship_opportunity: 'A tracked target sits on the deciding committee',
  procedural_urgency: 'The move is time-critical',
};

/**
 * §4.4 (d-4): compose up to two clauses. The EXISTING `why` string is kept
 * verbatim as the first clause, so no historical wording changes (Gate B
 * §2.4.6 / criterion 9). The second clause is sourced from a kind that is
 * itself backed by a real signal — never a free-form template.
 */
export function composeWhy(existingWhy: string | null, kinds: RelevanceKind[]): string | null {
  if (!existingWhy) return existingWhy;
  const extra = kinds.map((k) => KIND_CLAUSE[k]).find(Boolean);
  if (!extra) return existingWhy;
  return `${existingWhy} ${extra}.`;
}
