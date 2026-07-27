import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { BILL_STAGES, EXPECTED_CONFIDENCE_LEVELS, EXPECTED_MILESTONE_TYPES } from '@capiro/shared';

/**
 * DTOs for the P1.1 aux tracker endpoints (ported from apps/api
 * tracker.dto.ts). The global ValidationPipe is whitelist +
 * forbidNonWhitelisted, so each route body/query needs an explicit class.
 */

/**
 * Shared allowlists for the tracker board + watchlist DTOs below (Gate A,
 * P1-03/P1-04). Exported so the service layer and Gate B's watchlist DTOs
 * reuse them rather than re-declaring.
 */
// Must match DEFAULT_TRIGGERS (tracker-watchlist.service.ts) and TRIGGER_ORDER
// (apps/web tracker-api.ts) exactly, same order — verified against both 2026-07-25.
export const ALERT_TRIGGER_KEYS = [
  'newMatch',
  'amendment',
  'hearing',
  'committeeVote',
  'floorVote',
  'enactedFailed',
  'fiscalNote',
  'sponsorMomentum',
  'companion',
  'deadline',
] as const;
export const MATERIALITY_VALUES = ['low', 'medium', 'high'] as const;
export const EMAIL_CADENCE_VALUES = ['realtime', 'daily', 'weekly'] as const;
export const SMS_CADENCE_VALUES = ['realtime', 'daily'] as const;
export const TAG_POSITIONS = ['support', 'oppose', 'monitor'] as const;
export const TAG_PRIORITIES = ['low', 'med', 'high'] as const;
/** Gate E phase a (P1-18) — the board's 4 lanes, for BoardQueryDto.stages. */
const BOARD_STAGE_IDS = BILL_STAGES.map((s) => s.id);
// Derived from ALLOWED_FEEDBACK_SIGNALS (tracker-board.service.ts) — the actual
// runtime allowlist, not the smaller set the finding's own writeup guessed.
export const FEEDBACK_SIGNALS = [
  'useful',
  'not_useful',
  'wrong_impact',
  'wrong_urgency',
  'false_positive',
  'missed',
  'tracked',
  'dismissed',
  'marked_irrelevant',
  'opened',
] as const;

export class BillSearchQueryDto {
  @IsString()
  q!: string;

  /**
   * P1-17: which rails to search. Absent = federal only, which keeps every
   * existing caller (including the Workspace ContextBuilder) byte-identical.
   * 'US' plus state codes searches both. Each entry is a 2-letter code, so
   * MaxLength(2) also bounds the state fan-out.
   *
   * A single value arrives as a string from the query string, so it is
   * normalised to an array before validation.
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null ? undefined : Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @ArrayMaxSize(56)
  @IsString({ each: true })
  @MaxLength(2, { each: true })
  jurisdictions?: string[];
}

/**
 * Body for PUT /clients/:c/bills/:b/context (Bill 360, Release R1, §1.3). Every
 * field is OPTIONAL so a partial PUT never nulls unspecified context; `note` is
 * intentionally NOT here (the write must never touch the legacy note). All fields
 * are analyst-owned context and never affect the canonical bill status.
 */
export class UpdateBillContextDto {
  @IsOptional()
  @IsIn(['support', 'oppose', 'monitor'])
  position?: string;

  @IsOptional()
  @IsIn(['low', 'med', 'high'])
  priority?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  analystNote?: string;

  @IsOptional()
  @IsIn([...EXPECTED_MILESTONE_TYPES])
  expectedMilestoneType?: string;

  @IsOptional()
  @IsDateString()
  expectedWindowStart?: string;

  @IsOptional()
  @IsDateString()
  expectedWindowEnd?: string;

  @IsOptional()
  @IsIn([...EXPECTED_CONFIDENCE_LEVELS])
  expectedConfidence?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  expectedRationale?: string;
}

export class SmsStartDto {
  @IsString()
  @MaxLength(20)
  phone!: string;
}

export class SmsConfirmDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsString()
  @MaxLength(6)
  code!: string;
}

export class TestAlertDto {
  @IsArray()
  @IsIn(['email', 'sms', 'in_app'], { each: true })
  channels!: ('email' | 'sms' | 'in_app')[];
}

/** Body for POST .../tracker/track (Gate A, P1-03/P1-04). */
export class TrackBillDto {
  @IsString()
  @MaxLength(64)
  billId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  source?: string;

  @IsOptional()
  @IsBoolean()
  isManual?: boolean;
}

/** Body for POST .../tracker/untrack (Gate A, P1-03/P1-04). */
export class UntrackBillDto {
  @IsString()
  @MaxLength(64)
  billId!: string;
}

