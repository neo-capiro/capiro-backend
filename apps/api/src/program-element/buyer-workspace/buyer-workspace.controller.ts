import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min } from 'class-validator';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { BuyerWorkspaceService } from './buyer-workspace.service.js';

class BuyerWorkspaceQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  @Max(2200)
  asOfFy!: number;

  @IsString()
  knownAt!: string;
}

@Controller('buyer-workspace')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class BuyerWorkspaceController {
  constructor(private readonly workspace: BuyerWorkspaceService) {}

  @Get('program-elements/:peCode')
  read(@Param('peCode') peCode: string, @Query() query: BuyerWorkspaceQueryDto) {
    return this.workspace.read({ peCode, asOfFy: query.asOfFy, knownAt: query.knownAt });
  }
}
