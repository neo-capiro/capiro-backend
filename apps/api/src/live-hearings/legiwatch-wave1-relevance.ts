/**
 * LegiWatch V2 Wave 1 (W1-6) — client relevance V2.
 *
 * Turns the tenant relevance rail (`tenant_hearing_relevance`, derived from
 * global `public_hearing_insight` rows) into the structured result the product
 * needs: a band, why it matters, matched priorities, evidence with transcript
 * timestamps, implications, recommended actions, and provenance.
 *
 * This module is PURE. It only shapes rows the caller already loaded under the
 * tenant's own scope, so it cannot widen visibility.
 *
 * ── The grounding rule ──
 *
 * Every statement returned here must be traceable to a row that was passed in.
 * The band comes from scores, the priorities from `matched_on`, the evidence
 * from the cited public insight and its transcript segment, and the rationale
 * from the stored rationale text. Nothing is composed from the hearing title
 * or the client name alone.
 *
 * In particular: a hearing with NO transcript can still have relevance derived
 * from scheduling facts, but it must not produce transcript-based claims. The
 * caller passes `hasTranscript` and this module downgrades to
 * `INSUFFICIENT_EVIDENCE` rather than emitting evidence it cannot cite.
 */

/** The relevance bands, plus the two honest absence states. */
export type RelevanceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' | 'INSUFFICIENT_EVIDENCE';

/**
 * Band thresholds over the stored 0..1 relevance score.
 *
 * These are the product's bands, not a model output — they live here as one
 * named constant so the API, the notification fan-out ("HIGH client relevance
 * detected") and the UI cannot disagree about what HIGH means.
 */
export const RELEVANCE_BAND_FLOORS = {
  HIGH: 0.7,
  MEDIUM: 0.45,
  LOW: 0.2,
} as const;

/** One tenant relevance row joined to the public insight it cites. */
export interface RelevanceRow {
  id: string;
  clientId: string;
  clientName: string | null;
  hearingId: string;
  insightId: string;
  score: number;
  /** Tenant-owned match context, e.g. watchlist terms/topics that matched. */
  matchedOn: unknown;
  rationale: string;
  updatedAt: Date;
  /** ── the cited GLOBAL public insight ── */
  insightType: string;
  insightTitle: string;
  insightSummary: string;
  evidenceText: string | null;
  speakerName: string | null;
  confidence: number | null;
  preliminary: boolean;
  segmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  extractor: string;
  extractorVersion: string;
}

export interface RelevanceEvidence {
  insightId: string;
  insightType: string;
  title: string;
  summary: string;
  /** The supporting quote from the canonical transcript, when one exists. */
  quote: string | null;
  speakerName: string | null;
  /** Canonical transcript segment for click-to-jump; null when uncited. */
  segmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  /** `H:MM:SS` rendering of startMs, for a deep link the user can read. */
  timecode: string | null;
  confidence: number | null;
  preliminary: boolean;
}

export interface MatchedPriority {
  label: string;
  /** Where the match came from, when the stored context says. */
  kind: string | null;
}

export interface ClientRelevanceResult {
  clientId: string;
  clientName: string | null;
  hearingId: string;
  band: RelevanceBand;
  /** Max score across the client's rows; null when there are none. */
  score: number | null;
  /** Grounded in the stored rationales — never composed from the title. */
  whyItMatters: string;
  matchedPriorities: MatchedPriority[];
  evidence: RelevanceEvidence[];
  implications: string[];
  recommendedActions: RecommendedAction[];
  provenance: RelevanceProvenance;
  /** When the underlying relevance was last evaluated. */
  evaluatedAt: string | null;
}

export interface RecommendedAction {
  /** Matches the Wave 1 action endpoints, so the UI can wire directly. */
  action: 'ask_meri' | 'create_brief' | 'stage_outreach' | 'save_moment' | 'save_to_client';
  label: string;
  /** Why this action is offered for this result. */
  rationale: string;
  /** The canonical reference the action should be prefilled with. */
  insightId?: string;
  segmentId?: string;
}

export interface RelevanceProvenance {
  /** Canonical hearing this analysis is about. */
  hearingId: string;
  /** The public insight rows cited above. */
  insightIds: string[];
  /** The canonical transcript segments cited above. */
  segmentIds: string[];
  /** Whether a canonical transcript exists at all. */
  transcriptAvailable: boolean;
  /** Distinct extractors that produced the cited insights. */
  extractors: string[];
  /** How many tenant relevance rows backed this result. */
  matchCount: number;
}

