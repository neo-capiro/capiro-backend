/**
 * Phase 4 (4.1) — assemble a single "request → marks → enactment" narrative for
 * one program element's current budget cycle. Pure + deterministic: the money
 * math (delta vs request, delta vs the prior acted stage) is computed from the
 * stage values themselves, and every figure carries its stage label + vehicle
 * (authorization vs appropriation) so a stage is never mislabeled or coalesced
 * (the RC1 discipline, applied to the human-facing narrative too, not just the
 * LLM-facing renderer).
 *
 * No I/O — unit-tested under the repo's src/**.spec.ts matcher. The read service
 * feeds it the current-cycle stage values (from getTimeline) and surfaces the
 * FY's materiality-scored deltas alongside (4.1.2).
 */
import { FUNDING_STAGE_LABEL, FUNDING_STAGE_VEHICLE, type FundingStage } from '@capiro/shared';

/** The seven stage values for one FY (millions), null where the stage hasn't acted. */
export interface NarrativeYearValues {
  request: number | null;
  hasc: number | null;
  sasc: number | null;
  hacd: number | null;
  sacd: number | null;
  conference: number | null;
  enacted: number | null;
}

export interface FundingNarrativeStep {
  stage: FundingStage;
  /** Human label ("Request", "HASC", "HAC-D", "Conference", "Enacted", …). */
  label: string;
  /** 'request' | 'authorization' | 'appropriation' — never blur the two. */
  vehicle: string;
  valueM: number;
  /** Signed delta vs the President's request (null for the request step itself, or when no request). */
  deltaVsRequestM: number | null;
  /** Signed delta vs the previous acted stage in the ladder (null for the first step). */
  deltaVsPriorStageM: number | null;
}

// Procedural order: request → authorization marks → appropriations marks →
// conference → enacted. Only stages that actually acted (non-null) appear.
const NARRATIVE_STAGE_ORDER: ReadonlyArray<{
  stage: FundingStage;
  key: keyof NarrativeYearValues;
}> = [
  { stage: 'request', key: 'request' },
  { stage: 'hasc', key: 'hasc' },
  { stage: 'sasc', key: 'sasc' },
  { stage: 'hacd', key: 'hacd' },
  { stage: 'sacd', key: 'sacd' },
  { stage: 'conference', key: 'conference' },
  { stage: 'enacted', key: 'enacted' },
];

/**
 * Build the ordered narrative steps for one FY's funding lifecycle. Each acted
 * stage becomes one step with its labeled value, signed delta vs request, and
 * signed delta vs the prior acted stage.
 */
export function assembleFundingNarrative(values: NarrativeYearValues): FundingNarrativeStep[] {
  const request = values.request;
  const steps: FundingNarrativeStep[] = [];
  let priorVal: number | null = null;
  for (const { stage, key } of NARRATIVE_STAGE_ORDER) {
    const v = values[key];
    if (v == null) continue;
    steps.push({
      stage,
      label: FUNDING_STAGE_LABEL[stage],
      vehicle: FUNDING_STAGE_VEHICLE[stage],
      valueM: v,
      deltaVsRequestM: stage !== 'request' && request != null ? round1(v - request) : null,
      deltaVsPriorStageM: priorVal != null ? round1(v - priorVal) : null,
    });
    priorVal = v;
  }
  return steps;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
