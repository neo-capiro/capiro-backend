/**
 * Lifecycle deltas and signals.
 *
 * A signal says "the official position at stage X changed relative to stage Y,
 * and here is the source evidence on both sides". It is a SIGNAL: Meri, CRM and
 * Strategies decide what workflow it becomes. It carries no dollars — computing
 * amounts is governed ingestion's job, and a signal that carried money would let
 * discovery fabricate funding.
 */

import { canonicalJson, sha256Hex } from './cycle.js';
import { STAGE_RANK, STAGE_TRACK, type AuthorityTrack, type LifecycleStage } from './types.js';

export type LifecycleSignalKind =
  | 'pb_to_hasc'
  | 'pb_to_sasc'
  | 'pb_to_hac_d'
  | 'pb_to_sac_d'
  | 'house_to_senate'
  | 'latest_mark_to_conference'
  | 'conference_to_enacted'
  | 'source_correction';

export const LIFECYCLE_SIGNAL_KINDS: readonly LifecycleSignalKind[] = Object.freeze([
  'pb_to_hasc',
  'pb_to_sasc',
  'pb_to_hac_d',
  'pb_to_sac_d',
  'house_to_senate',
  'latest_mark_to_conference',
  'conference_to_enacted',
  'source_correction',
]);

export interface LifecycleObservationRef {
  readonly observationDedupKey: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly contentSha256: string;
  readonly observedAt: string;
  /** Set when this observation supersedes an earlier version of the same source. */
  readonly supersedesObservationDedupKey?: string | null;
}

export interface LifecycleSignal {
  readonly signalKind: LifecycleSignalKind;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly fromStage: LifecycleStage;
  readonly toStage: LifecycleStage;
  readonly fromObservationDedupKey: string;
  readonly toObservationDedupKey: string;
  readonly dedupKey: string;
}

export function lifecycleSignalDedupKey(input: {
  signalKind: LifecycleSignalKind;
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  fromObservationDedupKey: string;
  toObservationDedupKey: string;
}): string {
  return sha256Hex(
    canonicalJson({
      kind: 'defense_budget_lifecycle_signal_v1',
      signalKind: input.signalKind,
      fiscalYear: input.fiscalYear,
      authorityTrack: input.authorityTrack,
      fromObservationDedupKey: input.fromObservationDedupKey,
      toObservationDedupKey: input.toObservationDedupKey,
    }),
  );
}

/** Keys that would turn a signal into a funding assertion. */
const FORBIDDEN_SIGNAL_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  'authoritativeAmountUsd',
  'amountUsd',
  'statedAmountUsd',
  'allocatedUsd',
  'obligatedUsd',
  'outlayUsd',
  'amountM',
  'totalUsd',
]);

export class FabricatedSignalFundingError extends Error {
  constructor(readonly key: string) {
    super(
      `Lifecycle signal payload may not carry funding amounts (found "${key}"); ` +
        'dollars come only from governed evidence-bound ingestion',
    );
    this.name = 'FabricatedSignalFundingError';
  }
}

/**
 * Fail-closed: refuse any signal payload that carries a money field, at any
 * depth. Mirrored by a database CHECK on the signal table.
 */
export function assertLifecycleSignalCarriesNoDollars(payload: unknown): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (FORBIDDEN_SIGNAL_PAYLOAD_KEYS.includes(key)) throw new FabricatedSignalFundingError(key);
        walk((value as Record<string, unknown>)[key]);
      }
    }
  };
  walk(payload);
}

interface SignalRule {
  readonly signalKind: LifecycleSignalKind;
  readonly fromStage: LifecycleStage;
  readonly toStage: LifecycleStage;
  /**
   * The PB lives on the `request` track while the marks live on the
   * authorization/appropriations tracks; a PB→mark comparison is therefore
   * cross-track by nature and is attributed to the DESTINATION track.
   */
  readonly fromTrack: AuthorityTrack;
  readonly toTrack: AuthorityTrack;
}

const SIGNAL_RULES: readonly SignalRule[] = Object.freeze([
  {
    signalKind: 'pb_to_hasc',
    fromStage: 'president_budget_request',
    toStage: 'hasc_report',
    fromTrack: 'request',
    toTrack: 'authorization',
  },
  {
    signalKind: 'pb_to_sasc',
    fromStage: 'president_budget_request',
    toStage: 'sasc_report',
    fromTrack: 'request',
    toTrack: 'authorization',
  },
  {
    signalKind: 'pb_to_hac_d',
    fromStage: 'president_budget_request',
    toStage: 'hac_d_report',
    fromTrack: 'request',
    toTrack: 'appropriations',
  },
  {
    signalKind: 'pb_to_sac_d',
    fromStage: 'president_budget_request',
    toStage: 'sac_d_report',
    fromTrack: 'request',
    toTrack: 'appropriations',
  },
  {
    signalKind: 'house_to_senate',
    fromStage: 'hasc_report',
    toStage: 'sasc_report',
    fromTrack: 'authorization',
    toTrack: 'authorization',
  },
  {
    signalKind: 'house_to_senate',
    fromStage: 'hac_d_report',
    toStage: 'sac_d_report',
    fromTrack: 'appropriations',
    toTrack: 'appropriations',
  },
  {
    signalKind: 'latest_mark_to_conference',
    fromStage: 'sasc_report',
    toStage: 'auth_conference',
    fromTrack: 'authorization',
    toTrack: 'authorization',
  },
  {
    signalKind: 'latest_mark_to_conference',
    fromStage: 'sac_d_report',
    toStage: 'appr_conference_or_jes',
    fromTrack: 'appropriations',
    toTrack: 'appropriations',
  },
  {
    signalKind: 'conference_to_enacted',
    fromStage: 'auth_conference',
    toStage: 'auth_enacted',
    fromTrack: 'authorization',
    toTrack: 'authorization',
  },
  {
    signalKind: 'conference_to_enacted',
    fromStage: 'appr_conference_or_jes',
    toStage: 'appr_enacted',
    fromTrack: 'appropriations',
    toTrack: 'appropriations',
  },
]);

