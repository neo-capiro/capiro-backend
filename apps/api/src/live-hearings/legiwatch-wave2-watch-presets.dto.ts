/**
 * LegiWatch V2 Wave 2 (W2-4) — Watch Presets + backtest request DTOs.
 *
 * `conditions` is validated as a closed, enumerated array here at the DTO
 * layer (in addition to the DB CHECK via `legiwatch_watch_conditions_valid`)
 * so a malformed request 400s before it ever reaches Postgres.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CONDITION_TYPES, SIGNAL_FAMILIES } from './legiwatch-wave2-watch-backtest-matcher.js';

export class WatchConditionDto {
  @IsIn(CONDITION_TYPES)
  type!: (typeof CONDITION_TYPES)[number];

  @IsOptional()
  @IsIn(SIGNAL_FAMILIES)
  family?: (typeof SIGNAL_FAMILIES)[number];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  keyword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  committeeSystemCode?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minMaterialityScore?: number;
}

export class WatchPresetDefinitionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  clientIds?: string[];

  @IsArray()
  @ArrayMaxSize(SIGNAL_FAMILIES.length)
  @IsIn(SIGNAL_FAMILIES, { each: true })
  signalFamilies!: (typeof SIGNAL_FAMILIES)[number][];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WatchConditionDto)
  conditions!: WatchConditionDto[];
}

export class CreateWatchPresetDto extends WatchPresetDefinitionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class UpdateWatchPresetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  clientIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SIGNAL_FAMILIES.length)
  @IsIn(SIGNAL_FAMILIES, { each: true })
  signalFamilies?: (typeof SIGNAL_FAMILIES)[number][];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WatchConditionDto)
  conditions?: WatchConditionDto[];
}

export class SetWatchPresetStatusDto {
  @IsIn(['active', 'paused', 'archived'])
  status!: 'active' | 'paused' | 'archived';
}

export class SubmitBacktestDto extends WatchPresetDefinitionDto {
  /** Preview a saved preset's own definition when set; otherwise a draft. */
  @IsOptional()
  @IsUUID()
  presetId?: string;

  /** Default 30, bounded to MAX_WINDOW_DAYS server-side regardless. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  windowDays?: number;
}
