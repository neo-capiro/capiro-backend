import { Body, Controller, Header, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { PlannerContextGuard } from '../planner/planner-context.guard.js';
import { SavedReadsService } from './saved-reads.service.js';

/** Read-only POST: body selectors stay out of URLs. No command/admission is created. */
@Controller('saved-reads')
@UseGuards(TenantGuard, PlannerContextGuard)
export class SavedReadsController {
  constructor(private readonly reads: SavedReadsService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(
    @CurrentTenant() ctx: AuthTenantContext,
    @Body() request: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return this.reads.read(ctx, request, authorization);
  }
}
