import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { PROGRAM_IDENTITY_KINDS, ProgramContinuityService } from './program-continuity.service.js';

class ProgramContinuityQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2200)
  asOfFy!: number;

  @IsOptional()
  @IsString()
  knownAt?: string;

  @IsOptional()
  @IsIn(PROGRAM_IDENTITY_KINDS)
  identityKind?: (typeof PROGRAM_IDENTITY_KINDS)[number];

  @IsOptional()
  @IsString()
  sourceSystem?: string;

  @IsOptional()
  @IsString()
  sourceIdentifier?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  includeCandidates?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

@Controller('programs/continuity')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ProgramContinuityController {
  constructor(private readonly service: ProgramContinuityService) {}

  @Get()
  list(@Query() query: ProgramContinuityQueryDto) {
    return this.service.list(query);
  }
}
