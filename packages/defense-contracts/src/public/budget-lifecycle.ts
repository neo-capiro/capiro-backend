/**
 * Phase 8 Session 7 — Annual budget cycle / lifecycle watcher contracts.
 *
 * These are the shapes Session 11 product integration will read. Session 7 does
 * NOT register an HTTP route for them: the Session 3 route surface stays frozen
 * at 49 routes and public browser/API routing is unchanged.
 *
 * Two contract rules make the read model safe to consume:
 *
 *  1. There is no amount field anywhere in this file. Discovery classifies
 *     sources; only governed evidence-bound ingestion produces dollars.
 *  2. An unpublished expected source reports an explicit state. There is no
 *     numeric field that could carry a misleading zero.
 */

export const DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION = 'defense_budget_lifecycle_v1';

export type DefenseAuthorityTrackDto =
  | 'request'
  | 'authorization'
  | 'appropriations'
  | 'alternative_funding'
  | 'execution';

export type DefenseExpectedSourceStateDto =
  | 'expected'
  | 'not_filed'
  | 'published'
  | 'superseded'
  | 'withdrawn'
  | 'unavailable'
  | 'review_required';

export type DefenseObservationStateDto =
  | 'discovered'
  | 'downloaded'
  | 'unchanged'
  | 'changed'
  | 'classified'
  | 'review_required'
  | 'queued'
  | 'ingested'
  | 'blocked'
  | 'superseded'
  | 'withdrawn';

export type DefenseCycleStatusDto = 'draft' | 'active' | 'closed';

export interface DefenseBudgetCycleDto {
  readonly schemaVersion: typeof DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION;
  readonly fiscalYear: number;
  readonly authorityTrack: DefenseAuthorityTrackDto;
  readonly status: DefenseCycleStatusDto;
  readonly templateVersion: string;
  readonly bootstrapOrigin: 'discovery' | 'template' | 'operator';
  readonly openedAt: string;
  readonly closedAt: string | null;
}

export interface DefenseExpectedSourceDto {
  readonly schemaVersion: typeof DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION;
  readonly fiscalYear: number;
  readonly authorityTrack: DefenseAuthorityTrackDto;
  readonly stage: string;
  readonly sourceFamily: string;
  readonly chamber: 'house' | 'senate' | 'joint' | null;
  readonly committee: string | null;
  readonly component: string | null;
  readonly adapterId: string;
  readonly label: string;
  readonly expectedState: DefenseExpectedSourceStateDto;
  readonly optional: boolean;
  readonly expectedFrom: string;
  readonly expectedTo: string;
  /**
   * Explicitly `null` — never `0` — when nothing has been ingested. A consumer
   * that wants dollars must read the governed federal-funding contracts.
   */
  readonly knownFundingPosition: null;
}

export interface DefenseSourceObservationDto {
  readonly schemaVersion: typeof DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION;
  readonly fiscalYear: number;
  readonly authorityTrack: DefenseAuthorityTrackDto;
  readonly stage: string;
  readonly sourceFamily: string;
  readonly adapterId: string;
  readonly discoveredUrl: string;
  /** Authoritative content identity. ETag/Last-Modified are hints only. */
  readonly contentSha256: string;
  readonly byteSize: number | null;
  readonly httpEtag: string | null;
  readonly httpLastModified: string | null;
  readonly observationState: DefenseObservationStateDto;
  readonly classificationConfidence: number | null;
  readonly reviewReasons: readonly string[];
  readonly sourceDocumentId: string | null;
  readonly supersededByObservationId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
}

export type DefenseLifecycleSignalKindDto =
  | 'pb_to_hasc'
  | 'pb_to_sasc'
  | 'pb_to_hac_d'
  | 'pb_to_sac_d'
  | 'house_to_senate'
  | 'latest_mark_to_conference'
  | 'conference_to_enacted'
  | 'source_correction';

export interface DefenseLifecycleSignalDto {
  readonly schemaVersion: typeof DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION;
  readonly signalKind: DefenseLifecycleSignalKindDto;
  readonly fiscalYear: number;
  readonly authorityTrack: DefenseAuthorityTrackDto;
  readonly fromStage: string;
  readonly toStage: string;
  readonly fromContentSha256: string;
  readonly toContentSha256: string;
  readonly emittedAt: string;
  /**
   * The signal is a notification that source evidence changed. Downstream
   * consumers (Meri, CRM, Strategies) decide the workflow; the signal itself
   * asserts no amount, which is why there is no amount field here.
   */
  readonly carriesFundingAmounts: false;
}

export interface DefenseCycleTrackHealthDto {
  readonly authorityTrack: DefenseAuthorityTrackDto;
  readonly expectedSources: number;
  readonly published: number;
  readonly notFiled: number;
  readonly reviewRequired: number;
  readonly superseded: number;
  readonly withdrawn: number;
  readonly unavailable: number;
  readonly stillExpected: number;
}

export interface DefenseCycleHealthDto {
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
  readonly tracks: readonly DefenseCycleTrackHealthDto[];
  readonly nvidiaQueuedPages: 0;
  readonly activeGpuJobs: 0;
  readonly nvidiaRouting: 'disabled';
  readonly productionParser: 'DETERMINISTIC_PRIMARY';
  readonly missingSourceMeansUnknownNotZero: true;
}
