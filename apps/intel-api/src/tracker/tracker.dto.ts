import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { EXPECTED_CONFIDENCE_LEVELS, EXPECTED_MILESTONE_TYPES } from '@capiro/shared';

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
