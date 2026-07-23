import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One firm-phase row (PHS-2/4). Bounds are FY + federal-FY quarter; endFy/endQ
 * are the EXCLUSIVE end boundary (matching the modal's to-select), so a phase
 * running FY27 Q1–Q2 inclusive is {startFy:2027,startQ:1,endFy:2027,endQ:3}.
 */
export class FirmPhaseRowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  startFy!: number;

  @IsInt()
  @Min(1)
  @Max(4)
  startQ!: number;

  @IsInt()
  @Min(2000)
  @Max(2100)
  endFy!: number;

  @IsInt()
  @Min(1)
  @Max(4)
  endQ!: number;
}

/** Full replace of the tenant's ordered phase set (PHS-4). Array order = position. */
export class FirmPhasesDto {
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => FirmPhaseRowDto)
  rows!: FirmPhaseRowDto[];
}
