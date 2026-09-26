import { evidenceSupportsNegativeClaim, type AssuredEvidence } from '../assurance/claim-ledger';

/** Exact strings observed in the official Marketplace payload or documented changelog. */
export const FEDRAMP_STATUS_VOCABULARY = [
  'Agency Authorization In Process',
  'FedRAMP Certified',
  'FedRAMP Certified (In Remediation)',
  'FedRAMP In Process',
  'Initial Implementation',
  'Legacy FedRAMP Ready',
  'Unknown',
] as const;

export const FEDRAMP_IMPACT_LEVEL_VOCABULARY = [
  'High',
  'LI-SaaS',
  'Low',
  'Moderate',
  'Unknown',
] as const;

export interface DetectedStatusClaim {
  entityMention: string;
  statedStatus: string | null;
  statedImpactLevel: string | null;
  negative: boolean;
  span: string;
}

export type StatusCheckOutcome =
  | 'exact'
  | 'paraphrased'
  | 'mismatch'
  | 'unsupported'
  | 'negative_unsupported';

export interface CertificationStatusEvidence {
  entityId: string;
  entityNames?: readonly string[];
  status: string;
  impactLevel?: string | null;
  sourceUrl: string;
  observedAt: string;
  authoritative: boolean;
  primary: boolean;
  selfReported?: boolean;
  coverage?: AssuredEvidence['coverage'];
}

export interface CheckedStatusClaim {
  claim: DetectedStatusClaim;
  outcome: StatusCheckOutcome;
  evidence: CertificationStatusEvidence | null;
}

const PARAPHRASED_STATUS: Readonly<Record<string, string>> = {
  'fedramp approved': 'FedRAMP Certified',
  'fedramp authorized': 'FedRAMP Certified',
  'fedramp certified': 'FedRAMP Certified',
  'fedramp pending': 'FedRAMP In Process',
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STATUS_PATTERN = [...FEDRAMP_STATUS_VOCABULARY]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegex)
  .join('|');
const IMPACT_PATTERN = [...FEDRAMP_IMPACT_LEVEL_VOCABULARY]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegex)
  .join('|');
const PARAPHRASE_PATTERN = Object.keys(PARAPHRASED_STATUS).map(escapeRegex).join('|');