/** `H:MM:SS` from a millisecond offset. */
export function timecode(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Score → band. Below the LOW floor a positive score is still NONE. */
export function bandForScore(score: number | null): RelevanceBand {
  if (score == null || !Number.isFinite(score)) return 'NONE';
  if (score >= RELEVANCE_BAND_FLOORS.HIGH) return 'HIGH';
  if (score >= RELEVANCE_BAND_FLOORS.MEDIUM) return 'MEDIUM';
  if (score >= RELEVANCE_BAND_FLOORS.LOW) return 'LOW';
  return 'NONE';
}

/**
 * Read matched priority labels out of the stored `matched_on` JSON.
 *
 * The column is written by the Phase 8 relevance worker and its shape has
 * varied across revisions, so this reads defensively and returns only labels
 * it can actually find. It never invents a priority from the client name.
 */
export function extractMatchedPriorities(matchedOn: unknown): MatchedPriority[] {
  const out: MatchedPriority[] = [];
  const seen = new Set<string>();

  const push = (label: unknown, kind: unknown) => {
    if (typeof label !== 'string') return;
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) return;
    seen.add(trimmed.toLowerCase());
    out.push({ label: trimmed, kind: typeof kind === 'string' && kind.trim() ? kind.trim() : null });
  };

  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      push(node, null);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      // Known label carriers, in the order the worker has used them.
      const label = o.label ?? o.term ?? o.topic ?? o.name ?? o.value;
      if (label !== undefined) {
        push(label, o.kind ?? o.type ?? o.source);
        return;
      }
      for (const v of Object.values(o)) visit(v);
    }
  };

  visit(matchedOn);
  return out;
}

/**
 * Build the "why it matters" text from the stored rationales.
 *
 * Rationales are per-insight, so the highest-scoring ones are the ones worth
 * leading with. They are joined verbatim rather than paraphrased: paraphrasing
 * here would produce a claim no row supports.
 */
function buildWhyItMatters(rows: RelevanceRow[], band: RelevanceBand): string {
  if (band === 'INSUFFICIENT_EVIDENCE') {
    return 'There is not enough evidence on the record yet to assess relevance for this client.';
  }
  if (!rows.length) {
    return 'No watchlist or client-priority match was found for this proceeding.';
  }
  const rationales = rows
    .map((r) => r.rationale?.trim())
    .filter((r): r is string => Boolean(r))
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 3);
  if (!rationales.length) {
    // Rows exist but carry no rationale text. Say that, rather than filling
    // the gap with a sentence the data does not support.
    return 'This proceeding matched this client’s priorities, but no rationale was recorded for the match.';
  }
  return rationales.join(' ');
}

/**
 * Implications, derived strictly from the insight TYPES actually present.
 *
 * Each line is a statement about what kind of thing is on the record, which is
 * a fact about the cited rows — not a prediction. An insight type with no
 * mapping produces no line.
 */
const TYPE_IMPLICATION: Record<string, string> = {
  COMMITMENT: 'A witness or member made a commitment on the record that can be tracked to follow-through.',
  DEADLINE: 'A dated deadline was stated on the record.',
  FUNDING_AMOUNT: 'A specific funding figure was discussed, which may affect budget positioning.',
  BILL_REFERENCE: 'Legislation was referenced, linking this proceeding to a bill on the tracker.',
  PROGRAM_ELEMENT_REFERENCE: 'A program element was referenced, linking this proceeding to budget lines.',
  AGENCY_REFERENCE: 'An agency was named, which may indicate where follow-up should be directed.',
  POLICY_POSITION: 'A policy position was stated that may shift the landscape for this client.',
  QUESTION: 'An unanswered question was posed on the record, which is an opening for follow-up.',
  KEY_QUOTE: 'A quotable statement was made that can be cited in client materials.',
};

function buildImplications(rows: RelevanceRow[]): string[] {
  const types = new Set(rows.map((r) => r.insightType));
  const out: string[] = [];
  for (const t of types) {
    const line = TYPE_IMPLICATION[t];
    if (line) out.push(line);
  }
  return out;
}

/**
 * Recommended actions, each tied to a concrete canonical reference.
 *
 * An action is only offered when the reference it would prefill actually
 * exists, so no recommended action can lead to an empty prefill.
 */
function buildRecommendedActions(
  rows: RelevanceRow[],
  band: RelevanceBand,
): RecommendedAction[] {
  if (band === 'NONE' || band === 'INSUFFICIENT_EVIDENCE' || !rows.length) return [];

  const out: RecommendedAction[] = [];
  const top = rows[0]!;

  out.push({
    action: 'ask_meri',
    label: 'Ask Meri about this finding',
    rationale: 'Explore the finding with the hearing, transcript segment and client already in context.',
    insightId: top.insightId,
    ...(top.segmentId ? { segmentId: top.segmentId } : {}),
  });

  // A brief is worth offering once there is more than a single data point.
  if (rows.length > 1 || band === 'HIGH') {
    out.push({
      action: 'create_brief',
      label: 'Create a client brief',
      rationale: `Draft a brief grounded in the ${rows.length} matched finding${rows.length === 1 ? '' : 's'} from this proceeding.`,
    });
  }

  // Outreach is only recommended when something actionable is on the record —
  // a commitment, a deadline, an open question or a stated position.
  const actionable = rows.find((r) =>
    ['COMMITMENT', 'DEADLINE', 'QUESTION', 'POLICY_POSITION'].includes(r.insightType),
  );
  if (actionable) {
    out.push({
      action: 'stage_outreach',
      label: 'Stage outreach',
      rationale: `A ${actionable.insightType.toLowerCase().replace(/_/g, ' ')} on the record is a concrete hook for outreach.`,
      insightId: actionable.insightId,
      ...(actionable.segmentId ? { segmentId: actionable.segmentId } : {}),
    });
  }

  // Saving a moment needs a transcript segment to point at.
  const cited = rows.find((r) => r.segmentId);
  if (cited?.segmentId) {
    out.push({
      action: 'save_moment',
      label: 'Save this moment',
      rationale: 'Keep a reference to the supporting transcript segment.',
      insightId: cited.insightId,
      segmentId: cited.segmentId,
    });
  }

  return out;
}

