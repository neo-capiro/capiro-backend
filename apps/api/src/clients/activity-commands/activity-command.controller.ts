import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { ActivityCommandService } from './activity-command.service.js';

function bearer(req: Request) {
  // This bridge is a personal-user command; do not forward tenant-selection or
  // HQ impersonation hints to another service with a different tenant resolver.
  if (req.headers['x-capiro-impersonate-tenant'] !== undefined) throw new ForbiddenException();
  return req.headers.authorization;
}
@Controller('clients/:clientId/activity-commands')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ActivityCommandController {
  constructor(private readonly service: ActivityCommandService) {}
  @Post()
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.service.create(ctx, clientId, body, bearer(req));
  }
  @Get(':requestId')
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('requestId') requestId: string,
    @Req() req: Request,
  ) {
    return this.service.get(ctx, clientId, requestId, bearer(req));
  }
  @Post(':requestId/resume')
  resume(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.service.resume(ctx, clientId, requestId, body, bearer(req));
  }
}
