import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { RepresentationResolverService } from './representation-resolver.service.js';

/** District Impact Engine (Phase 1 M1.4) — "who represents your footprint". */
@Controller('clients/:clientId/representation')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class RepresentationController {
  constructor(private readonly resolver: RepresentationResolverService) {}

  @Get()
  getRepresentation(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.resolver.representationForClient(ctx.tenantId, clientId);
  }
}
