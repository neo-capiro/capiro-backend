import type { AssuredClaim } from '../assurance/claim-ledger';
import { buildClaimSupportQuestion } from '../jev/claim-support-question';
import type { DecisionProvider, EvidenceEnvelope } from '../jev/decision-contract';
import { splitSentences } from './revise';
import type { RecheckResult, RepairLedgerVersion } from './types';

export interface RecheckInput {
  revisedClaim: AssuredClaim;
  originalAffectedText: string;
  replacementText: string;
  ledger: RepairLedgerVersion;
  provider: DecisionProvider;
  tenantId: string;
  clientId?: string | null;
  scopeQualifiers?: string[];
  signal?: AbortSignal;
  deadlineAt?: number;
}

export async function recheckRevision(input: RecheckInput): Promise<RecheckResult> {
  const claims = [input.revisedClaim, ...extractNewMaterialClaims(input)];
  const decisions: RecheckResult['decisions'] = [];
  for (const claim of claims) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('cancelled');
    const envelope = envelopeFor(claim, input);
    const decision = await input.provider.assess(envelope, buildClaimSupportQuestion(envelope), {
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    });
    decisions.push({ claim, envelope, decision });
  }
  const unresolvedClaims = decisions
    .filter(({ decision }) => decision.kind === 'failure' || decision.outcome !== 'supported')
    .map(({ claim }) => claim);
  return { supported: unresolvedClaims.length === 0, decisions, unresolvedClaims };
}

/** Minimal fallback until S1-A lands: sentence-level factual-looking additions only. */
export function extractNewMaterialClaims(
  input: Pick<RecheckInput, 'originalAffectedText' | 'replacementText' | 'revisedClaim'>,
): AssuredClaim[] {
  const original = new Set(splitSentences(input.originalAffectedText));
  return splitSentences(input.replacementText)
    .filter((sentence) => sentence !== input.revisedClaim.text && !original.has(sentence))
    .filter((sentence) => /\b(?:\d|is|are|was|were|will|has|have|on|as of)\b/i.test(sentence))
    .map((text, index) => ({
      ...input.revisedClaim,
      id: `${input.revisedClaim.id}:new:${index + 1}`,
      text,
    }));
}

function envelopeFor(claim: AssuredClaim, input: RecheckInput): EvidenceEnvelope {
  const evidence = new Map(input.ledger.ledger.evidence.map((item) => [item.id, item]));
  return {
    envelopeVersion: 'meri-evidence-envelope-v1',
    claimId: claim.id,
    claimText: claim.text,
    claimKind: claim.type,
    claimCategory: claim.category,
    tenantId: input.tenantId,
    clientId: input.clientId ?? null,
    scopeQualifiers: [
      ...new Set([`category:${claim.category}`, ...(input.scopeQualifiers ?? [])]),
    ].sort(),
    asOf: claim.asOf ?? null,
    sources: claim.sourceIds.flatMap((id) => {
      const item = evidence.get(id);
      if (!item) return [];
      return [
        {
          evidenceId: id,
          sourceType: item.evidenceClass,
          sourceId: item.sourceId,
          documentId: null,
          version: null,
          locator: null,
          passage: input.ledger.passages[id] ?? '',
          sourceDate: item.asOf ?? null,
          publishedAt: item.publishedAt ?? null,
          effectiveAt: item.effectiveAt ?? null,
          retrievedAt: item.retrievedAt ?? null,
        },
      ];
    }),
  };
}

export function proportionalFallback(claim: AssuredClaim): 'qualified' | 'omitted' {
  return /(?:\$|\b\d[\d,.]*%?|\b(?:19|20)\d{2}\b|\b(?:section|page)\s+\d+)/i.test(claim.text)
    ? 'omitted'
    : 'qualified';
}

export function limitationSentence(
  claim: AssuredClaim,
  reason = 'the available evidence does not resolve it',
): string {
  return `Evidence limitation for “${claim.text.replace(/[.!?]+$/, '')}”: ${reason}.`;
}
