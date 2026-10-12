import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
  MinLength,
  IsDateString,
  ValidateNested,
} from 'class-validator';

/**
 * Business Development Phase 1 DTOs. Validation is enforced by the global
 * ValidationPipe; these shapes ARE the route contract for the frontend worker.
 */

import { BIZDEV_STAGES, type BizDevStage } from './prospect-stages.js';
export { BIZDEV_STAGES, type BizDevStage } from './prospect-stages.js';

/** Stage values that mean a firm won or lost the engagement. */
export const BIZDEV_STAGE = { WON: 'won', LOST: 'lost' } as const;

// ── Phase 5 — watch & alerts ────────────────────────────────────────────────

/** Watch lifecycle statuses (SQL CHECK on business_development_watches). */
export const BIZDEV_WATCH_STATUSES = ['active', 'paused', 'ended'] as const;
export type BizDevWatchStatusValue = (typeof BIZDEV_WATCH_STATUSES)[number];

/** Alert categories stored per alert (SQL CHECK on business_development_alerts). */
export const BIZDEV_ALERT_CATEGORIES = [
  'contract_award',
  'assistance_award',
  'opportunity',
  'lobbying',
  'acquisition',
  'entity_change',
  'other',
] as const;
export type BizDevAlertCategoryValue = (typeof BIZDEV_ALERT_CATEGORIES)[number];

/** POST .../prospects/:prospectId/watch body. All fields optional. */
export class ActivateBizDevWatchDto {
  /** Alert categories the owner wants surfaced (subset of the Phase 5
   * category vocabulary; empty/absent = all categories). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(BIZDEV_ALERT_CATEGORIES as unknown as string[], { each: true })
  categories?: string[];

  /** Owner override; validated as an ACTIVE member of this tenant. */
  @IsOptional()
  @IsUUID()
  ownerUserId?: string;
}

/** PATCH .../prospects/:prospectId/watch body. At least one field required. */
export class UpdateBizDevWatchDto {
  /** Lifecycle transition. Every change bumps preferenceVersion. */
  @IsOptional()
  @IsIn(BIZDEV_WATCH_STATUSES as unknown as string[])
  status?: BizDevWatchStatusValue;

  /** ISO-8601 mute-until timestamp; null clears the mute. */
  @IsOptional()
  @IsDateString()
  mutedUntil?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(BIZDEV_ALERT_CATEGORIES as unknown as string[], { each: true })
  categories?: string[];

  @IsOptional()
  @IsUUID()
  ownerUserId?: string | null;
}

/** GET .../prospects/:prospectId/alerts query. */
export class ListProspectAlertsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  /** Opaque cursor from a previous page (firstObservedAt + id keyset). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

/** GET /business-development/alerts query (top-bar notification center). */
export class ListTenantAlertsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** true = only unread-for-current-user alerts. */
  @IsOptional()
  @IsBoolean()
  @Transform(transformQueryBoolean)
  unreadOnly?: boolean;
}

/** Route params for alert-scoped routes. */
export class AlertIdParam {
  @IsUUID()
  prospectId!: string;

  @IsUUID()
  alertId!: string;
}

/**
 * URL query strings arrive as text: class-transformer's `@Type(() => Boolean)`
 * coerces the literal STRING 'false' to boolean TRUE, so query booleans use
 * this transform instead ('true'/'1' → true, 'false'/'0' → false; anything
 * else passes through so @IsBoolean() rejects it). JSON-body booleans (already
 * real booleans) are untouched.
 */
export function transformQueryBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
}

export class ListProspectsQueryDto {
  /** Status slice: active (default), dismissed, or all. */
  @IsOptional()
  @IsIn(['active', 'dismissed', 'all'] as unknown as string[])
  status?: 'active' | 'dismissed' | 'all';

  /** Filter by stage. */
  @IsOptional()
  @IsIn(BIZDEV_STAGES as unknown as string[])
  stage?: BizDevStage;

  /** Legacy alias for status=all. */
  @IsOptional()
  @IsBoolean()
  @Transform(transformQueryBoolean)
  includeDismissed?: boolean;

