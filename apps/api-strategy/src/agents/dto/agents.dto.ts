import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  MISSION_STATES,
  RUN_STATES,
  type MissionStateValue,
  type RunStateValue,
} from '../run-state.js';

/** SpRunTrigger / SpChangeSetRisk enum value sets (schema-mirrored). */
export const RUN_TRIGGERS = ['manual', 'scheduled', 'event'] as const;
export type RunTriggerValue = (typeof RUN_TRIGGERS)[number];

export const CHANGE_SET_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export type ChangeSetRiskValue = (typeof CHANGE_SET_RISKS)[number];

export const MISSION_CADENCES = ['daily', 'weekly'] as const;
export type MissionCadenceValue = (typeof MISSION_CADENCES)[number];

/** Create a standing mission (state starts at draft; activate via PATCH). */
export class CreateMissionDto {
  @IsOptional()
  @IsUUID()
  strategyId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @IsOptional()
  @IsIn(MISSION_CADENCES)
  cadence?: MissionCadenceValue;
}

/**
 * Partial mission update. `state` changes go through MISSION_TRANSITIONS
 * server-side. `cadence` present-and-null clears it (manual-only mission);
 * `nextRunAt` is an ISO date-time string parsed/validated server-side (null
 * clears — @IsOptional short-circuits null).
 */
export class UpdateMissionDto {
  @IsOptional()
  @IsIn(MISSION_STATES)
  state?: MissionStateValue;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @IsOptional()
  @IsIn(MISSION_CADENCES)
  cadence?: MissionCadenceValue | null;

  @IsOptional()
  @IsString()
  nextRunAt?: string | null;
}

/** Trigger one run of a mission. idempotencyKey dedupes re-triggers per tenant. */
export class CreateRunDto {
  @IsIn(RUN_TRIGGERS)
  trigger!: RunTriggerValue;

  @IsString()
  @MaxLength(200)
  idempotencyKey!: string;

  @IsOptional()
  @IsUUID()
  strategyId?: string;
}

/**
 * Stage F1: trigger a Watcher check run now. idempotencyKey is optional — the
 * service defaults it to `watch:<missionId>:<today>` so a same-day re-trigger
 * refreshes the existing run instead of minting a new one.
 */
export class RunCheckDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

/** Move a run through the RUN_TRANSITIONS state machine. */
export class TransitionRunDto {
  @IsIn(RUN_STATES)
  to!: RunStateValue;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  waitingReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  error?: string;

  /** Raw findings JSON, merged onto the run's existing findings. Shape is
   *  re-checked server-side (must be a plain object). */
  @IsOptional()
  @IsObject()
  findings?: Record<string, unknown>;
}

/**
 * Propose a change-set. `ops` reuse the Meri assistant PlanEdit shape and are
 * re-validated op-by-op on APPLY through the same pipeline (defense-in-depth) —
 * no deep DTO validation here on purpose.
 */
export class CreateChangeSetDto {
  @IsUUID()
  strategyId!: string;

  @IsOptional()
  @IsUUID()
  runId?: string;

  @IsString()
  @MaxLength(500)
  summary!: string;

  @IsArray()
  @ArrayMaxSize(60)
  ops!: unknown[];

  @IsIn(CHANGE_SET_RISKS)
  risk!: ChangeSetRiskValue;
}

/** Approve a change-set; opIndexes selects a SUBSET of ops (indexes into ops). */
export class ApproveChangeSetDto {
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  opIndexes?: number[];
}

/** Execution-Agent artifact kind (Stage G). */
export const EXECUTION_KINDS = ['workspace', 'outreach'] as const;
export type ExecutionKindValue = (typeof EXECUTION_KINDS)[number];

/**
 * Stage G: plan an Execution-Agent run for one node. A run belongs to a mission
 * (RunsService contract), so `missionId` anchors it and the strategy is derived
 * from the mission; `strategyId` is an OPTIONAL override (a firm-level mission
 * carries no strategy, so it must be supplied then) — mirroring CreateRunDto.
 * `pinnedVersionId`, when present, is the strategy head an earlier approval was
 * computed against; G0 parks the run on version drift if it moved.
 */
export class ExecutionPlanDto {
  @IsUUID()
  missionId!: string;

  @IsOptional()
  @IsUUID()
  strategyId?: string;

  @IsUUID()
  nodeId!: string;

  @IsIn(EXECUTION_KINDS)
  kind!: ExecutionKindValue;

  @IsOptional()
  @IsUUID()
  pinnedVersionId?: string;
}

/** P0-2: a reviewer declaring a stuck run dead ("Mark failed"). */
export class MarkRunFailedDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/**
 * P0-2: operator resolution for a surviving staging reservation — the ONE
 * recovery case reconciliation cannot decide for itself, because
 * ExecutionArtifactClient is create-only and cannot ask upstream whether the
 * artifact exists.
 *
 *  - 'adopt'   requires artifactRef: the operator FOUND the created document and
 *              is linking it, so the run can advance without a duplicate.
 *  - 'release' drops the reservation: the operator confirmed nothing was created,
 *              so a retry may stage cleanly.
 *
 * Both branches are unrecoverable if wrong, which is exactly why they are an
 * explicit human decision rather than a guess.
 */
export const RESERVATION_ACTIONS = ['adopt', 'release'] as const;
export type ReservationActionValue = (typeof RESERVATION_ACTIONS)[number];

export class ResolveReservationDto {
  @IsIn(RESERVATION_ACTIONS)
  action!: ReservationActionValue;

  /** Required for 'adopt' (re-checked in the service, which also rejects the sentinel). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  artifactRef?: string;
}

/**
 * P0-3: approve the EXACT payload the reviewer saw.
 *
 * contentHash is REQUIRED — it is the reviewer's assertion of what they were
 * looking at. The service 409s when the live payload no longer hashes to it, so
 * an approval can never land on content nobody reviewed. Deliberately not
 * optional: an approve call without a hash is exactly the "approved metadata,
 * not the payload" defect P0-3 exists to close.
 */
export class ApproveExactDraftDto {
  @IsString()
  @MaxLength(128)
  contentHash!: string;
}

/** P0-3: refuse or withdraw an approval. */
export class RejectApprovalDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
