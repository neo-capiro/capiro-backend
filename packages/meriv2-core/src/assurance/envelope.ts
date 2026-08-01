import { createHash } from 'node:crypto';
import type { AuditFinding, AuditSeverity } from '../grounding/auditor';
import type { ClaimLedger } from './claim-ledger';
import type { DomainEvidencePlan } from './evidence-plan';
import type { GovernmentAffairsOperatingFrame } from './operating-frame';
import type { AssuranceReleaseDecision, AssuranceSurface } from './risk-gate';
import { emitMeriV2ControlMetrics } from './control-metrics';

export const ASSURANCE_ENVELOPE_VERSION = 'ga-assurance-envelope-v1' as const;
export const ASSURANCE_VERIFIER_VERSION = 'ga-verifier-2026-07-31.v1' as const;

export interface AssurancePolicyBinding {
  packId: string;
  packVersion: string;
  ruleId: string | null;
  decisionHash?: string | null;
  contextHash?: string | null;
}

export type AssuranceFindingScope = 'run' | 'section' | 'claim';

export interface AssuranceFindingAttribution {
  scope: AssuranceFindingScope;
  subjectId?: string;
}

export interface AssuranceEnvelopeFinding {
  check: string;
  severity: AuditSeverity;
  detail: string;
  attribution: AssuranceFindingAttribution;
}

export interface AssuranceEnvelope {
  version: typeof ASSURANCE_ENVELOPE_VERSION;
  surface: AssuranceSurface;
  operatingFrame: GovernmentAffairsOperatingFrame;
  evidencePlan: DomainEvidencePlan;
  claimLedger: ClaimLedger;
  findings: AssuranceEnvelopeFinding[];
  releaseDecision: AssuranceReleaseDecision;
  blockers: string[];
  warnings: string[];
  verifierVersion: string;
  contextPacketId: string | null;
  policyBinding: AssurancePolicyBinding | null;
  generatedAt: string;
  hash: string;
}

export interface AssuranceFindingInput {
  check: string;
  severity: AuditSeverity;
  detail: string;
  attribution?: AssuranceFindingAttribution;
}

export interface AssuranceGateProjection {
  decision: AssuranceReleaseDecision;
  blockers: readonly string[];
  warnings: readonly string[];
}

export interface BuildAssuranceEnvelopeInput {
  surface: AssuranceSurface;
  operatingFrame: GovernmentAffairsOperatingFrame;
  evidencePlan: DomainEvidencePlan;
  claimLedger: ClaimLedger;
  findings?: readonly (AuditFinding | AssuranceFindingInput)[];
  gate: AssuranceGateProjection;
  verifierVersion?: string;
  contextPacketId?: string | null;
  policyBinding?: AssurancePolicyBinding | null;
  generatedAt?: string | Date;
  defaultAttribution?: AssuranceFindingAttribution;
}

export function buildAssuranceEnvelope(input: BuildAssuranceEnvelopeInput): AssuranceEnvelope {
  const generatedAt = iso(input.generatedAt ?? new Date());
  const defaultAttribution = input.defaultAttribution ?? { scope: 'run' as const };
  const findings = (input.findings ?? []).map((finding) => ({
    check: bounded(finding.check, 80),
    severity: finding.severity,
    detail: bounded(finding.detail, 1_000),
    attribution:
      'attribution' in finding && finding.attribution
        ? normalizeAttribution(finding.attribution)
        : normalizeAttribution(defaultAttribution),
  }));

  const core = {
    version: ASSURANCE_ENVELOPE_VERSION,
    surface: input.surface,
    operatingFrame: input.operatingFrame,
    evidencePlan: input.evidencePlan,
    claimLedger: input.claimLedger,
    findings,
    releaseDecision: input.gate.decision,
    blockers: input.gate.blockers.map((value) => bounded(value, 1_000)),
    warnings: input.gate.warnings.map((value) => bounded(value, 1_000)),
    verifierVersion: bounded(input.verifierVersion ?? ASSURANCE_VERIFIER_VERSION, 120),
    contextPacketId: normalizeNullable(input.contextPacketId),
    policyBinding: normalizePolicyBinding(input.policyBinding),
    generatedAt,
  } satisfies Omit<AssuranceEnvelope, 'hash'>;

  return { ...core, hash: sha256(stableStringify(core)) };
}

