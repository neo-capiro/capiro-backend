import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientOrderedOwnerService } from './client-ordered-owner.service.js';

@Controller('clients/:clientId/account-owners')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientOrderedOwnerController {
  constructor(private readonly owners: ClientOrderedOwnerService) {}
  @Get()
  get(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.owners.get(ctx, clientId);
  }
  @Put()
  @Roles('user_admin')
  replace(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: unknown,
  ) {
    return this.owners.replace(ctx, clientId, body);
  }
}
