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
