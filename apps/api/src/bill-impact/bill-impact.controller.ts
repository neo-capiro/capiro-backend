import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { BillImpactService } from './bill-impact.service.js';
class ImpactClientDto {
  @IsUUID() clientId!: string;
}
class ImpactDraftDto extends ImpactClientDto {
  @IsString() @MinLength(1) @MaxLength(180) versionId!: string;
  @IsString() @MinLength(1) @MaxLength(128) revision!: string;
}
@Controller('legiwatch/bills')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class BillImpactController {
  constructor(private readonly service: BillImpactService) {}
  @Get(':billId/impact')
  options(
    @CurrentTenant() ctx: TenantContext,
    @Param('billId') billId: string,
    @Query() query: ImpactClientDto,
  ) {
    return this.service.options(ctx, billId, query.clientId);
  }
  @Post(':billId/impact')
  generate(
    @CurrentTenant() ctx: TenantContext,
    @Param('billId') billId: string,
    @Body() body: ImpactDraftDto,
  ) {
    return this.service.generate(ctx, billId, body);
  }
}