/** Body for POST .../tracker/feedback (Gate A, P1-03/P1-04). */
export class RecordFeedbackDto {
  @IsString()
  @MaxLength(128)
  targetRef!: string;

  @IsIn(FEEDBACK_SIGNALS as unknown as string[])
  signal!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  alertId?: string | null;
}

/**
 * Body for PUT .../tracker/watchlists/:clientId/alert-prefs (Gate A,
 * P1-03/P1-04). `emailAddress` uses `@ValidateIf` rather than a bare
 * `@IsEmail()` because the Configure panel sends `emailAddress.trim() || null`
 * — a plain `@IsEmail()` would 400 every save made while the field is empty,
 * which is the normal pre-typing state. `quietHours*` accepts a single-digit
 * hour because the Configure panel's quiet-hours inputs are free text, not a
 * time picker — do not make an existing saved value un-saveable.
 */
export class PutAlertPrefsDto {
  @IsOptional()
  @IsArray()
  @IsIn(ALERT_TRIGGER_KEYS as unknown as string[], { each: true })
  triggers?: string[];

  @IsOptional()
  @IsIn(MATERIALITY_VALUES as unknown as string[])
  materiality?: string;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @ValidateIf((o) => o.emailAddress !== null && o.emailAddress !== undefined && o.emailAddress !== '')
  @IsEmail()
  @MaxLength(320)
  emailAddress?: string | null;

  @IsOptional()
  @IsIn(EMAIL_CADENCE_VALUES as unknown as string[])
  emailCadence?: string;

  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  smsPhone?: string | null;

  @IsOptional()
  @IsIn(SMS_CADENCE_VALUES as unknown as string[])
  smsCadence?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]?\d|2[0-3]):[0-5]\d$/)
  quietHoursStart?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^([01]?\d|2[0-3]):[0-5]\d$/)
  quietHoursEnd?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2, { each: true })
  jurisdictions?: string[];
}

/**
 * Every term type the system persists: the 11 canonical UI types + the 3 legacy
 * chip types + `keyword` (Gate B phase a, P0-04/P0-05). Keep in lockstep with
 * apps/web tracker-api.ts TERM_TYPES.
 */
export const WATCHLIST_TERM_TYPES = [
  'bill', 'agency', 'committee', 'legislator', 'company', 'competitor', 'topic',
  'risk_phrase', 'support_language', 'opposition_language', 'program_element',
  'synonym', 'entity', 'risk', 'keyword',
] as const;

export class WatchlistTermDto {
  @IsIn(WATCHLIST_TERM_TYPES as unknown as string[]) termType!: string;
  @IsString() @MaxLength(200) value!: string;
}

export class WatchlistTopicDto {
  @IsString() @MinLength(1) @MaxLength(120) label!: string;
  @IsOptional() @IsString() @MaxLength(120) issueArea?: string | null;
  @IsOptional() @IsIn(TAG_POSITIONS as unknown as string[]) position?: string;
  @IsOptional() @IsIn(TAG_PRIORITIES as unknown as string[]) priority?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => WatchlistTermDto)
  @ArrayMaxSize(500) terms?: WatchlistTermDto[];
  /** P0-03 item 5: rename this topic, preserving its id and term/alert association. */
  @IsOptional() @IsString() @MaxLength(120) renameFrom?: string;
}

/**
 * Query for GET .../tracker/board (Gate E phase a, P1-18). Every field is
 * OPTIONAL and defaults OFF (MASTER §4.5) — an absent query is BYTE-IDENTICAL
 * to the pre-Gate-E default page (bounded at `LEGIWATCH_BOARD_PAGE_SIZE`, no
 * filter narrowing). `enableImplicitConversion` is off globally
 * (main.ts), so numeric/boolean query values need an explicit `@Transform`.
 */
export class BoardQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  limit?: number;

  /** Opaque keyset cursor from a previous page's `nextCursor`. A malformed one is ignored (page 1), never a 400. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  changedWithinDays?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  activeOnly?: boolean;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null ? undefined : Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(BOARD_STAGE_IDS as unknown as string[], { each: true })
  stages?: string[];

  /** Tenant (`_all`) board only — ignored on a single-client board. */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null ? undefined : Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  clientIds?: string[];
}

/** Body for PUT .../tracker/watchlists/:clientId (Gate B phase a, P0-03/P0-04/P0-05). */
export class PutWatchlistDto {
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50) issueAreas?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => WatchlistTopicDto)
  @ArrayMaxSize(200) topics?: WatchlistTopicDto[];
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(2, { each: true }) @ArrayMaxSize(56)
  jurisdictions?: string[];
  /** P1-02: optimistic concurrency. Absent = unversioned legacy client → the service
   *  accepts it and logs, so an un-updated bundle is not hard-broken. */
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}