export interface VerifyAssuranceEnvelopeExpected {
  surface?: AssuranceSurface;
  contextPacketId?: string | null;
  policyBinding?: AssurancePolicyBinding | null;
  verifierVersion?: string;
}

export function verifyAssuranceEnvelope(
  envelope: AssuranceEnvelope,
  expected: VerifyAssuranceEnvelopeExpected = {},
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (envelope.version !== ASSURANCE_ENVELOPE_VERSION) errors.push('unsupported_version');
  if (!Number.isFinite(Date.parse(envelope.generatedAt))) errors.push('invalid_generated_at');

  const { hash, ...core } = envelope;
  if (hash !== sha256(stableStringify(core))) errors.push('hash_mismatch');
  if (expected.surface && envelope.surface !== expected.surface) errors.push('surface_mismatch');
  if (
    Object.prototype.hasOwnProperty.call(expected, 'contextPacketId') &&
    normalizeNullable(expected.contextPacketId) !== envelope.contextPacketId
  ) {
    errors.push('context_packet_drift');
  }
  if (
    Object.prototype.hasOwnProperty.call(expected, 'policyBinding') &&
    !samePolicyBinding(envelope.policyBinding, normalizePolicyBinding(expected.policyBinding))
  ) {
    errors.push('policy_binding_drift');
  }
  if (expected.verifierVersion && envelope.verifierVersion !== expected.verifierVersion) {
    errors.push('verifier_version_drift');
  }

  if (errors.includes('policy_binding_drift')) {
    emitMeriV2ControlMetrics({ PolicyDriftInvalidations: 1 });
  }
  return { valid: errors.length === 0, errors };
}

export function summarizeAssuranceEnvelope(envelope: AssuranceEnvelope): {
  version: string;
  surface: AssuranceSurface;
  releaseDecision: AssuranceReleaseDecision;
  verifierVersion: string;
  contextPacketId: string | null;
  policyPackId: string | null;
  policyPackVersion: string | null;
  findingCount: number;
  blockerCount: number;
  warningCount: number;
  claimCount: number;
  unsupportedHighRiskClaimCount: number;
  hash: string;
  generatedAt: string;
} {
  return {
    version: envelope.version,
    surface: envelope.surface,
    releaseDecision: envelope.releaseDecision,
    verifierVersion: envelope.verifierVersion,
    contextPacketId: envelope.contextPacketId,
    policyPackId: envelope.policyBinding?.packId ?? null,
    policyPackVersion: envelope.policyBinding?.packVersion ?? null,
    findingCount: envelope.findings.length,
    blockerCount: envelope.blockers.length,
    warningCount: envelope.warnings.length,
    claimCount: envelope.claimLedger.claims.length,
    unsupportedHighRiskClaimCount: envelope.claimLedger.highRiskUnsupportedClaimIds.length,
    hash: envelope.hash,
    generatedAt: envelope.generatedAt,
  };
}

function normalizeAttribution(value: AssuranceFindingAttribution): AssuranceFindingAttribution {
  const scope: AssuranceFindingScope =
    value.scope === 'section' || value.scope === 'claim' ? value.scope : 'run';
  const subjectId = bounded(String(value.subjectId ?? '').trim(), 240);
  return subjectId ? { scope, subjectId } : { scope };
}

function normalizePolicyBinding(
  value: AssurancePolicyBinding | null | undefined,
): AssurancePolicyBinding | null {
  if (!value) return null;
  const packId = String(value.packId ?? '').trim();
  const packVersion = String(value.packVersion ?? '').trim();
  if (!packId || !packVersion) return null;
  return {
    packId: bounded(packId, 200),
    packVersion: bounded(packVersion, 120),
    ruleId: value.ruleId ? bounded(value.ruleId, 200) : null,
    decisionHash: value.decisionHash ? bounded(value.decisionHash, 128) : null,
    contextHash: value.contextHash ? bounded(value.contextHash, 128) : null,
  };
}

function samePolicyBinding(
  left: AssurancePolicyBinding | null,
  right: AssurancePolicyBinding | null,
): boolean {
  return stableStringify(left) === stableStringify(right);
}

function normalizeNullable(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function bounded(value: string, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid assurance envelope timestamp');
  return date.toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
