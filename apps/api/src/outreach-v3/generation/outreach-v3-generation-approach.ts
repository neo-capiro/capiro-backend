import { createHash } from 'node:crypto';
import type { OutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';

export const OUTREACH_V3_APPROACH_GATE_VERSION = 'outreach_v3_approach_gate_v1' as const;

export const OUTREACH_V3_APPROACH_BLOCKER_CODES = [
  'GENERATION_PLAN_NOT_ELIGIBLE',
  'REPRESENTATIVE_SAMPLE_MISSING',
  'REPRESENTATIVE_SAMPLE_DUPLICATE',
  'REPRESENTATIVE_SAMPLE_UNEXPECTED',
  'REPRESENTATIVE_SAMPLE_STALE',
  'REPRESENTATIVE_SAMPLE_NOT_REVIEWABLE',
] as const;

export type OutreachV3ApproachBlockerCode = (typeof OUTREACH_V3_APPROACH_BLOCKER_CODES)[number];

export interface OutreachV3SampleVersionRef {
  generationKey: string;
  artifactId: string;
  versionId: string;
  contentHash: string;
  /** Exact generation plan that produced this immutable sample version. */
  planHash: string;
  auditStatus: 'passed' | 'warning' | 'held' | 'pending' | 'unavailable' | 'not_required';
  generationStatus: string;
}

export interface OutreachV3ApproachApprovalSnapshot {
  gateVersion: typeof OUTREACH_V3_APPROACH_GATE_VERSION;
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  sampleSetHash: string;
  sampleVersions: OutreachV3SampleVersionRef[];
  approvalHash: string;
}

export interface OutreachV3ApproachGateResult {
  eligible: boolean;
  blockers: OutreachV3ApproachBlockerCode[];
  sampleSetHash: string;
  normalizedSamples: OutreachV3SampleVersionRef[];
}

/**
 * Deterministically prove the lobbyist reviewed exactly the representative
 * sample set selected for this exact generation plan. Approval itself is a
 * separate user action and must persist this exact snapshot/hash.
 */
export function evaluateOutreachV3ApproachGate(
  plan: OutreachV3GenerationPlan,
  samples: readonly OutreachV3SampleVersionRef[],
): OutreachV3ApproachGateResult {
  const blockers: OutreachV3ApproachBlockerCode[] = [];
  if (!plan.eligible) blockers.push('GENERATION_PLAN_NOT_ELIGIBLE');

  const normalizedSamples = [...samples].sort(compareSample);
  const expected = new Set(plan.representativeSampleKeys);
  const seen = new Set<string>();

  for (const sample of normalizedSamples) {
    if (seen.has(sample.generationKey)) {
      blockers.push('REPRESENTATIVE_SAMPLE_DUPLICATE');
      continue;
    }
    seen.add(sample.generationKey);
    if (!expected.has(sample.generationKey)) {
      blockers.push('REPRESENTATIVE_SAMPLE_UNEXPECTED');
    }
    if (sample.planHash !== plan.planHash) {
      blockers.push('REPRESENTATIVE_SAMPLE_STALE');
    }
    if (!reviewable(sample)) {
      blockers.push('REPRESENTATIVE_SAMPLE_NOT_REVIEWABLE');
    }
  }
  for (const generationKey of expected) {
    if (!seen.has(generationKey)) blockers.push('REPRESENTATIVE_SAMPLE_MISSING');
  }

  return {
    eligible: blockers.length === 0,
    blockers: uniqueSorted(blockers),
    normalizedSamples,
    sampleSetHash: hashSamples(normalizedSamples),
  };
}

export function createOutreachV3ApproachApprovalSnapshot(
  plan: OutreachV3GenerationPlan,
  samples: readonly OutreachV3SampleVersionRef[],
): OutreachV3ApproachApprovalSnapshot {
  const gate = evaluateOutreachV3ApproachGate(plan, samples);
  if (!gate.eligible) {
    throw new Error(`OUTREACH_V3_APPROACH_NOT_ELIGIBLE:${gate.blockers.join(',')}`);
  }
  const base = {
    gateVersion: OUTREACH_V3_APPROACH_GATE_VERSION,
    sessionId: plan.sessionId,
    stateVersion: plan.stateVersion,
    specHash: plan.specHash,
    planHash: plan.planHash,
    sampleSetHash: gate.sampleSetHash,
    sampleVersions: gate.normalizedSamples,
  };
  return {
    ...base,
    approvalHash: sha256(JSON.stringify(base)),
  };
}

/** Approval is invalidated by any canonical-state/plan or sample-version change. */
export function isOutreachV3ApproachApprovalCurrent(
  plan: OutreachV3GenerationPlan,
  approval: OutreachV3ApproachApprovalSnapshot | null,
): boolean {
  return Boolean(
    approval &&
    approval.gateVersion === OUTREACH_V3_APPROACH_GATE_VERSION &&
    approval.sessionId === plan.sessionId &&
    approval.stateVersion === plan.stateVersion &&
    approval.specHash === plan.specHash &&
    approval.planHash === plan.planHash &&
    approval.sampleVersions.every((sample) => sample.planHash === plan.planHash),
  );
}

/**
 * Full generation resumes only unfinished slots and only after the exact sample
 * approach is approved. Completed sample versions are never regenerated merely
 * because the batch resumes.
 */
export function remainingOutreachV3GenerationKeys(
  plan: OutreachV3GenerationPlan,
  approval: OutreachV3ApproachApprovalSnapshot | null,
  completedGenerationKeys: readonly string[],
): string[] {
  if (!isOutreachV3ApproachApprovalCurrent(plan, approval)) return [];
  const completed = new Set(completedGenerationKeys);
  return plan.slots
    .map((slot) => slot.generationKey)
    .filter((generationKey) => !completed.has(generationKey))
    .sort(compareStrings);
}

function reviewable(sample: OutreachV3SampleVersionRef): boolean {
  return (
    Boolean(sample.artifactId && sample.versionId && sample.contentHash && sample.planHash) &&
    sample.generationStatus !== 'generation_failed' &&
    (sample.auditStatus === 'passed' || sample.auditStatus === 'warning')
  );
}

function hashSamples(samples: readonly OutreachV3SampleVersionRef[]): string {
  return sha256(
    JSON.stringify(
      samples.map((sample) => ({
        generationKey: sample.generationKey,
        artifactId: sample.artifactId,
        versionId: sample.versionId,
        contentHash: sample.contentHash,
        planHash: sample.planHash,
        auditStatus: sample.auditStatus,
        generationStatus: sample.generationStatus,
      })),
    ),
  );
}

function compareSample(a: OutreachV3SampleVersionRef, b: OutreachV3SampleVersionRef): number {
  return compareStrings(a.generationKey, b.generationKey);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStrings) as T[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
