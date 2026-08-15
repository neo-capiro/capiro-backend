import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const QUICK_DRAFT_SOURCE_PURPOSES = [
  'context',
  'client_saved',
  'sample',
  'system',
] as const;

export type QuickDraftSourcePurpose =
  (typeof QUICK_DRAFT_SOURCE_PURPOSES)[number];

/**
 * One source selected on the simplified Workspace intake screen.
 *
 * `sample` sources are style/structure references only. They must never be
 * treated as factual evidence. `system` sources describe an internal context
 * domain that Meri should use while planning the draft.
 */
export class QuickDraftSourceDto {
  @IsIn(QUICK_DRAFT_SOURCE_PURPOSES)
  purpose!: QuickDraftSourcePurpose;

  @IsString()
  @MaxLength(240)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  refId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceType?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

/**
 * Generate the first complete draft directly from the one-screen intake.
 * The draft must already be initialized with a published blueprint version.
 */
export class GenerateFromIntakeDto {
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsString()
  @MaxLength(10_000)
  goal!: string;

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => QuickDraftSourceDto)
  sources!: QuickDraftSourceDto[];
}
