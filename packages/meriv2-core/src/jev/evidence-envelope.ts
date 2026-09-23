import type { MeriCitation } from '@capiro/shared';
import type { AssuredClaim, ClaimLedger } from '../assurance/claim-ledger';
import {
  evidenceEnvelopeSchema,
  hashEvidenceEnvelope,
  type EvidenceEnvelope,
} from './decision-contract';

const MAX_PASSAGE_CHARS = 2_000;
const MAX_TOTAL_CHARS = 96_000;

export interface EvidencePassage {
  text: string;
  locator?: string;
  documentId?: string;
  version?: string;
  sourceDate?: string;
  publishedAt?: string;
  effectiveAt?: string;
  retrievedAt?: string;
}

export interface BuildEvidenceEnvelopeInput {
  claim: AssuredClaim;
  ledger: ClaimLedger;
  citations: MeriCitation[];
  passages: Record<string, EvidencePassage>;
  tenantId: string;
  clientId?: string | null;
  asOf?: string | null;
  scopeQualifiers?: string[];
  /** Include ledger provenance on sources for opt-in Stage 4 question builders. */
  includeProvenance?: boolean;
}

export type JevEvidenceSource = Pick<
  EvidenceEnvelope['sources'][number],
  | 'evidenceId'
  | 'sourceType'
  | 'sourceId'
  | 'documentId'
  | 'version'
  | 'locator'
  | 'passage'
  | 'sourceDate'
  | 'retrievedAt'
> & {
  provenance?: EvidenceEnvelope['sources'][number]['provenance'];
};

export function envelopeSourcesForJev(
  envelope: EvidenceEnvelope,
  options: { includeProvenance: boolean },
): JevEvidenceSource[] {
  return envelope.sources.map((source) => ({
    evidenceId: source.evidenceId,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    documentId: source.documentId,
    version: source.version,
    locator: source.locator,
    passage: source.passage,
    sourceDate: source.sourceDate,
    retrievedAt: source.retrievedAt,
    ...(options.includeProvenance && source.provenance ? { provenance: source.provenance } : {}),
  }));
}

function truncateAtBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const prefix = text.slice(0, cap + 1);
  const boundary = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('! '), prefix.lastIndexOf('? '));
  return `${prefix.slice(0, boundary >= Math.floor(cap / 2) ? boundary + 1 : cap).trimEnd()}…`;
}

function deriveQualifiers(input: BuildEvidenceEnvelopeInput): string[] {
  const derived = [
    `category:${input.claim.category}`,
    input.asOf ?? input.claim.asOf ? `as-of:${input.asOf ?? input.claim.asOf}` : undefined,
  ];
  return [...new Set([...derived, ...(input.scopeQualifiers ?? [])].filter((x): x is string => typeof x === 'string' && Boolean(x.trim())))]
    .sort();
}

export function buildEvidenceEnvelope(
  input: BuildEvidenceEnvelopeInput,
): { envelope: EvidenceEnvelope; hash: string } {
  const referenced = new Set(input.claim.sourceIds);
  const evidenceById = new Map(input.ledger.evidence.map((item) => [item.id, item]));
  const citationById = new Map(input.citations.filter((item) => referenced.has(item.id)).map((item) => [item.id, item]));
  const droppedEvidenceIds: string[] = [];
  const truncatedEvidenceIds: string[] = [];
  let totalChars = 0;

  const sources: EvidenceEnvelope['sources'] = [];
  for (const evidenceId of [...referenced].sort()) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      droppedEvidenceIds.push(evidenceId);
      continue;
    }
    const citation = citationById.get(evidenceId);
    const passage = input.passages[evidenceId];
    const rawText = passage?.text ?? citation?.snippet ?? '';
    let text = truncateAtBoundary(rawText, MAX_PASSAGE_CHARS);
    if (text !== rawText) truncatedEvidenceIds.push(evidenceId);
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) {
      droppedEvidenceIds.push(evidenceId);
      continue;
    }
    if (text.length > remaining) {
      text = truncateAtBoundary(text, remaining);
      if (!truncatedEvidenceIds.includes(evidenceId)) truncatedEvidenceIds.push(evidenceId);
    }
    totalChars += text.length;
    sources.push({
      evidenceId,
      sourceType: evidence.sourceType,
      sourceId: evidence.sourceId,
      documentId: passage?.documentId ?? citation?.documentEvidence?.documentId ?? null,
      version: passage?.version ?? citation?.source?.version ?? null,
      locator: passage?.locator ?? citation?.source?.section ?? null,
      passage: text,
      sourceDate: passage?.sourceDate ?? evidence.asOf ?? null,
      publishedAt: passage?.publishedAt ?? evidence.publishedAt ?? null,
      effectiveAt: passage?.effectiveAt ?? evidence.effectiveAt ?? null,
      retrievedAt: passage?.retrievedAt ?? evidence.retrievedAt ?? citation?.source?.observedAt
        ?? citation?.documentEvidence?.observedAt ?? null,
      ...(input.includeProvenance
        ? {
            provenance: {
              evidenceClass: evidence.evidenceClass,
              primary: evidence.primary,
              authoritative: evidence.authoritative,
            },
          }
        : {}),
    });
  }

  const changed = droppedEvidenceIds.length > 0 || truncatedEvidenceIds.length > 0;
  const envelope = evidenceEnvelopeSchema.parse({
    envelopeVersion: 'meri-evidence-envelope-v1',
    claimId: input.claim.id,
    claimText: input.claim.text,
    claimKind: input.claim.type,
    claimCategory: input.claim.category,
    tenantId: input.tenantId,
    clientId: input.clientId ?? null,
    scopeQualifiers: deriveQualifiers(input),
    asOf: input.asOf ?? input.claim.asOf ?? null,
    sources,
    ...(changed
      ? {
          truncation: {
            truncated: true,
            originalSourceCount: referenced.size,
            includedSourceCount: sources.length,
            reason: droppedEvidenceIds.length ? 'overall_limit' : 'per_source_limit',
            droppedEvidenceIds,
            truncatedEvidenceIds,
            estimatedTokens: Math.ceil(totalChars / 4),
          },
        }
      : {}),
  }) as EvidenceEnvelope;
  return { envelope, hash: hashEvidenceEnvelope(envelope) };
}