  /** Filter by owner (user id). */
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  /** Filter by conflict/exclusion flag. */
  @IsOptional()
  @IsBoolean()
  @Transform(transformQueryBoolean)
  conflictExcluded?: boolean;

  /** Filter by conversion link: true = converted, false = not converted. */
  @IsOptional()
  @IsBoolean()
  @Transform(transformQueryBoolean)
  linkedClient?: boolean;

  /** Text match on display name (case-insensitive contains). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

export class CreateProspectDto {
  /** Manual (unresolved) prospects: a free-form name is enough. When
   * canonicalEntityId is provided the prospect is a confirmed
   * canonical-organization prospect and displayName defaults from it. */
  @IsOptional()
  @IsUUID()
  canonicalEntityId?: string;

  @IsString()
  @MaxLength(200)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  serviceHypothesis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  geography?: string;

  /** Owner must be an ACTIVE member of this tenant (validated server-side). */
  @IsOptional()
  @IsUUID()
  ownerUserId?: string;

  /** Defaults to Researching when omitted. */
  @IsOptional()
  @IsIn(BIZDEV_STAGES as unknown as string[])
  stage?: BizDevStage;
}

/** Advisory, tenant-only duplicate check before a manual prospect is saved. */
export class PreviewDuplicateHintsDto {
  @IsString()
  @MaxLength(200)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @IsOptional()
  @IsUUID()
  canonicalEntityId?: string;
}

export class UpdateProspectDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  domain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  serviceHypothesis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  geography?: string;

  /** Changing the owner re-validates ACTIVE membership of this tenant. */
  @IsOptional()
  @IsUUID()
  ownerUserId?: string | null;

  /** Stage change. `won` is accepted as a stage only — setting it NEVER
   * converts; conversion is its own explicit, transactional operation. */
  @IsOptional()
  @IsIn(BIZDEV_STAGES as unknown as string[])
  stage?: BizDevStage;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  nextAction?: string | null;

  /** Due date for the next action (ISO 8601). Explicit null clears it. */
  @IsOptional()
  @IsDateString()
  nextActionDueAt?: string | null;

  @IsOptional()
  @IsBoolean()
  watchRequested?: boolean;
}

export class ResolveProspectIdentityDto {
  /** Confirmed canonical organization identity for a previously unresolved
   * prospect. The prospect keeps its id and full history; no global
   * organization is ever created or merged here. */
  @IsUUID()
  canonicalEntityId!: string;
}

export class AddNoteDto {
  @IsString()
  @MaxLength(4000)
  body!: string;
}

export class UpdateConflictDto {
  @IsBoolean()
  conflictExcluded!: boolean;

  /** Sensitive: writable only by user_admin / capiro_admin (controller-level
   * @Roles), and only when excluding. Cleared to null when un-excluding. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  conflictReason?: string;
}

export class SavePreferencesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  practiceServiceAreas?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  agenciesIssues?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  geographies?: string[];
}

export class ConvertProspectDto {
  /** Link an explicitly selected same-tenant existing client instead of
   * creating one. Validated same-tenant in the same transaction. */
  @IsOptional()
  @IsUUID()
  existingClientId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  clientWebsite?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  clientDescription?: string;
}

export class SearchCanonicalQueryDto {
  @IsString()
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

export class SearchClientsQueryDto {
  @IsString()
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

// ── Phase 2 — candidate search + dossier DTOs ──────────────────────────────

/** Section kinds mirror DOSSIER_SECTION_KINDS (bizdev-evidence.types.ts). */
export const BIZDEV_DOSSIER_SECTIONS = [
  'identity',
  'government_exposure',
  'relevant_signals',
  'footprint',
  'lobbying',
  'people',
] as const;

export class SearchCandidatesQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  agency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  issue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  geography?: string;

  /** Exact case-insensitive match against the caller tenant's saved
   *  prospect.serviceHypothesis. Absent/whitespace = unfiltered. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  service?: string;

  /** Strict '0' | '1' opt-in to include conflictExcluded entities. */
  @IsOptional()
  @IsIn(['0', '1'])
  includeExcluded?: '0' | '1';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25)
  @Type(() => Number)
  limit?: number;

