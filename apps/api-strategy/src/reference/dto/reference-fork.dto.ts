import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** UI-level reference kinds the editor forks (REF-5). */
export const REFERENCE_UI_KINDS = ['congress', 'ppbe'] as const;
export type ReferenceUiKind = (typeof REFERENCE_UI_KINDS)[number];

/**
 * A reference override row. Congress milestones carry label + startsOn/endsOn
 * (the web converts quarter positions → real dates, REF-6/D2); PPBE
 * current-phase rows carry fy + label (phase text), no dates. Per-kind
 * requirements are enforced in the service.
 */
export class ReferenceRowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startsOn must be YYYY-MM-DD' })
  startsOn?: string | null;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endsOn must be YYYY-MM-DD' })
  endsOn?: string | null;

  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  fy?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tone?: string | null;
}

export class ReferenceForkDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ReferenceRowDto)
  rows!: ReferenceRowDto[];
}