function latestPerStage(
  observations: readonly LifecycleObservationRef[],
): Map<string, LifecycleObservationRef> {
  const latest = new Map<string, LifecycleObservationRef>();
  for (const observation of observations) {
    const key = `${observation.fiscalYear}|${observation.authorityTrack}|${observation.stage}`;
    const existing = latest.get(key);
    if (
      !existing ||
      new Date(observation.observedAt).getTime() > new Date(existing.observedAt).getTime()
    ) {
      latest.set(key, observation);
    }
  }
  return latest;
}

/**
 * Derive source-backed signals from the observations of one or more cycles.
 *
 * Conference is compared AGAINST the marks; it never replaces them, and no
 * earlier stage's observation is mutated or dropped. Authorization and
 * appropriations signals are produced independently.
 */
export function deriveLifecycleSignals(
  observations: readonly LifecycleObservationRef[],
): readonly LifecycleSignal[] {
  const latest = latestPerStage(observations);
  const fiscalYears = [...new Set(observations.map((observation) => observation.fiscalYear))].sort();
  const signals: LifecycleSignal[] = [];

  for (const fiscalYear of fiscalYears) {
    for (const rule of SIGNAL_RULES) {
      const from = latest.get(`${fiscalYear}|${rule.fromTrack}|${rule.fromStage}`);
      const to = latest.get(`${fiscalYear}|${rule.toTrack}|${rule.toStage}`);
      if (!from || !to) continue;
      signals.push(
        Object.freeze({
          signalKind: rule.signalKind,
          fiscalYear,
          authorityTrack: rule.toTrack,
          fromStage: rule.fromStage,
          toStage: rule.toStage,
          fromObservationDedupKey: from.observationDedupKey,
          toObservationDedupKey: to.observationDedupKey,
          dedupKey: lifecycleSignalDedupKey({
            signalKind: rule.signalKind,
            fiscalYear,
            authorityTrack: rule.toTrack,
            fromObservationDedupKey: from.observationDedupKey,
            toObservationDedupKey: to.observationDedupKey,
          }),
        }),
      );
    }
  }

  // Corrections: a superseding observation of the SAME stage.
  for (const observation of observations) {
    if (!observation.supersedesObservationDedupKey) continue;
    signals.push(
      Object.freeze({
        signalKind: 'source_correction' as const,
        fiscalYear: observation.fiscalYear,
        authorityTrack: observation.authorityTrack,
        fromStage: observation.stage,
        toStage: observation.stage,
        fromObservationDedupKey: observation.supersedesObservationDedupKey,
        toObservationDedupKey: observation.observationDedupKey,
        dedupKey: lifecycleSignalDedupKey({
          signalKind: 'source_correction',
          fiscalYear: observation.fiscalYear,
          authorityTrack: observation.authorityTrack,
          fromObservationDedupKey: observation.supersedesObservationDedupKey,
          toObservationDedupKey: observation.observationDedupKey,
        }),
      }),
    );
  }

  return Object.freeze(signals);
}

export interface RecomputeScope {
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stages: readonly LifecycleStage[];
  readonly untouchedEarlierStages: readonly LifecycleStage[];
  readonly untouchedOtherTracks: readonly AuthorityTrack[];
}

/**
 * Scope of a corrected/revised source: the corrected stage and every LATER stage
 * on the SAME track and fiscal year. Earlier stages keep their own immutable
 * evidence, and the other authority track is untouched.
 */
export function recomputeScopeForCorrection(input: {
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  correctedStage: LifecycleStage;
  observedStages: readonly LifecycleStage[];
}): RecomputeScope {
  const track = input.authorityTrack;
  if (STAGE_TRACK[input.correctedStage] !== track) {
    throw new Error(
      `Corrected stage ${input.correctedStage} belongs to ${STAGE_TRACK[input.correctedStage]}, not ${track}`,
    );
  }
  const correctedRank = STAGE_RANK[input.correctedStage];
  const onTrack = input.observedStages.filter((stage) => STAGE_TRACK[stage] === track);

  const stages = onTrack.filter((stage) => STAGE_RANK[stage] >= correctedRank);
  const untouchedEarlierStages = onTrack.filter((stage) => STAGE_RANK[stage] < correctedRank);
  const untouchedOtherTracks = [
    ...new Set(
      input.observedStages
        .map((stage) => STAGE_TRACK[stage])
        .filter((otherTrack) => otherTrack !== track),
    ),
  ];

  return Object.freeze({
    fiscalYear: input.fiscalYear,
    authorityTrack: track,
    stages: Object.freeze([...new Set(stages)]),
    untouchedEarlierStages: Object.freeze([...new Set(untouchedEarlierStages)]),
    untouchedOtherTracks: Object.freeze(untouchedOtherTracks),
  });
}
