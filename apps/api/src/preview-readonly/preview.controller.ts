import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersController } from '../users/users.controller.js';
import { readClient, readClients } from '../clients/clients.read.js';

class PreviewClientQuery {
  @IsOptional() @IsString() profileStatus?: string;
  @IsOptional() @IsString() sectorTag?: string;
  @IsOptional() @IsString() includeArchived?: string;
}

/** Only these three handlers are registered by the preview bootstrap. */
@Controller()
export class PreviewReadOnlyController {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersController) {}

  @Get('me')
  me(@CurrentTenant() ctx: TenantContext) { return this.users.me(ctx); }

  @Get('clients')
  list(@CurrentTenant() ctx: TenantContext, @Query() query: PreviewClientQuery) {
    return readClients(this.prisma, ctx, {
      profileStatus: query.profileStatus, sectorTag: query.sectorTag,
      includeArchived: query.includeArchived === 'true',
    }, async (client) => ({ ...client, logoUrl: null }));
  }

  @Get('clients/:id')
  get(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return readClient(this.prisma, ctx, id, async (client) => ({ ...client, logoUrl: null }));
  }
}
