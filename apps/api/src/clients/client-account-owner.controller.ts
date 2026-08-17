import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientAccountOwnerService } from './client-account-owner.service.js';

class UpdateClientAccountOwnerDto {
  @IsOptional()
  @IsUUID()
  accountOwnerUserId?: string | null;
}

@Controller('client-account-owners')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientAccountOwnerController {
  constructor(private readonly service: ClientAccountOwnerService) {}

  @Get('options')
  listOptions(@CurrentTenant() ctx: TenantContext) {
    return this.service.listOptions(ctx);
  }

  @Get(':clientId')
  get(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.get(ctx, clientId);
  }

  @Put(':clientId')
  @Roles('user_admin')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: UpdateClientAccountOwnerDto,
  ) {
    return this.service.update(ctx, clientId, body.accountOwnerUserId ?? null);
  }
}
