import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientTeamService } from './client-team.service.js';

class AddClientTeamMemberDto {
  @IsUUID()
  userId!: string;

  /**
   * Free text, e.g. "Lead lobbyist". No controlled vocabulary exists for this
   * in the product and inventing one would be fabricated structure. Bounded so
   * a roster label can't become an essay.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;
}

/**
 * Client account team — the firm's own users assigned to a client.
 *
 * Reads are open to any `standard_user`: knowing who works an account is
 * ordinary information inside a firm. Writes require `user_admin`, matching the
 * gate already on account-owner assignment
 * (`client-account-owner.controller.ts`), because both decide who is attached to
 * a client. If that turns out to be too tight for day-to-day use, the floor on
 * the two mutations is the only thing to change.
 *
 * `userId` travels in the BODY on add and as a QUERY parameter on delete rather
 * than as a path segment. That is the convention this codebase already settled
 * on for member-scoped deletes (see `client-targets.controller.ts`), and it
 * avoids a second `:param` on a route whose only declared path parameter is
 * `:clientId` — the global ValidationPipe runs `forbidNonWhitelisted`, and an
 * undeclared path parameter is exactly what made all 14
 * `opportunities/:source/:id` routes return 400 (PR #1084).
 */
@Controller('clients/:clientId/team')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientTeamController {
  constructor(private readonly service: ClientTeamService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.list(ctx, clientId);
  }

  @Post()
  @Roles('user_admin')
  add(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: AddClientTeamMemberDto,
  ) {
    return this.service.add(ctx, clientId, body.userId, body.role?.trim() || null);
  }

  @Delete()
  @Roles('user_admin')
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query('userId') userId: string,
  ) {
    return this.service.remove(ctx, clientId, userId);
  }
}
