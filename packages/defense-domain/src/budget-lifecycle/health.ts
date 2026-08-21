/**
 * Cycle health / coverage read model.
 *
 * Backend state only — Session 7 deliberately exposes no new HTTP route and no
 * product surface. Session 11 owns the UI. What matters here is that the counts
 * are honest: `notFiled` is its own number and never folded into a zero, and the
 * GPU/NVIDIA fields are reported as the measured zero they are under the
 * accepted Session 5 negative decision rather than omitted.
 */

import { WATCHER_EXECUTION_CONTRACT } from './watcher.js';
import type {
  AuthorityTrack,
  ExpectedSourceState,
  LifecycleStage,
  ObservationState,
  SourceFamily,
} from './types.js';

export interface CycleHealthExpectedSourceInput {
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly expectedState: ExpectedSourceState;
  readonly optional: boolean;
  readonly adapterId: string;
}

export interface CycleHealthObservationInput {
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly observationState: ObservationState;
  readonly adapterId: string;
  readonly observedAt: string;
}

export interface CycleHealthWatcherRunInput {
  readonly adapterId: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'partial';
  readonly finishedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly consecutiveFailures: number;
}

export interface CycleHealthOutboxInput {
  readonly state: 'pending' | 'leased' | 'succeeded' | 'failed' | 'dead_letter';
}

export interface TrackHealth {
  readonly authorityTrack: AuthorityTrack;
  readonly expectedSources: number;
  readonly published: number;
  readonly notFiled: number;
  readonly reviewRequired: number;
  readonly superseded: number;
  readonly withdrawn: number;
  readonly unavailable: number;
  readonly stillExpected: number;
}

export interface CycleHealth {
  readonly schemaVersion: 'defense_budget_cycle_health_v1';
  readonly fiscalYear: number;
  readonly generatedAt: string;
  readonly expectedSources: number;
  readonly published: number;
  readonly verified: number;
  readonly reviewRequired: number;
  readonly rejected: number;
  readonly notFiled: number;
  readonly parserFailures: number;
  readonly failedDownloads: number;
  readonly reviewBacklog: number;
  readonly lastDiscoveryAt: string | null;
  readonly nextWatcherRunAt: string | null;
  readonly staleAdapters: readonly string[];
  readonly tracks: readonly TrackHealth[];
  /** Zero under the accepted Session 5 decision; reported, not assumed. */
  readonly nvidiaQueuedPages: 0;
  readonly activeGpuJobs: 0;
  readonly nvidiaRouting: 'disabled';
  readonly productionParser: 'DETERMINISTIC_PRIMARY';
  /**
   * Explicit reminder for every consumer of this read model: an unpublished
   * expected source has no known amount. It is not zero funding.
   */
  readonly missingSourceMeansUnknownNotZero: true;
}

const ALL_TRACKS: readonly AuthorityTrack[] = Object.freeze([
  'request',
  'authorization',
  'appropriations',
  'alternative_funding',
  'execution',
]);

function maxIso(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) continue;
    if (best === null || time > new Date(best).getTime()) best = value;
  }
  return best;
}

function minIso(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) continue;
    if (best === null || time < new Date(best).getTime()) best = value;
  }
  return best;
}

export interface BuildCycleHealthInput {
  readonly fiscalYear: number;
  readonly nowIso: string;
  readonly expectedSources: readonly CycleHealthExpectedSourceInput[];
  readonly observations: readonly CycleHealthObservationInput[];
  readonly watcherRuns: readonly CycleHealthWatcherRunInput[];
  readonly outbox: readonly CycleHealthOutboxInput[];
  /** How long an adapter may go unheard from before it counts as stale. */
  readonly staleAdapterAfterHours?: number;
}

export function buildCycleHealth(input: BuildCycleHealthInput): CycleHealth {
  const staleAfterMs = (input.staleAdapterAfterHours ?? 72) * 3_600_000;
  const now = new Date(input.nowIso).getTime();
  if (Number.isNaN(now)) throw new RangeError(`Invalid instant: ${input.nowIso}`);

  const tracks: TrackHealth[] = ALL_TRACKS.map((authorityTrack) => {
    const scoped = input.expectedSources.filter(
      (source) => source.authorityTrack === authorityTrack,
    );
    const count = (state: ExpectedSourceState): number =>
      scoped.filter((source) => source.expectedState === state).length;
    return Object.freeze({
      authorityTrack,
      expectedSources: scoped.length,
      published: count('published'),
      notFiled: count('not_filed'),
      reviewRequired: count('review_required'),
      superseded: count('superseded'),
      withdrawn: count('withdrawn'),
      unavailable: count('unavailable'),
      stillExpected: count('expected'),
    });
  }).filter((track) => track.expectedSources > 0);

  const observationCount = (state: ObservationState): number =>
    input.observations.filter((observation) => observation.observationState === state).length;

  const adapterLastSeen = new Map<string, string | null>();
  for (const source of input.expectedSources) {
    if (!adapterLastSeen.has(source.adapterId)) adapterLastSeen.set(source.adapterId, null);
  }
  for (const run of input.watcherRuns) {
    const existing = adapterLastSeen.get(run.adapterId) ?? null;
    adapterLastSeen.set(run.adapterId, maxIso([existing, run.finishedAt]));
  }

  const staleAdapters = [...adapterLastSeen.entries()]
    .filter(([, lastSeen]) => lastSeen === null || now - new Date(lastSeen).getTime() > staleAfterMs)
    .map(([adapterId]) => adapterId)
    .sort();

  return Object.freeze({
    schemaVersion: 'defense_budget_cycle_health_v1' as const,
    fiscalYear: input.fiscalYear,
    generatedAt: input.nowIso,
    expectedSources: input.expectedSources.length,
    published: input.expectedSources.filter((source) => source.expectedState === 'published').length,
    verified: observationCount('ingested'),
    reviewRequired: observationCount('review_required'),
    rejected: observationCount('withdrawn'),
    notFiled: input.expectedSources.filter((source) => source.expectedState === 'not_filed').length,
    parserFailures: input.outbox.filter(
      (job) => job.state === 'failed' || job.state === 'dead_letter',
    ).length,
    failedDownloads: observationCount('blocked'),
    reviewBacklog:
      observationCount('review_required') +
      input.expectedSources.filter((source) => source.expectedState === 'review_required').length,
    lastDiscoveryAt: maxIso(input.observations.map((observation) => observation.observedAt)),
    nextWatcherRunAt: minIso(input.watcherRuns.map((run) => run.nextCheckAt)),
    staleAdapters: Object.freeze(staleAdapters),
    tracks: Object.freeze(tracks),
    nvidiaQueuedPages: WATCHER_EXECUTION_CONTRACT.nvidiaQueuedPages,
    activeGpuJobs: WATCHER_EXECUTION_CONTRACT.activeGpuCapacity,
    nvidiaRouting: WATCHER_EXECUTION_CONTRACT.nvidiaRouting,
    productionParser: WATCHER_EXECUTION_CONTRACT.productionParser,
    missingSourceMeansUnknownNotZero: true as const,
  });
}
