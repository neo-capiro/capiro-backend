import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriV3AdminService } from './meriv3-admin.service.js';

class SetMeriV3CanaryDto {
  @IsBoolean()
  enabled!: boolean;
}

@Controller('capiro-admin/tenants/:tenantId/meriv3')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class MeriV3AdminController {
  constructor(private readonly service: MeriV3AdminService) {}

  @Post('enabled')
  setEnabled(
    @CurrentTenant() ctx: TenantContext,
    @Param('tenantId') tenantId: string,
    @Body() body: SetMeriV3CanaryDto,
  ) {
    return this.service.setEnabled(ctx, tenantId, body.enabled);
  }
}
