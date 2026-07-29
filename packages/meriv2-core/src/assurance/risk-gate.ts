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
  | 'district-brief'
  // Context Steward extraction. NOT client-facing (its output becomes
  // sp_context_* facts that api-strategy persists), so it is deliberately absent
  // from EXTERNAL_OR_EXECUTION_SURFACES below — it is gated as a claim-ledger
  // PRODUCER (an anchor-less high-risk fact must not be persisted), not as an
  // external artifact.
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

export type AssuranceReleaseMode = 'off' | 'enforce';

/**
 * Master switch for actually WITHHOLDING output on a failed release decision.
 *
 * `classifyAssuranceRisk` below is deliberately broad: every external/strategy
 * artifact and any high-risk factual category buffers before release. That is the
 * right classification, but it means enforcing the hold changes behaviour on a
 * large share of real traffic — a plain "ndaa status?" classifies as `bill_status`
 * and is held whenever the same turn did not resolve authoritative status +
 * procedure evidence. So the hold ships DARK and is enabled per environment during
 * the canary, mirroring the existing MERI_AUDITOR_MODE switch.
 *
 * With `off`, the pre-Phase-4 behaviour is preserved exactly: stream the reply and
 * attach a post-hoc grounding caveat. Classification, the claim ledger, and the
 * release metrics still run, so the gate can be observed before it is armed.
 *
 * Pure by design — callers pass the raw environment value so this stays testable
 * and this package keeps no ambient environment dependency.
 */
export function resolveAssuranceReleaseMode(raw: string | undefined): AssuranceReleaseMode {
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'enforce'
    ? 'enforce'
    : 'off';
}

/**
 * PER-SURFACE arming for the pre-release hold — sibling of
 * `resolveAssuranceReleaseMode`, read from `MERI_RELEASE_GATE_SURFACES`.
 *
 * WHY A SECOND SWITCH. `MERI_RELEASE_GATE` is already read by TWO
 * independently-deployed services: the orchestrator's chat finalize and
 * api-strategy's `generationReleaseHoldEnforced`. Hanging four MORE surfaces off
 * the same variable would mean one flip arms six behaviours at once across three
 * services — the opposite of a canary. So every surface added after chat is armed
 * by NAME here, and `MERI_RELEASE_GATE=enforce` alone changes nothing about them.
 *
 * Format: a comma/space separated list of `AssuranceSurface` names, or the single
 * token `all`. Unknown tokens are ignored rather than throwing — a typo must
 * NEVER be the thing that silently arms (or disarms) a withhold. Empty, unset, or
 * all-unknown ⇒ the empty set ⇒ every new surface stays dark.
 *
 * Pure by design: callers pass the raw environment value.
 */
export function resolveAssuranceReleaseSurfaces(
  raw: string | undefined,
): ReadonlySet<AssuranceSurface> {
  const tokens = String(raw ?? '')
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (!tokens.length) return new Set<AssuranceSurface>();
  if (tokens.includes('all')) return new Set<AssuranceSurface>(ASSURANCE_SURFACES);
  const known = new Set<string>(ASSURANCE_SURFACES);
  return new Set<AssuranceSurface>(
    tokens.filter((token): token is AssuranceSurface => known.has(token)),
  );
}

/** Is the pre-release hold armed for exactly this surface? Defaults to false. */
export function assuranceReleaseArmedFor(
  raw: string | undefined,
  surface: AssuranceSurface,
): boolean {
  return resolveAssuranceReleaseSurfaces(raw).has(surface);
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

  return {
    assessment,
    decision,
    blockers,
    warnings,
    canStreamIrreversibly: !assessment.requiresBufferBeforeRelease && decision === 'deliver',
  };
}

export interface PrePersistAssuranceResult {
  gate: AssuranceGateResult;
  /**
   * May the caller perform the DURABLE write? `deliver_with_flags` still
   * persists — the flags travel with the artifact. `repair`/`hold` must not.
   */
  allowPersist: boolean;
  /** Bounded, non-fabricating explanation for the model / the run summary. */
  refusal: string;
}

/**
 * The ONE pre-persistence decision every surface shares.
 *
 * `evaluateAssuranceRelease` answers "may this be RELEASED"; on chat that runs at
 * finalize, which is far too late for a tool that already wrote a durable row.
 * This wrapper is the pre-write form: same classification, same blockers, plus a
 * canonical refusal string so four call sites cannot drift into four different
 * (and differently misleading) apology texts.
 *
 * It deliberately does NOT read the environment. Every caller must have already
 * decided it is armed (`assuranceReleaseArmedFor` / `resolveAssuranceReleaseMode`)
 * before calling, so the dark-by-default decision stays visible at the call site
 * instead of being buried in here.
 */
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
  // Money phrasing must include the literal ways a dollar figure is asked for. The
  // original list covered process words (budget/appropriat/authoriz) but missed the
  // most direct forms — "what is the current FY27 amount", "how much did it get" —
  // which are exactly the high-stakes numbers that must not stream unverified.
  return /(?:\$|\b(?:budget|funding|appropriat|authoriz|amount|how\s+much|top-?line|plus-?up|cost|dollars?|fy\s?\d{2,4}|vote|passed|failed|enacted|public\s+law|current\s+(?:chair|member|official|role)|deadline|due\s+date|comment\s+period|effective\s+date|legal|compliance|recommend|strategy|who\s+should\s+we|no\s+evidence|none|only|all|every)\b)/i.test(
    text,
  );
}
