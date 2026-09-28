import type { AssuredClaim } from '../assurance/claim-ledger';
import type { RepairEvidence } from './types';

export interface RevisionGenerationInput {
  affectedText: string;
  claim: AssuredClaim;
  dependentSentences: string[];
  evidence: RepairEvidence[];
  allowedEvidenceIds: string[];
}

export interface RevisionGenerationResult {
  replacementText: string;
  citedEvidenceIds: string[];
  /** Token usage of the revision model call, when the generator can report it. */
  usage?: { inputTokens: number; outputTokens: number };
}

export type RevisionGenerator = (
  input: RevisionGenerationInput,
  options: { signal?: AbortSignal },
) => Promise<RevisionGenerationResult>;

export interface ReviseAffectedClaimInput {
  reply: string;
  claim: AssuredClaim;
  dependents?: string[];
  evidence: RepairEvidence[];
  ledgerEvidenceIds: ReadonlySet<string>;
  generate: RevisionGenerator;
  signal?: AbortSignal;
}

export async function reviseAffectedClaim(
  input: ReviseAffectedClaimInput,
): Promise<RevisionGenerationResult & { affectedText: string; dependentSentences: string[] }> {
  throwIfAborted(input.signal);
  const dependentSentences = input.dependents ?? findDependentSentences(input.reply, input.claim);
  const affectedText = [input.claim.text, ...dependentSentences].join(' ');
  const allowedEvidenceIds = input.evidence
    .map((item) => item.id)
    .filter((id) => input.ledgerEvidenceIds.has(id));
  const result = await input.generate(
    {
      affectedText,
      claim: input.claim,
      dependentSentences,
      evidence: input.evidence,
      allowedEvidenceIds,
    },
    { signal: input.signal },
  );
  throwIfAborted(input.signal);
  if (!result.replacementText.trim()) throw new Error('revision_empty');
  if (result.citedEvidenceIds.some((id) => !allowedEvidenceIds.includes(id))) {
    throw new Error('revision_cites_unknown_evidence');
  }
  return { ...result, affectedText, dependentSentences };
}

/**
 * Deterministic dependency heuristic: only later sentences in the claim's paragraph
 * that repeat a capitalized entity token or a numeric token from the claim are revised.
 */
export function findDependentSentences(reply: string, claim: AssuredClaim): string[] {
  const paragraph = reply.split(/\n\s*\n/).find((item) => item.includes(claim.text));
  if (!paragraph) return [];
  const sentences = splitSentences(paragraph);
  const claimIndex = sentences.findIndex((sentence) => sentence.includes(claim.text));
  if (claimIndex < 0) return [];
  const anchors = new Set(claim.text.match(/\b(?:[A-Z][\w.-]+|\d[\d,.%$-]*)\b/g) ?? []);
  return sentences
    .slice(claimIndex + 1)
    .filter((sentence) => [...anchors].some((anchor) => sentence.includes(anchor)));
}

export function splitSentences(text: string): string[] {
  return (
    text
      .match(/[^.!?]+(?:[.!?]+|$)/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? []
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('cancelled');
}
