import type { AuditFinding } from '../grounding/auditor';
import type { ClaimLedger } from './claim-ledger';
import type { DomainEvidencePlan } from './evidence-plan';

export type AssuranceSurface =
  | 'chat'
  | 'in-editor'
  | 'workspace-gen'
  | 'strategy'
  | 'research'
  | 'outreach'
  | 'memo'
  | 'district-brief';

export type AssuranceRiskLevel = 'low' | 'moderate' | 'high' | 'restricted';
export type AssuranceReleaseDecision = 'deliver' | 'deliver_with_flags' | 'repair' | 'hold';

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
  /** A policy decision from the active, reviewed policy pack. */
  complianceOutcome?: 'PASS' | 'WARN' | 'BLOCK';
  verificationAvailable?: boolean;
}

export interface AssuranceGateResult {
  assessment: AssuranceRiskAssessment;
  decision: AssuranceReleaseDecision;
  blockers: string[];
  warnings: string[];
  canStreamIrreversibly: boolean;
}

/**
 * Classify risk deterministically from surface and claim categories. The model
 * cannot lower its own risk tier. High-risk factual categories and all external
 * or strategy-execution artifacts are buffered before release.
 */
export function classifyAssuranceRisk(
  surface: AssuranceSurface,
  plan: DomainEvidencePlan,
): AssuranceRiskAssessment {
  const categories = [...plan.requestCategories];
  const highRiskCategories = categories.filter((category) => HIGH_RISK_CLAIM_CATEGORIES.has(category));
  const external = EXTERNAL_OR_EXECUTION_SURFACES.has(surface);
  const restricted = surface === 'outreach';
  const reasons: string[] = [];
  if (external) reasons.push('The output is an external, client-facing, or strategy-execution artifact.');
  if (highRiskCategories.length) {
    reasons.push(`The request contains high-risk factual categories: ${highRiskCategories.join(', ')}.`);
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

/**
 * Release decision after claim resolution and deterministic checks. A post-hoc
 * caveat cannot turn an unsupported high-risk fact into releaseable content.
 */
export function evaluateAssuranceRelease(input: AssuranceGateInput): AssuranceGateResult {
  const assessment = classifyAssuranceRisk(input.surface, input.plan);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const findings = input.findings ?? [];
  const critical = findings.filter((finding) => finding.severity === 'critical');
  const high = findings.filter((finding) => finding.severity === 'high');

  if (input.complianceOutcome === 'BLOCK') blockers.push('The active compliance policy blocked release.');
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

  if (input.complianceOutcome === 'WARN') warnings.push('The active policy requires human approval.');
  if (high.length) warnings.push(`${high.length} high-severity deterministic finding(s).`);
  const lesser = findings.filter((finding) => finding.severity === 'medium' || finding.severity === 'low');
  if (lesser.length) warnings.push(`${lesser.length} medium/low deterministic finding(s).`);

  let decision: AssuranceReleaseDecision = 'deliver';
  if (blockers.length) {
    decision = input.surface === 'chat' || input.surface === 'in-editor' ? 'repair' : 'hold';
  } else if (warnings.length || assessment.requiresHumanReview) {
    decision = assessment.level === 'restricted' ? 'hold' : 'deliver_with_flags';
  }

  return {
    assessment,
    decision,
    blockers,
    warnings,
    canStreamIrreversibly: !assessment.requiresBufferBeforeRelease && decision === 'deliver',
  };
}

/**
 * Conservative preflight used before a model call. It intentionally over-buffers
 * ambiguous high-stakes requests; latency is preferable to irreversibly streaming
 * an unchecked status, money, role, deadline, or legal assertion.
 */
export function shouldBufferRequestBeforeRelease(
  request: string,
  surface: AssuranceSurface = 'chat',
): boolean {
  if (EXTERNAL_OR_EXECUTION_SURFACES.has(surface)) return true;
  const text = String(request ?? '');
  return /(?:\$|\b(?:budget|funding|appropriat|authoriz|vote|passed|failed|enacted|public\s+law|current\s+(?:chair|member|official|role)|deadline|due\s+date|comment\s+period|effective\s+date|legal|compliance|recommend|strategy|who\s+should\s+we|no\s+evidence|none|only|all|every)\b)/i.test(
    text,
  );
}
