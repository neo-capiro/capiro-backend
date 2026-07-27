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
// Gate E phase f (§4.10) added memo_generated/memo_heavily_edited/
// outreach_generated/alert_ignored — each fired from an existing success
// handler, never a new table. Deliberately NOT added: false_positive/
// missed_alert have no UI to report them, and an unreachable signal is noise.
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
  'memo_generated',
  'memo_heavily_edited',
  'outreach_generated',
  'alert_ignored',
] as const;

/**
 * §4.10 (Gate E phase f): the five structured dismiss reasons the picker
 * offers, plus the implicit "no reason given" (omit the field — Just hide
 * it). Only `too_broad` and `wrong_issue` are MATCH-QUALITY signals that
 * feed scoreBillFit's down-weighting (bill-fit.util.ts) — `already_handled`
 * says nothing about whether the topic over-matches (f-4/f-7 case 6).
 */
export const FEEDBACK_REASONS = [
  'wrong_issue',
  'wrong_entity',
  'too_broad',
  'already_handled',
  'not_actionable',
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

  /** §4.10 (Gate E phase f): structured dismiss reason — only meaningful
   *  alongside signal='marked_irrelevant'; the service does not enforce that
   *  pairing (a reason on another signal is simply ignored downstream). */
  @IsOptional()
  @IsIn(FEEDBACK_REASONS as unknown as string[])
  reason?: string;

  /** §4.10 (Gate E phase f): the watchlist topic labels this bill matched at
   *  dismissal time (the web already has them, RecommendationBill.matchedTags)
   *  — this is the link feedbackSignal aggregates by. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  @ArrayMaxSize(20)
  matchedTags?: string[];

  /**
   * Gate K (MP-09): the topic IDS behind matchedTags's topic entries (never
   * issue areas — RecommendationBill.matchedTopicIds). feedbackSignal
   * prefers this over matchedTags/label, so a topic rename no longer severs
   * its accumulated dismissal signal. Optional: an un-updated web bundle
   * omits it, which is byte-identical to today's label-only behavior.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ArrayMaxSize(20)
  matchedTopicIds?: string[];
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

  // MP-04: `@ValidateIf` fires when EITHER a non-empty address was sent
  // (the original rule — validate its FORMAT whenever one is present,
  // regardless of emailEnabled) OR emailEnabled is explicitly true (the new
  // rule — null/undefined/'' then FAIL @IsEmail(), since none of those is a
  // valid email, closing the "Email ON with no address" gap). Keyed strictly
  // on `emailEnabled === true`, never on emailAddress alone, so disabling
  // email (emailEnabled: false) with no address still validates fine.
  //
  // Deliberately NO `@IsOptional()` here: class-validator's @IsOptional
  // unconditionally skips ALL validators on a property when the value is
  // null/undefined, regardless of what @ValidateIf's condition evaluates to
  // — which would silently defeat this exact rule for the omitted/null cases
  // (the two most likely shapes a client that flips the toggle without
  // typing an address would send). @ValidateIf alone already provides the
  // "optional unless" gate: when its condition is false the property is
  // skipped entirely, same as @IsOptional would give — just without the
  // unconditional null/undefined bypass.
  @ValidateIf(
    (o) =>
      o.emailEnabled === true ||
      (o.emailAddress !== null && o.emailAddress !== undefined && o.emailAddress !== ''),
  )
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
  /**
   * Gate K (MP-08, b-2): the client echoes this back on every save (a real
   * server id for an existing topic, or a client-minted temp id for a new,
   * unsaved one). The global ValidationPipe is whitelist+forbidNonWhitelisted
   * (MASTER §6.10) — omitting this declaration 400s every watchlist save the
   * moment the web starts sending it. The server does not use this value for
   * anything (topics are still upserted by label); it exists purely so the
   * echo round-trips without being rejected.
   */
  @IsOptional() @IsString() @MaxLength(64) id?: string;
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
  /**
   * P1-02: optimistic concurrency. Absent = unversioned legacy client — the
   * service accepts-and-logs until `EXPECTED_VERSION_REQUIRED_FROM`
   * (tracker-watchlist.service.ts, Gate J/MP-02, 2026-08-10), then 428s.
   * KEEP `@IsOptional()` here even after that date: the cutover is a service-
   * level business-hours check with a distinct 428 + explanatory message,
   * not a DTO-shape requirement — dropping it would make the ValidationPipe
   * reject with a generic 400 before the service's clearer error ever runs.
   */
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}
