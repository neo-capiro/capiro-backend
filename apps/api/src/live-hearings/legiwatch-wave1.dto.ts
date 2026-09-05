/**
 * LegiWatch V2 Wave 1 — request DTOs.
 *
 * The global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so every
 * accepted field must be declared here or the request 400s. Booleans arrive as
 * query/body strings from some clients, hence the explicit @Transform on the
 * query DTOs.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Coerce the several shapes a boolean arrives in. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return value;
};

// ── W1-1 · follow configuration ────────────────────────────────────────────

export class FollowConfigDto {
  /**
   * The clients this follow is FOR. Client IDs are the identity keys, so this
   * is validated as UUIDs and then checked against the caller's own tenant.
   */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  clientIds?: string[];

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnScheduleChange?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnHearingStarting?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnTranscriptReady?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnHighPriorityMatch?: boolean;
}

// ── W1-2 · attendance request ──────────────────────────────────────────────

export class AttendanceRequestDto {
  /**
   * Which mechanism the user chose. The server re-derives whether that mode is
   * actually available and refuses the request if it is not, so this is a
   * request, never a grant.
   */
  @IsOptional()
  @IsIn(['automatic', 'browser'])
  mode?: 'automatic' | 'browser';

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  consentAcknowledged?: boolean;
}

// ── W1-3 · archive search ──────────────────────────────────────────────────

export class ArchiveSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  q?: string;

  /** Inclusive `YYYY-MM-DD` bounds on the official calendar day. */
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsIn(['house', 'senate', 'joint', 'House', 'Senate', 'Joint'])
  chamber?: string;

  /** `congress_committee.system_code`. */
  @IsOptional()
  @IsString()
  committee?: string;

  @IsOptional()
  @IsString()
  subcommittee?: string;

  @IsOptional()
  @IsIn(['scheduled', 'postponed', 'canceled', 'in_progress', 'completed'])
  eventStatus?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasTranscript?: boolean;

  @IsOptional()
  @IsIn([
    'QUESTION',
    'COMMITMENT',
    'DEADLINE',
    'FUNDING_AMOUNT',
    'BILL_REFERENCE',
    'PROGRAM_ELEMENT_REFERENCE',
    'AGENCY_REFERENCE',
    'POLICY_POSITION',
    'KEY_QUOTE',
    'MENTION',
  ])
  intelligenceType?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsIn(['HIGH', 'MEDIUM', 'LOW'])
  relevanceBand?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

// ── W1-4 · committee follow ────────────────────────────────────────────────

export class CommitteeFollowDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  clientIds?: string[];

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnNewHearing?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnScheduleChange?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnTranscriptReady?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  notifyOnHighPriorityMatch?: boolean;
}

export class CommitteeIntelligenceQueryDto {
  @IsOptional()
  @IsString()
  insightType?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

// ── W1-6 · client relevance ────────────────────────────────────────────────

export class ClientRelevanceQueryDto {
  /** Absent = the All-Clients ranked view over the caller's own client list. */
  @IsOptional()
  @IsUUID()
  clientId?: string;
}

// ── W1-7 · saved items and actions ─────────────────────────────────────────

export class SaveItemDto {
  @IsIn(['moment', 'finding', 'hearing'])
  kind!: 'moment' | 'finding' | 'hearing';

  /** Required for `moment`; validated to belong to this hearing. */
  @IsOptional()
  @IsString()
  segmentId?: string;

  /** Required for `finding`; validated to belong to this hearing. */
  @IsOptional()
  @IsString()
  insightId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class SavedItemsQueryDto {
  @IsOptional()
  @IsString()
  hearingId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AskMeriDto {
  @IsOptional()
  @IsString()
  segmentId?: string;

  @IsOptional()
  @IsString()
  insightId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  question?: string;
}

export class BriefPrefillDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /** Explicit finding selection; validated to belong to this hearing. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  insightIds?: string[];
}

export class OutreachPrefillDto {
  /** Outreach is always client-scoped, so this is required. */
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsString()
  insightId?: string;

  @IsOptional()
  @IsString()
  segmentId?: string;
}

// ── W1-5 · notification inbox ──────────────────────────────────────────────

export class NotificationInboxQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

// ── Hearing Detail V2 ──────────────────────────────────────────────────────

export class DetailV2QueryDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