/**
 * Shape one client's relevance for one hearing.
 *
 * `rows` must already be scoped to this tenant and this client by the caller.
 */
export function buildClientRelevance(input: {
  clientId: string;
  clientName: string | null;
  hearingId: string;
  rows: RelevanceRow[];
  /** Whether a canonical transcript exists for this hearing. */
  hasTranscript: boolean;
}): ClientRelevanceResult {
  const { clientId, clientName, hearingId, hasTranscript } = input;
  // Highest score first: the top row is the one every downstream summary leads
  // with, and evidence should read strongest-first.
  const rows = [...input.rows].sort((a, b) => b.score - a.score);

  const score = rows.length ? Math.max(...rows.map((r) => r.score)) : null;
  let band = bandForScore(score);

  // The grounding rule: relevance whose evidence would be transcript-derived
  // cannot be asserted when there is no transcript to cite.
  const citesTranscript = rows.some((r) => r.segmentId || r.evidenceText);
  if (rows.length && !hasTranscript && citesTranscript) {
    band = 'INSUFFICIENT_EVIDENCE';
  }

  const evidence: RelevanceEvidence[] =
    band === 'INSUFFICIENT_EVIDENCE'
      ? []
      : rows.map((r) => ({
          insightId: r.insightId,
          insightType: r.insightType,
          title: r.insightTitle,
          summary: r.insightSummary,
          // Only cite a quote when the transcript that would back it exists.
          quote: hasTranscript ? r.evidenceText : null,
          speakerName: r.speakerName,
          segmentId: hasTranscript ? r.segmentId : null,
          startMs: hasTranscript ? r.startMs : null,
          endMs: hasTranscript ? r.endMs : null,
          timecode: hasTranscript ? timecode(r.startMs) : null,
          confidence: r.confidence,
          preliminary: r.preliminary,
        }));

  const matchedPriorities: MatchedPriority[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const p of extractMatchedPriorities(r.matchedOn)) {
      const key = p.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      matchedPriorities.push(p);
    }
  }

  const evaluatedAt = rows.length
    ? new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))).toISOString()
    : null;

  return {
    clientId,
    clientName,
    hearingId,
    band,
    score,
    whyItMatters: buildWhyItMatters(rows, band),
    matchedPriorities,
    evidence,
    implications: band === 'INSUFFICIENT_EVIDENCE' ? [] : buildImplications(rows),
    recommendedActions: buildRecommendedActions(rows, band),
    provenance: {
      hearingId,
      insightIds: evidence.map((e) => e.insightId),
      segmentIds: evidence
        .map((e) => e.segmentId)
        .filter((id): id is string => Boolean(id)),
      transcriptAvailable: hasTranscript,
      extractors: [...new Set(rows.map((r) => `${r.extractor}@${r.extractorVersion}`))],
      matchCount: rows.length,
    },
    evaluatedAt,
  };
}

/**
 * The All-Clients view: one result per tenant-authorized client, ranked.
 *
 * `authorizedClients` is the caller's own tenant-scoped client list, so a
 * client from another tenant cannot appear even if a stray relevance row named
 * it. Clients with no rows are still returned (band NONE) so the ranking is a
 * complete answer rather than a silently filtered one.
 */
export function buildAllClientsRelevance(input: {
  hearingId: string;
  authorizedClients: Array<{ id: string; name: string | null }>;
  rows: RelevanceRow[];
  hasTranscript: boolean;
}): ClientRelevanceResult[] {
  const authorized = new Map(input.authorizedClients.map((c) => [c.id, c.name]));
  const byClient = new Map<string, RelevanceRow[]>();
  for (const row of input.rows) {
    // Defence in depth: ignore any row naming a client this caller cannot see.
    if (!authorized.has(row.clientId)) continue;
    const list = byClient.get(row.clientId);
    if (list) list.push(row);
    else byClient.set(row.clientId, [row]);
  }

  const results = input.authorizedClients.map((client) =>
    buildClientRelevance({
      clientId: client.id,
      clientName: client.name,
      hearingId: input.hearingId,
      rows: byClient.get(client.id) ?? [],
      hasTranscript: input.hasTranscript,
    }),
  );

  const bandRank: Record<RelevanceBand, number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
    INSUFFICIENT_EVIDENCE: 3,
    NONE: 4,
  };

  return results.sort((a, b) => {
    if (bandRank[a.band] !== bandRank[b.band]) return bandRank[a.band] - bandRank[b.band];
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    return (a.clientName ?? a.clientId).localeCompare(b.clientName ?? b.clientId);
  });
}
