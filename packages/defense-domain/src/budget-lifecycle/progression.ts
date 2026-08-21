/**
 * Stage progression guards.
 *
 * The rules this file enforces are the ones that make a lifecycle trustworthy:
 *
 *  - a mark never overwrites the President's Budget request;
 *  - House and Senate positions are not collapsed into one value;
 *  - conference is a NEW stage with its own evidence, not a mutation of the marks;
 *  - enacted is separate from conference unless the governing source proves the
 *    values are identical;
 *  - authorization and appropriations never write each other's positions.
 */

import { STAGE_RANK, STAGE_TRACK, type AuthorityTrack, type LifecycleStage } from './types.js';

export class StageOverwriteError extends Error {
  constructor(
    readonly existingStage: LifecycleStage,
    readonly incomingStage: LifecycleStage,
    readonly detail: string,
  ) {
    super(
      `Refusing to overwrite ${existingStage} with ${incomingStage}: ${detail}`,
    );
    this.name = 'StageOverwriteError';
  }
}

export class CrossTrackWriteError extends Error {
  constructor(readonly from: AuthorityTrack, readonly to: AuthorityTrack) {
    super(`Refusing to write a ${from} position onto the ${to} track`);
    this.name = 'CrossTrackWriteError';
  }
}

export interface StageEvidenceRecord {
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly contentSha256: string;
}

/**
 * Every new stage observation is an APPEND. Two things can make an append a
 * disguised overwrite, and both are refused here:
 *
 *  1. a stage recorded on a track it does not belong to (an authorization mark
 *     written onto the appropriations track);
 *  2. the SAME official bytes reclassified into a DIFFERENT stage of the same
 *     cycle — that silently redefines what an already-recorded stage means,
 *     which is how a mark ends up overwriting the President's Budget request.
 *
 * Recording an earlier stage after a later one is legitimate (sources arrive out
 * of order); it appends, and stage ranks keep it from being read as governing.
 */
export function assertStageEvidenceIsAppendOnly(input: {
  existing: readonly StageEvidenceRecord[];
  incoming: StageEvidenceRecord;
}): void {
  const incoming = input.incoming;
  if (STAGE_TRACK[incoming.stage] !== incoming.authorityTrack) {
    throw new CrossTrackWriteError(STAGE_TRACK[incoming.stage], incoming.authorityTrack);
  }

  for (const existing of input.existing) {
    if (existing.fiscalYear !== incoming.fiscalYear) continue;
    if (existing.contentSha256 !== incoming.contentSha256) continue;
    if (existing.stage === incoming.stage && existing.authorityTrack === incoming.authorityTrack) {
      continue; // identical identity: idempotent re-observation, not an overwrite
    }
    throw new StageOverwriteError(
      existing.stage,
      incoming.stage,
      `identical source bytes ${existing.contentSha256.slice(0, 12)}… are already recorded as ` +
        `${existing.authorityTrack}/${existing.stage} for FY${existing.fiscalYear}; reclassifying the ` +
        'same bytes into another stage would redefine an already-recorded position',
    );
  }
}

export interface StagePosition {
  readonly stage: LifecycleStage;
  readonly contentSha256: string;
}

/**
 * Positions are returned per stage, never merged. There is intentionally no
 * "current value" accessor that collapses House and Senate: a caller that wants
 * one number must state which stage it means.
 */
export function positionsByStage(
  records: readonly StageEvidenceRecord[],
  options: { fiscalYear: number; authorityTrack: AuthorityTrack },
): Readonly<Partial<Record<LifecycleStage, readonly StagePosition[]>>> {
  const grouped: Partial<Record<LifecycleStage, StagePosition[]>> = {};
  for (const record of records) {
    if (record.fiscalYear !== options.fiscalYear) continue;
    if (record.authorityTrack !== options.authorityTrack) continue;
    (grouped[record.stage] ??= []).push(
      Object.freeze({ stage: record.stage, contentSha256: record.contentSha256 }),
    );
  }
  return Object.freeze(grouped) as Readonly<
    Partial<Record<LifecycleStage, readonly StagePosition[]>>
  >;
}

/**
 * The furthest-advanced stage that actually has evidence on one track. Returns
 * null rather than a default when the track has no evidence at all — an empty
 * track is not "at the President's Budget", it is unobserved.
 */
export function governingStage(
  records: readonly StageEvidenceRecord[],
  options: { fiscalYear: number; authorityTrack: AuthorityTrack },
): LifecycleStage | null {
  let best: LifecycleStage | null = null;
  for (const record of records) {
    if (record.fiscalYear !== options.fiscalYear) continue;
    if (record.authorityTrack !== options.authorityTrack) continue;
    if (best === null || STAGE_RANK[record.stage] > STAGE_RANK[best]) best = record.stage;
  }
  return best;
}

/**
 * Enacted equals conference only when the governing source proves it. Absent
 * that proof the two stages remain distinct even if a caller believes they
 * match.
 */
export function enactedMatchesConference(input: {
  conferenceSha256: string;
  enactedSha256: string;
  governingSourceProvesIdentity: boolean;
}): boolean {
  if (!input.governingSourceProvesIdentity) return false;
  return input.conferenceSha256 === input.enactedSha256;
}
