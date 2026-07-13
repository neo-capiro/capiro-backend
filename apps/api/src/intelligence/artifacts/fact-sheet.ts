/**
 * Step 3.3 — deterministic FactSheet builder (plan §18). PURE: no DB, no LLM, no
 * NestJS. Turns an action card into the closed set of {@link Claim}s an artifact is
 * allowed to assert.
 *
 * Two claim sources, in stable order so ids (c1, c2, ...) are reproducible:
 *   1. one claim per {@link EvidenceRef} on the card (provenance-backed); and
 *   2. one claim per distinct numeric figure found in `whatChanged` /
 *      `recommendedAction` (the numbers a one-pager/memo will quote), each tied to
 *      the first evidence ref as its source (or a `narrative` ref when the card has
 *      no evidence).
 *
 * The generator hands this fact sheet to the LLM as the ONLY material it may cite,
 * and the verifier checks every generated numeral against these claims' `value` /
 * `claimText`. So the fact sheet is the grounding contract end-to-end.
 */
import type { EvidenceRef } from '../actions/action-recommendation.types.js';
import type { Claim, ClaimSourceRef, FactSheet } from './artifact-types.js';

/** The slice of an action card the builder reads. Structurally satisfied by ActionCard. */
export interface FactSheetCard {
  issueTitle: string;
  whatChanged: string;
  whyItMatters: string;
  recommendedAction: string;
  evidence: EvidenceRef[];
  uncertainty?: string | null;
}

/**
 * Matches dollar / numeric figures a lobbyist artifact would quote:
 *   $120M, $1.2B, $477,000, $120 million, 12%, FY2026, 0604123A-style codes excluded.
 * Captures the whole token (incl. leading $, trailing %/unit word) so the verifier
 * can compare like-for-like. Order-preserving, de-duplicated downstream.
 */
const FIGURE_RE = /\$?\d[\d,]*(?:\.\d+)?(?:\s?(?:billion|million|thousand|B|M|K)\b|%)?/gi;

/** Human label for an evidence ref, used as the claim's source note + appendix line. */
function describeEvidence(ref: EvidenceRef): string {
  if (ref.note && ref.note.trim()) return ref.note.trim();
  switch (ref.kind) {
    case 'source': {
      const doc = ref.sourceDocumentId ? `source ${ref.sourceDocumentId}` : 'source document';
      return ref.page != null ? `${doc} p.${ref.page}` : doc;
    }
    case 'delta':
      return ref.deltaId ? `funding delta ${ref.deltaId}` : 'funding delta';
    case 'provision':
      return ref.provisionId ? `report provision ${ref.provisionId}` : 'report provision';
    case 'opportunity':
      return ref.opportunityId
        ? `procurement opportunity ${ref.opportunityId}`
        : 'procurement opportunity';
    default:
      return 'evidence';
  }
}

/** Project an EvidenceRef into the claim's ClaimSourceRef (same vocabulary).
 *  G5: the derived 'program_match' kind (a PE↔program inference, not a primary
 *  source) has no ClaimSourceRef equivalent, so it maps to 'narrative'. */
function toSourceRef(ref: EvidenceRef): ClaimSourceRef {
  return {
    kind: ref.kind === 'program_match' ? 'narrative' : ref.kind,
    sourceDocumentId: ref.sourceDocumentId,
    page: ref.page,
    deltaId: ref.deltaId,
    provisionId: ref.provisionId,
    opportunityId: ref.opportunityId,
    note: ref.note,
  };
}

/**
 * Extract distinct numeric figures from text, preserving first-seen order. A figure
 * like "$120M" appearing in both whatChanged and recommendedAction yields ONE claim.
 */
function extractFigures(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.match(FIGURE_RE) ?? [];
  for (const raw of matches) {
    const token = raw.trim();
    // Drop bare single digits that are almost never load-bearing figures (e.g. "1
    // committee") but keep $-prefixed, %-suffixed, or multi-digit/decimal values.
    const isBareSmall = /^\d$/.test(token);
    if (isBareSmall) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

/**
 * Build the FactSheet for a card. Deterministic: same card -> same claims/ids.
 *
 * Claim ordering (stable): evidence refs first (c1..cN in array order), then each
 * distinct figure from `whatChanged` followed by `recommendedAction`. Figures are
 * de-duplicated against figures already captured by an evidence-claim's value AND
 * against each other, so the same number is never double-claimed.
 */
export function buildFactSheet(card: FactSheetCard): FactSheet {
  const claims: Claim[] = [];
  let n = 0;
  const nextId = () => `c${++n}`;
  const claimedFigures = new Set<string>();

  // 1) One claim per evidence ref. The claim text anchors on the issue title so it
  //    reads as an assertion; any figure embedded in the note is recorded as `value`.
  for (const ref of card.evidence ?? []) {
    const label = describeEvidence(ref);
    const figureInNote = extractFigures(ref.note ?? '')[0];
    if (figureInNote) claimedFigures.add(figureInNote.toLowerCase());
    claims.push({
      id: nextId(),
      claimText: ref.note?.trim()
        ? `${card.issueTitle}: ${ref.note.trim()}`
        : `${card.issueTitle} (per ${label}).`,
      value: figureInNote,
      sourceRef: toSourceRef(ref),
    });
  }

  // The source ref figures point back to: the first evidence ref, or a synthetic
  // `narrative` ref when the card carries no evidence at all.
  const firstEvidence = (card.evidence ?? [])[0];
  const figureSourceRef: ClaimSourceRef = firstEvidence
    ? toSourceRef(firstEvidence)
    : { kind: 'narrative', note: card.issueTitle };

  // 2) One claim per distinct numeric figure in the narrative fields. whatChanged
  //    first (the factual change), then recommendedAction (the ask).
  const narrativeFigures = [
    ...extractFigures(card.whatChanged ?? ''),
    ...extractFigures(card.recommendedAction ?? ''),
  ];
  for (const figure of narrativeFigures) {
    const key = figure.toLowerCase();
    if (claimedFigures.has(key)) continue;
    claimedFigures.add(key);
    const inWhatChanged = (card.whatChanged ?? '').includes(figure);
    claims.push({
      id: nextId(),
      claimText: inWhatChanged
        ? `${card.issueTitle}: ${figure} (${card.whatChanged.trim()})`
        : `Recommended action references ${figure}: ${card.recommendedAction.trim()}`,
      value: figure,
      sourceRef: figureSourceRef,
    });
  }

  return { claims };
}

/** Render a single claim's source ref as a short human citation for the appendix. */
export function citeClaim(claim: Claim): string {
  return describeSourceRef(claim.sourceRef);
}

/** Human citation for a ClaimSourceRef (used by the generator's Sources appendix). */
export function describeSourceRef(ref: ClaimSourceRef): string {
  if (ref.note && ref.note.trim() && ref.kind === 'narrative') return ref.note.trim();
  switch (ref.kind) {
    case 'source': {
      const doc = ref.sourceDocumentId ? ref.sourceDocumentId : 'source';
      return ref.page != null ? `${doc} p.${ref.page}` : doc;
    }
    case 'delta':
      return ref.deltaId ? `funding delta ${ref.deltaId}` : 'funding delta';
    case 'provision':
      return ref.provisionId ? `report provision ${ref.provisionId}` : 'report provision';
    case 'opportunity':
      return ref.opportunityId ? `opportunity ${ref.opportunityId}` : 'procurement opportunity';
    case 'narrative':
      return ref.note?.trim() || 'analyst narrative';
    default:
      return 'source';
  }
}