function entityFromSpan(span: string): string {
  const before = span.split(/\b(?:is|has|holds|remains|was|appears|shows)\b/i)[0] ?? '';
  const cleaned = before
    .replace(/^[\s>*#\-–—]+/, '')
    .replace(/\b(?:according to|currently|the)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'unspecified entity';
}

/** Detect bounded FedRAMP status statements without treating the word FedRAMP alone as a claim. */
export function detectFedrampStatusClaims(reply: string): DetectedStatusClaim[] {
  const sentences = reply.match(/[^.!?\n]+(?:[.!?]|$)/g) ?? [];
  const claims: DetectedStatusClaim[] = [];
  // A single sentence can contain claims about different products. Split only
  // at a comma followed by a contrast/conjunction marker so each status and
  // negation stays attached to its own bounded clause.
  const clauses = sentences.flatMap((sentence) => sentence
    .split(/,\s*(?=(?:but|however|while|whereas|and)\b)/i)
    .map((clause) => clause.replace(/^\s*(?:but|however|while|whereas|and)\s+/i, '').trim()));
  for (const span of clauses) {
    if (!/\bfedramp\b/i.test(span)) continue;
    const noMatchEntity = span.match(/^no\s+fedramp\s+(?:authorization|certification|status)(?:\s+was)?\s+found\s+for\s+(.+?)[.!?]?$/i)?.[1]?.trim();
    const negative = Boolean(noMatchEntity) || /\b(?:not\s+fedramp\s+(?:authorized|approved|certified)|(?:is|are|was|were|has|have)\s+not\s+(?:authorized|approved|certified)\s+by\s+fedramp|(?:has|have)\s+no\s+fedramp\s+(?:authorization|certification|status))\b/i.test(span);
    const status = negative ? null
      : span.match(new RegExp(`\\b(${STATUS_PATTERN}|${PARAPHRASE_PATTERN})(?!\\w)`, 'i'))?.[1] ?? null;
    const impact = span.match(new RegExp(`\\b(${IMPACT_PATTERN})\\b`, 'i'))?.[1] ?? null;
    if (!negative && !status && !impact) continue;
    claims.push({
      entityMention: noMatchEntity || entityFromSpan(span),
      statedStatus: status,
      statedImpactLevel: impact,
      negative,
      span,
    });
  }
  return claims;
}

function usableEvidence(evidence: CertificationStatusEvidence): boolean {
  return evidence.authoritative && evidence.primary && evidence.selfReported !== true;
}

function matchesEntity(claim: DetectedStatusClaim, evidence: CertificationStatusEvidence): boolean {
  const mention = claim.entityMention.toLocaleLowerCase();
  return [evidence.entityId, ...(evidence.entityNames ?? [])].some((name) => {
    const normalized = name.toLocaleLowerCase();
    return mention.includes(normalized) || normalized.includes(mention);
  });
}

function supportsNegative(evidence: CertificationStatusEvidence): boolean {
  return evidenceSupportsNegativeClaim([
    {
      id: evidence.entityId,
      sourceType: 'get_certification_status',
      sourceId: evidence.entityId,
      authoritative: evidence.authoritative,
      primary: evidence.primary,
      evidenceClass: 'official_government_data',
      requirementIds: [],
      coverage: evidence.coverage,
    },
  ]);
}

/** Compare detected wording with authoritative, non-self-reported status evidence. */
export function checkFedrampStatusClaims(
  claims: readonly DetectedStatusClaim[],
  evidence: readonly CertificationStatusEvidence[],
): CheckedStatusClaim[] {
  return claims.map((claim) => {
    const match = evidence.find((item) => usableEvidence(item) && matchesEntity(claim, item)) ?? null;
    if (claim.negative) {
      return { claim, evidence: match, outcome: match && supportsNegative(match) ? 'exact' : 'negative_unsupported' };
    }
    if (!match) return { claim, evidence: null, outcome: 'unsupported' };
    const statusExact = claim.statedStatus === match.status;
    const impactExact = claim.statedImpactLevel == null || claim.statedImpactLevel === match.impactLevel;
    if (statusExact && impactExact) return { claim, evidence: match, outcome: 'exact' };
    const normalized = claim.statedStatus?.toLocaleLowerCase() ?? '';
    if (PARAPHRASED_STATUS[normalized] === match.status && impactExact) {
      return { claim, evidence: match, outcome: 'paraphrased' };
    }
    return { claim, evidence: match, outcome: 'mismatch' };
  });
}

/** Deterministic repair through the existing single-text-frame assembly path. */
export function enforceFedrampStatusReply(
  reply: string,
  checked: readonly CheckedStatusClaim[],
): string {
  let enforced = reply;
  for (const item of checked) {
    if (item.outcome === 'exact') continue;
    const { claim, evidence } = item;
    let replacement: string;
    if (item.outcome === 'negative_unsupported') {
      if (evidence && evidence.status !== 'not found') {
        const impact = evidence.impactLevel ? ` at ${evidence.impactLevel} impact` : '';
        replacement = `${claim.entityMention} has a FedRAMP Marketplace record reporting ${evidence.status}${impact} (observed ${evidence.observedAt}); the negative authorization claim was not verified.`;
      } else {
        replacement = `${claim.entityMention}'s FedRAMP authorization status is unverified; complete-dataset coverage was not established.`;
      }
    } else if (item.outcome === 'unsupported' || !evidence) {
      replacement = `${claim.entityMention}'s FedRAMP status could not be verified from available marketplace evidence.`;
    } else {
      const impact = evidence.impactLevel ? ` at ${evidence.impactLevel} impact` : '';
      replacement = `${claim.entityMention} is ${evidence.status}${impact} (FedRAMP Marketplace, observed ${evidence.observedAt}).`;
    }
    enforced = enforced.replace(claim.span, replacement);
  }
  return enforced;
}
