import type { AuditFinding } from '../grounding/auditor';
import type { ClaimLedger } from './claim-ledger';
import type { DomainEvidencePlan } from './evidence-plan';
import { buildAssuranceEnvelope, type AssuranceEnvelope } from './envelope';
import { emitAssuranceGateControlMetrics } from './control-metrics';
import { currentAssuranceRequestScope } from './request-scope';

export type AssuranceSurface =
  | 'chat'
  | 'in-editor'
  | 'workspace-gen'
  | 'strategy'
  | 'research'
  | 'outreach'
  | 'memo'
  | 'district-brief'
  | 'steward';

export const ASSURANCE_SURFACES: readonly AssuranceSurface[] = [
  'chat',
  'in-editor',
  'workspace-gen',
  'strategy',
  'research',
  'outreach',
  'memo',
  'district-brief',
  'steward',
];

export type AssuranceRiskLevel = 'low' | 'moderate' | 'high' | 'restricted';
export type AssuranceReleaseDecision = 'deliver' | 'deliver_with_flags' | 'repair' | 'hold';
export type AssuranceReleaseMode = 'off' | 'shadow' | 'enforce';

/**
 * Backward-compatible chat resolver. Phase 16 requires all three controls even
 * for this legacy no-tenant call: global mode, `all` tenants, and the chat
 * surface. Tenant-specific canaries use resolveAssuranceRolloutMode at call sites
 * that possess the server-resolved tenant id.
 */
export function resolveAssuranceReleaseMode(
  raw: string | undefined,
  tenantCanariesRaw: string | undefined = process.env.MERI_RELEASE_GATE_TENANTS,
  surfacesRaw: string | undefined = process.env.MERI_RELEASE_GATE_SURFACES,
): AssuranceReleaseMode {
  const mode = normalize(raw);
  if (mode !== 'shadow' && mode !== 'enforce') return 'off';
  const tenants = tokens(tenantCanariesRaw);
  const surfaces = tokens(surfacesRaw);
  if (!tenants.includes('all')) return 'off';
  if (!surfaces.includes('all') && !surfaces.includes('chat')) return 'off';
  return mode;
}

export function resolveAssuranceReleaseSurfaces(
  raw: string | undefined,
): ReadonlySet<AssuranceSurface> {
  const parsed = tokens(raw);
  if (!parsed.length) return new Set<AssuranceSurface>();
  if (parsed.includes('all')) return new Set<AssuranceSurface>(ASSURANCE_SURFACES);
  const known = new Set<string>(ASSURANCE_SURFACES);
  return new Set<AssuranceSurface>(
    parsed.filter((token): token is AssuranceSurface => known.has(token)),
  );
}

/**
 * Backward-compatible surface resolver.
 *
 * When an authenticated server boundary establishes an AssuranceRequestScope,
 * this helper uses the exact tenant and actual artifact surface from that scope.
 * This keeps legacy call sites source-compatible without widening a one-tenant or
 * one-surface canary. With no request scope it retains the strict legacy rule:
 * only an explicit all-tenant canary may arm it.
 */
export function assuranceReleaseArmedFor(
  raw: string | undefined,
  surface: AssuranceSurface,
  globalModeRaw: string | undefined = process.env.MERI_RELEASE_GATE,
  tenantCanariesRaw: string | undefined = process.env.MERI_RELEASE_GATE_TENANTS,
): boolean {
  const scoped = currentAssuranceRequestScope();
  if (scoped) {
    const tenants = tokens(tenantCanariesRaw);
    return (
      normalize(globalModeRaw) === 'enforce' &&
      (tenants.includes('all') || tenants.includes(scoped.tenantId)) &&
      resolveAssuranceReleaseSurfaces(raw).has(scoped.surface)
    );
  }
  return (
    normalize(globalModeRaw) === 'enforce' &&
    tokens(tenantCanariesRaw).includes('all') &&
    resolveAssuranceReleaseSurfaces(raw).has(surface)
  );
}

