import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { FundingExecutionReadService } from './funding-execution-read.service.js';

class FundingExecutionQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2200)
  asOfFy!: number;

  @IsOptional()
  @IsString()
  knownAt?: string;

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

@Controller('funding-execution')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class FundingExecutionController {
  constructor(private readonly reads: FundingExecutionReadService) {}

  @Get('programs/:programId')
  program(@Param('programId') programId: string, @Query() query: FundingExecutionQueryDto) {
    return this.reads.read({ programId, ...query });
  }

  @Get('program-elements/:peCode')
  pe(@Param('peCode') peCode: string, @Query() query: FundingExecutionQueryDto) {
    return this.reads.read({ peCode, ...query });
  }
}
