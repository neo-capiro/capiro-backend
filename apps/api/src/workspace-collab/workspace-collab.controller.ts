import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { WorkspaceCollabEmailService } from './workspace-collab-email.service.js';
import { SendInviteEmailDto } from './workspace-collab.dto.js';

/**
 * Workspace collaborator email (E-19). The Workspace engine owns the invite row
 * + in-app notification; this endpoint (apps/api owns the SES path) sends the
 * accompanying email after explicit opt-in. Workspace rechecks current source
 * access; API owns the one-attempt receipt.
 */
@Controller('workspace')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class WorkspaceCollabController {
  constructor(private readonly email: WorkspaceCollabEmailService) {}

  @Post('collaborator-invite-email')
  send(@CurrentTenant() ctx: TenantContext, @Body() dto: SendInviteEmailDto) {
    return this.email.sendInvite(ctx, dto);
  }

  @Get('drafts/:draftId/collaborator-invite-email/:invitationId')
  status(@CurrentTenant() ctx: TenantContext, @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string) {
    return this.email.status(ctx, { draftId, invitationId });
  }

  @Post('drafts/:draftId/collaborator-invite-email/:invitationId/cancel')
  cancel(@CurrentTenant() ctx: TenantContext, @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string) {
    return this.email.cancel(ctx, { draftId, invitationId });
  }
}
