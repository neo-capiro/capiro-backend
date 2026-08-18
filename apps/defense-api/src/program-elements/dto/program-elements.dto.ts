import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Frozen-contract query/body DTOs for the Session 3 Program Elements surface.
 * Field shapes mirror @capiro/defense-contracts' public route query/body
 * interfaces (ProgramElementCatalogQuery, CreateProgramElementDataIssueBody,
 * etc.) exactly, adding class-validator decorators for the NestJS
 * ValidationPipe boundary. This DTO layer is new source, not a copy of
 * apps/api's DTO classes.
 */
export class QueryProgramElementsDto {
  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  budget_activity?: string;

  @IsOptional()
  @IsString()
  q?: string;

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
  limit?: number;

  @IsOptional()
  @IsString()
  @IsIn(['markup-monitor'])
  mode?: 'markup-monitor';

  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  has_data?: string;

  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  watched?: string;

  @IsOptional()
  @IsString()
  line_type?: string;

  @IsOptional()
  @IsString()
  capability?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  divergence_threshold?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  deltaType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minScore?: number;
}

export class SetPeAlertEmailPrefDto {
  @IsIn(['off', 'daily', 'daily_plus_critical'])
  mode!: string;
}

export class WatchProgramElementDto {
  @Type(() => Boolean)
  watching!: boolean;
}

export class CreatePeDataIssueDto {
  @IsIn([
    'value_incorrect',
    'missing_value',
    'wrong_source',
    'wrong_stage_or_vehicle',
    'wrong_pe_attribution',
    'other',
  ])
  issueType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fy?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fieldName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  suggestedSourceUrl?: string;
}

export class ListPeDataIssuesQueryDto {
  @IsOptional()
  @IsIn(['open', 'resolved', 'dismissed'])
  status?: string;

  @IsOptional()
  @IsString()
  peCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class ResolvePeDataIssueDto {
  @IsIn(['resolved', 'dismissed'])
  status!: 'resolved' | 'dismissed';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolutionNotes?: string;
}

export class ResolveReconciliationDto {
  @IsIn(['keep_current', 'accept_conflicting', 'manual_value'])
  decision!: 'keep_current' | 'accept_conflicting' | 'manual_value';

  @IsOptional()
  manualValue?: string | number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ProgramSearchDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class MatchQueueQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class ResolveMatchDto {
  @IsIn(['accept', 'reject', 'quarantine'])
  decision!: 'accept' | 'reject' | 'quarantine';

  @IsOptional()
  @IsString()
  notes?: string;
}

const ALIAS_TYPES = [
  'canonical',
  'acronym',
  'pe_title',
  'project_title',
  'p1_line_name',
  'mdap_name',
  'office_usage',
  'congressional',
  'sam_usage',
  'award_usage',
] as const;

export class CreateAliasDto {
  @IsString()
  alias!: string;

  @IsIn(ALIAS_TYPES)
  aliasType!: string;

  @IsOptional()
  @IsString()
  source?: string;
}

export class UpdateAliasDto {
  @IsOptional()
  @IsString()
  alias?: string;

  @IsOptional()
  @IsIn(ALIAS_TYPES)
  aliasType?: string;
}

export class MergeProgramsDto {
  @IsString()
  keepProgramId!: string;

  @IsString()
  mergeProgramId!: string;
}
