import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { AcquisitionContinuityReadService } from './acquisition-continuity-read.service.js';

class AcquisitionContinuityQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2200)
  asOfFy!: number;

  @IsOptional()
  @IsString()
  knownAt?: string;

  @IsOptional()
  @IsIn(['all', 'accepted', 'candidate', 'unresolved'])
  status?: 'all' | 'accepted' | 'candidate' | 'unresolved';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

@Controller('acquisition-continuity')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class AcquisitionContinuityController {
  constructor(private readonly service: AcquisitionContinuityReadService) {}

  @Get('programs/:programId')
  program(@Param('programId') programId: string, @Query() query: AcquisitionContinuityQueryDto) {
    return this.service.read({ programId, ...query });
  }

  @Get('program-elements/:peCode')
  pe(@Param('peCode') peCode: string, @Query() query: AcquisitionContinuityQueryDto) {
    return this.service.read({ peCode, ...query });
  }

  @Get('procurement-lines/:lineId')
  procurement(@Param('lineId') procurementLineId: string, @Query() query: AcquisitionContinuityQueryDto) {
    return this.service.read({ procurementLineId, ...query });
  }
}
