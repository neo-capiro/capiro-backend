import { createHash } from 'node:crypto';
import type { ClaimCategory, DomainEvidencePlan, EvidenceClass } from './evidence-plan';

export type AssuredClaimType = 'fact' | 'inference' | 'recommendation' | 'uncertainty';
export type AssuredConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface AssuredEvidence {
  id: string;
  sourceType: string;
  sourceId: string;
  evidenceClass: EvidenceClass;
  title?: string;
  url?: string;
  asOf?: string;
  retrievedAt?: string;
  primary: boolean;
  authoritative: boolean;
  requirementIds: string[];
  /** Coverage metadata is mandatory before this evidence can support absence/exhaustive claims. */
  coverage?: {
    description: string;
    complete: boolean;
    truncated: boolean;
    failedSources: string[];
  };
  /** Hash of the bounded source span or structured record used, never a secret body. */
  contentHash?: string;
}

export interface AssuredClaim {
  id: string;
  text: string;
  type: AssuredClaimType;
  category: ClaimCategory | string;
  sourceIds: string[];
  primarySourcePresent: boolean;
  asOf?: string;
  confidence: AssuredConfidence;
  conflict?: string;
  unsupportedReason?: string;
}

export interface ClaimCandidate {
  id?: string;
  text: string;
  type: AssuredClaimType;
  category: ClaimCategory | string;
  sourceIds?: readonly string[];
  asOf?: string;
  confidence?: AssuredConfidence;
  conflict?: string;
}

export interface ClaimLedger {
  version: 'ga-claim-ledger-v1';
  claims: AssuredClaim[];
  evidence: AssuredEvidence[];
  unsupportedClaimIds: string[];
  conflictedClaimIds: string[];
  highRiskUnsupportedClaimIds: string[];
  requiredEvidenceGaps: string[];
  hash: string;
}

export interface ClaimLedgerOptions {
  plan?: DomainEvidencePlan;
  highRiskCategories?: readonly string[];
}

const DEFAULT_HIGH_RISK_CATEGORIES = new Set<string>([
  'bill_status',
  'member_vote',
  'current_role',
  'budget_amount',
  'budget_delta',
  'enactment',
  'report_language',
  'regulatory_deadline',
  'regulatory_stage',
  'district_representation',
  'grant_award',
  'client_recommendation',
  'negative_or_exhaustive',
]);

/**
 * Resolve draft/extracted claims against real ledger evidence. Fluent prose has
 * no authority: a source id must resolve to evidence and factual claims need an
 * authoritative source. Inference/recommendation claims may be supported by
 * facts but remain visibly non-factual claim types.
 */
export function buildAssuredClaimLedger(
  candidates: readonly ClaimCandidate[],
  evidenceInput: readonly AssuredEvidence[],
  options: ClaimLedgerOptions = {},
): ClaimLedger {
  const evidence = normalizeEvidence(evidenceInput);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const highRisk = new Set(options.highRiskCategories ?? DEFAULT_HIGH_RISK_CATEGORIES);
  const claims = candidates
    .map((candidate, index) => normalizeCandidate(candidate, index, evidenceById))
    .filter((claim): claim is AssuredClaim => claim !== null);

  const unsupportedClaimIds = claims.filter((claim) => claim.unsupportedReason).map((claim) => claim.id);
  const conflictedClaimIds = claims.filter((claim) => claim.conflict).map((claim) => claim.id);
  const highRiskUnsupportedClaimIds = claims
    .filter((claim) => claim.unsupportedReason && highRisk.has(claim.category))
    .map((claim) => claim.id);
  const requiredEvidenceGaps = options.plan
    ? options.plan.requiredRequirementIds.filter(
        (requirementId) =>
          !evidence.some(
            (item) => item.authoritative && item.requirementIds.includes(requirementId),
          ),
      )
    : [];

  const core = {
    version: 'ga-claim-ledger-v1' as const,
    claims,
    evidence,
    unsupportedClaimIds,
    conflictedClaimIds,
    highRiskUnsupportedClaimIds,
    requiredEvidenceGaps,
  };
  return { ...core, hash: sha256(stableStringify(core)) };
}

/**
 * Pre-release repair policy. Unsupported facts are removed. Unsupported
 * inferences/recommendations are preserved only as explicit uncertainty when a
 * caller opts into a bounded caveat; they never silently become facts.
 */
export function repairClaimsForRelease(
  ledger: ClaimLedger,
  options: { preserveUnsupportedAdviceAsUncertainty?: boolean } = {},
): { claims: AssuredClaim[]; removedClaimIds: string[]; rewrittenClaimIds: string[] } {
  const claims: AssuredClaim[] = [];
  const removedClaimIds: string[] = [];
  const rewrittenClaimIds: string[] = [];
  for (const claim of ledger.claims) {
    if (!claim.unsupportedReason && !claim.conflict) {
      claims.push(claim);
      continue;
    }
    if (
      options.preserveUnsupportedAdviceAsUncertainty &&
      (claim.type === 'inference' || claim.type === 'recommendation') &&
      !claim.conflict
    ) {
      claims.push({
        ...claim,
        type: 'uncertainty',
        confidence: 'unknown',
        text: `Unverified possibility: ${claim.text}`,
      });
      rewrittenClaimIds.push(claim.id);
      continue;
    }
    removedClaimIds.push(claim.id);
  }
  return { claims, removedClaimIds, rewrittenClaimIds };
}

