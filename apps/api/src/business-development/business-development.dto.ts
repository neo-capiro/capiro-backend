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
} from 'class-validator';

/**
 * Business Development Phase 1 DTOs. Validation is enforced by the global
 * ValidationPipe; these shapes ARE the route contract for the frontend worker.
 */

export const BIZDEV_STAGES = [
  'researching',
  'qualified',
  'outreach',
  'meeting',
  'proposal',
  'won',
  'lost',
  'parked',
] as const;
export type BizDevStage = (typeof BIZDEV_STAGES)[number];

/** Stage values that mean a firm won or lost the engagement. */
export const BIZDEV_STAGE = { WON: 'won', LOST: 'lost' } as const;

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