export const HIGH_RISK_CLAIM_CATEGORIES = new Set([
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

const EXTERNAL_OR_EXECUTION_SURFACES = new Set<AssuranceSurface>([
  'outreach',
  'memo',
  'workspace-gen',
  'district-brief',
  'strategy',
]);

export interface AssuranceRiskAssessment {
  version: 'ga-risk-v1';
  level: AssuranceRiskLevel;
  categories: string[];
  reasons: string[];
  requiresBufferBeforeRelease: boolean;
  requiresHumanReview: boolean;
}

export interface AssuranceGateInput {
  surface: AssuranceSurface;
  plan: DomainEvidencePlan;
  ledger: ClaimLedger;
  findings?: readonly AuditFinding[];
  complianceOutcome?: 'PASS' | 'WARN' | 'BLOCK';
  verificationAvailable?: boolean;
}

export interface AssuranceGateResult {
  assessment: AssuranceRiskAssessment;
  decision: AssuranceReleaseDecision;
  blockers: string[];
  warnings: string[];
  canStreamIrreversibly: boolean;
  /** Canonical envelope created for every evaluated surface, including shadow. */
  envelope: AssuranceEnvelope;
}

export function classifyAssuranceRisk(
  surface: AssuranceSurface,
  plan: DomainEvidencePlan,
): AssuranceRiskAssessment {
  const categories = [...plan.requestCategories];
  const highRiskCategories = categories.filter((category) =>
    HIGH_RISK_CLAIM_CATEGORIES.has(category),
  );
  const external = EXTERNAL_OR_EXECUTION_SURFACES.has(surface);
  const restricted = surface === 'outreach';
  const reasons: string[] = [];
  if (external)
    reasons.push('The output is an external, client-facing, or strategy-execution artifact.');
  if (highRiskCategories.length) {
    reasons.push(
      `The request contains high-risk factual categories: ${highRiskCategories.join(', ')}.`,
    );
  }
  if (plan.incomplete) reasons.push('The operating frame or required evidence plan is incomplete.');

  const level: AssuranceRiskLevel = restricted
    ? 'restricted'
    : external || highRiskCategories.length
      ? 'high'
      : categories.includes('client_recommendation')
        ? 'moderate'
        : 'low';
  return {
    version: 'ga-risk-v1',
    level,
    categories,
    reasons,
    requiresBufferBeforeRelease: level === 'high' || level === 'restricted',
    requiresHumanReview: restricted || plan.incomplete,
  };
}

export function evaluateAssuranceRelease(input: AssuranceGateInput): AssuranceGateResult {
  const assessment = classifyAssuranceRisk(input.surface, input.plan);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const findings = input.findings ?? [];
  const critical = findings.filter((finding) => finding.severity === 'critical');
  const high = findings.filter((finding) => finding.severity === 'high');

  if (input.complianceOutcome === 'BLOCK')
    blockers.push('The active compliance policy blocked release.');
  if (input.ledger.highRiskUnsupportedClaimIds.length) {
    blockers.push(
      `Unsupported high-risk claims: ${input.ledger.highRiskUnsupportedClaimIds.join(', ')}.`,
    );
  }
  if (input.ledger.conflictedClaimIds.length) {
    blockers.push(`Conflicted claims: ${input.ledger.conflictedClaimIds.join(', ')}.`);
  }
  if (input.ledger.requiredEvidenceGaps.length) {
    blockers.push(`Missing required evidence: ${input.ledger.requiredEvidenceGaps.join(', ')}.`);
  }
  if (critical.length) blockers.push(`${critical.length} critical deterministic finding(s).`);
  if (assessment.requiresBufferBeforeRelease && input.verificationAvailable === false) {
    blockers.push('Required pre-release verification was unavailable.');
  }

  if (input.complianceOutcome === 'WARN')
    warnings.push('The active policy requires human approval.');
  if (high.length) warnings.push(`${high.length} high-severity deterministic finding(s).`);
  const lesser = findings.filter(
    (finding) => finding.severity === 'medium' || finding.severity === 'low',
  );
  if (lesser.length) warnings.push(`${lesser.length} medium/low deterministic finding(s).`);

  let decision: AssuranceReleaseDecision = 'deliver';
  if (blockers.length) {
    decision = input.surface === 'chat' || input.surface === 'in-editor' ? 'repair' : 'hold';
  } else if (warnings.length || assessment.requiresHumanReview) {
    decision = assessment.level === 'restricted' ? 'hold' : 'deliver_with_flags';
  }

  const core = {
    assessment,
    decision,
    blockers,
    warnings,
    canStreamIrreversibly: !assessment.requiresBufferBeforeRelease && decision === 'deliver',
  };
  const envelope = buildAssuranceEnvelope({
    surface: input.surface,
    operatingFrame: {
      jurisdictions: [...input.plan.jurisdictions],
      missingRequired: [...input.plan.unresolvedFrameFields],
      assumptions: ['operating frame reconstructed from the canonical evidence plan'],
    },
    evidencePlan: input.plan,
    claimLedger: input.ledger,
    findings,
    gate: core,
  });

  emitAssuranceGateControlMetrics({
    decision,
    claimCount: input.ledger.claims.length,
    unsupportedHighRiskClaimCount: input.ledger.highRiskUnsupportedClaimIds.length,
  });

  return { ...core, envelope };
}

export interface PrePersistAssuranceResult {
  gate: AssuranceGateResult;
  allowPersist: boolean;
  refusal: string;
}

export function assurePreToolPersist(
  input: AssuranceGateInput & { subject?: string },
): PrePersistAssuranceResult {
  const gate = evaluateAssuranceRelease(input);
  const allowPersist = gate.decision !== 'hold' && gate.decision !== 'repair';
  const subject = String(input.subject ?? 'this deliverable')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const reasons = gate.blockers
    .slice(0, 6)
    .map((reason) => `- ${reason}`)
    .join('\n');
  const refusal = allowPersist
    ? ''
    : [
        `${subject} was NOT created, saved, or persisted: required pre-release verification did not pass.`,
        reasons || '- One or more high-risk claims lacked authoritative same-turn support.',
        '',
        'Nothing was written. Do not tell the user the deliverable exists. An empty result, stale memory, or model inference is not proof — retrieve the missing authoritative source, or say plainly which claim could not be verified.',
      ].join('\n');
  return { gate, allowPersist, refusal };
}

export function shouldBufferRequestBeforeRelease(
  request: string,
  surface: AssuranceSurface = 'chat',
): boolean {
  if (EXTERNAL_OR_EXECUTION_SURFACES.has(surface)) return true;
  const text = String(request ?? '');
  return /(?:\$|\b(?:budget|funding|appropriat|authoriz|amount|how\s+much|top-?line|plus-?up|cost|dollars?|fy\s?\d{2,4}|vote|passed|failed|enacted|public\s+law|current\s+(?:chair|member|official|role)|deadline|due\s+date|comment\s+period|effective\s+date|legal|compliance|recommend|strategy|who\s+should\s+we|no\s+evidence|none|only|all|every)\b)/i.test(
    text,
  );
}

function tokens(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map(normalize)
    .filter(Boolean);
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}