export function claimLedgerReleaseable(ledger: ClaimLedger): boolean {
  return (
    ledger.highRiskUnsupportedClaimIds.length === 0 &&
    ledger.conflictedClaimIds.length === 0 &&
    ledger.requiredEvidenceGaps.length === 0
  );
}

export function evidenceSupportsNegativeClaim(evidence: readonly AssuredEvidence[]): boolean {
  return evidence.some(
    (item) =>
      item.authoritative &&
      item.coverage?.complete === true &&
      item.coverage.truncated === false &&
      item.coverage.failedSources.length === 0,
  );
}

function normalizeCandidate(
  candidate: ClaimCandidate,
  index: number,
  evidenceById: ReadonlyMap<string, AssuredEvidence>,
): AssuredClaim | null {
  const text = String(candidate.text ?? '').trim();
  if (!text) return null;
  const sourceIds = orderedUnique(
    (candidate.sourceIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const resolved = sourceIds.map((id) => evidenceById.get(id)).filter(isDefined);
  const unresolvedCount = sourceIds.length - resolved.length;
  const category = String(candidate.category || 'general_background');
  const requiresCoverage = category === 'negative_or_exhaustive';
  let unsupportedReason: string | undefined;

  if (candidate.type === 'fact') {
    if (!resolved.length) unsupportedReason = 'No cited evidence resolves for this factual claim.';
    else if (!resolved.some((item) => item.authoritative)) {
      unsupportedReason = 'The cited material is not authoritative enough to support this factual claim.';
    } else if (unresolvedCount > 0) {
      unsupportedReason = 'One or more cited evidence identifiers do not resolve.';
    } else if (requiresCoverage && !evidenceSupportsNegativeClaim(resolved)) {
      unsupportedReason =
        'This absence or exhaustive claim lacks complete, non-truncated source coverage.';
    }
  } else if (candidate.type === 'inference' || candidate.type === 'recommendation') {
    if (!resolved.length) unsupportedReason = 'No evidence basis resolves for this analytical claim.';
    else if (unresolvedCount > 0) unsupportedReason = 'One or more evidence identifiers do not resolve.';
  }

  const primarySourcePresent = resolved.some((item) => item.primary && item.authoritative);
  const confidence = calibratedConfidence(
    candidate.confidence,
    candidate.type,
    resolved,
    unsupportedReason,
    candidate.conflict,
  );
  return {
    id: candidate.id?.trim() || `claim-${index + 1}-${sha256(text).slice(0, 10)}`,
    text,
    type: candidate.type,
    category,
    sourceIds,
    primarySourcePresent,
    ...(candidate.asOf ? { asOf: safeIso(candidate.asOf) } : latestAsOf(resolved) ? { asOf: latestAsOf(resolved)! } : {}),
    confidence,
    ...(candidate.conflict ? { conflict: bounded(candidate.conflict, 500) } : {}),
    ...(unsupportedReason ? { unsupportedReason } : {}),
  };
}

function normalizeEvidence(input: readonly AssuredEvidence[]): AssuredEvidence[] {
  const byId = new Map<string, AssuredEvidence>();
  for (const raw of input) {
    const id = String(raw.id ?? '').trim();
    const sourceId = String(raw.sourceId ?? '').trim();
    const sourceType = String(raw.sourceType ?? '').trim();
    if (!id || !sourceId || !sourceType || byId.has(id)) continue;
    byId.set(id, {
      id,
      sourceId,
      sourceType,
      evidenceClass: raw.evidenceClass,
      ...(raw.title ? { title: bounded(raw.title, 300) } : {}),
      ...(raw.url ? { url: bounded(raw.url, 1000) } : {}),
      ...(raw.asOf ? { asOf: safeIso(raw.asOf) } : {}),
      ...(raw.retrievedAt ? { retrievedAt: safeIso(raw.retrievedAt) } : {}),
      primary: raw.primary === true,
      authoritative: raw.authoritative === true,
      requirementIds: orderedUnique(raw.requirementIds ?? []),
      ...(raw.coverage
        ? {
            coverage: {
              description: bounded(raw.coverage.description, 500),
              complete: raw.coverage.complete === true,
              truncated: raw.coverage.truncated === true,
              failedSources: orderedUnique(raw.coverage.failedSources ?? []).map((value) => bounded(value, 160)),
            },
          }
        : {}),
      ...(raw.contentHash ? { contentHash: bounded(raw.contentHash, 128) } : {}),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function calibratedConfidence(
  requested: AssuredConfidence | undefined,
  type: AssuredClaimType,
  evidence: readonly AssuredEvidence[],
  unsupportedReason?: string,
  conflict?: string,
): AssuredConfidence {
  if (unsupportedReason || conflict) return 'unknown';
  if (type === 'uncertainty') return 'unknown';
  const authoritative = evidence.filter((item) => item.authoritative);
  const primary = authoritative.filter((item) => item.primary);
  const ceiling: AssuredConfidence = primary.length ? 'high' : authoritative.length ? 'medium' : 'low';
  return lowerConfidence(requested ?? ceiling, ceiling);
}

function lowerConfidence(a: AssuredConfidence, ceiling: AssuredConfidence): AssuredConfidence {
  const rank: Record<AssuredConfidence, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
  return rank[a] <= rank[ceiling] ? a : ceiling;
}

function latestAsOf(evidence: readonly AssuredEvidence[]): string | undefined {
  const values = evidence
    .map((item) => item.asOf)
    .filter((value): value is string => Boolean(value))
    .sort();
  return values[values.length - 1];
}

function safeIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function bounded(value: string, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function orderedUnique<T>(values: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