  @IsInt()
  @Min(0)
  @Max(500)
  @IsOptional()
  @Type(() => Number)
  offset?: number;
}

export class CompanyDossierQueryDto {
  @IsOptional()
  @IsIn(BIZDEV_DOSSIER_SECTIONS)
  section?: (typeof BIZDEV_DOSSIER_SECTIONS)[number];
}

export class ProspectDossierQueryDto {
  @IsOptional()
  @IsIn(BIZDEV_DOSSIER_SECTIONS)
  section?: (typeof BIZDEV_DOSSIER_SECTIONS)[number];
}

export class CanonicalEntityIdParam {
  @IsUUID()
  canonicalEntityId!: string;
}

export class DismissProspectDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string;
}

// ── Phase 4 — prospect brief DTOs ──────────────────────────────────────────

/** Section keys mirror BRIEF_SECTION_KEYS (bizdev-brief.types.ts). */
export const BIZDEV_BRIEF_SECTION_KEYS = [
  'companyAndFirmImplication',
  'verifiedEvidence',
  'judgment',
  'practicalAction',
  'missingInformation',
] as const;

export const BIZDEV_BRIEF_PROVENANCES = ['generated', 'edited'] as const;

/** Every brief write is idempotent: a required client-supplied key. */
export class BriefIdempotencyDto {
  @IsString()
  @MinLength(8)
  @MaxLength(400)
  idempotencyKey!: string;
}

export class BriefSectionContentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;

  @IsIn(BIZDEV_BRIEF_PROVENANCES)
  provenance!: 'generated' | 'edited';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsInt({ each: true })
  @Min(0, { each: true })
  citationIndexes?: number[];
}

class BriefSectionsDto {
  @Type(() => BriefSectionContentDto)
  @ValidateNested({ each: true })
  companyAndFirmImplication!: BriefSectionContentDto;

  @Type(() => BriefSectionContentDto)
  @ValidateNested({ each: true })
  verifiedEvidence!: BriefSectionContentDto;

  @Type(() => BriefSectionContentDto)
  @ValidateNested({ each: true })
  judgment!: BriefSectionContentDto;

  @Type(() => BriefSectionContentDto)
  @ValidateNested({ each: true })
  practicalAction!: BriefSectionContentDto;

  @Type(() => BriefSectionContentDto)
  @ValidateNested({ each: true })
  missingInformation!: BriefSectionContentDto;
}

export class CreateBriefVersionDto extends BriefIdempotencyDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;
}

export class SaveBriefVersionDto extends BriefIdempotencyDto {
  /** Optimistic concurrency: the version the caller expects to build on.
   * Required — concurrent edits must never silently overwrite. */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  expectedVersionNumber!: number;

  @Type(() => BriefSectionsDto)
  @ValidateNested()
  sections!: BriefSectionsDto;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;
}

export class AcceptBriefRefreshDto extends BriefIdempotencyDto {
  /** The version the proposal was built from; the accepted proposal becomes
   * that version's successor only if it is still current. */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  expectedVersionNumber!: number;

  @IsOptional()
  @IsBoolean()
  keepUserEdits?: boolean;
}

export class BriefCitationParam {
  @IsUUID()
  prospectId!: string;
}

export class BriefVersionParam {
  @IsUUID()
  prospectId!: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  versionNumber!: number;
}

export class ResolveBriefCitationQueryDto {
  /** 0-based index into the CURRENT version's citation list. */
  @IsInt()
  @Min(0)
  @Max(11)
  @Type(() => Number)
  index!: number;
}

export class CheckBriefClaimDto {
  @IsUUID()
  prospectId!: string;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  versionNumber!: number;

  @IsInt()
  @Min(0)
  @Max(11)
  @Type(() => Number)
  citationIndex!: number;

  @IsIn(['identity', 'citation', 'exact_amount', 'date', 'stage'])
  claimType!: 'identity' | 'citation' | 'exact_amount' | 'date' | 'stage';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  expected?: string;
}
