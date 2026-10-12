import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import type { TenantContext } from '@capiro/shared';
import { NewsletterAccountInvitationService } from './newsletter-account-invitation.service.js';

@Controller('workspace/newsletter-account-invitations')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class NewsletterAccountInvitationController {
  constructor(private readonly invitations: NewsletterAccountInvitationService) {}
  @Post(':id/dispatch') dispatch(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      throw new BadRequestException('Account invitations use only the saved newsletter request.');
    return this.invitations.dispatch(ctx, id);
  }
  @Get(':id') status(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.invitations.status(ctx, id);
  }
}
