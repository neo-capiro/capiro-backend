import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { WorkspaceCollabEmailService } from './workspace-collab-email.service.js';
import { SendInviteEmailDto } from './workspace-collab.dto.js';

/**
 * Workspace collaborator email (E-19). The Workspace engine owns the invite row
 * + in-app notification; this endpoint (apps/api owns the SES path) sends the
 * accompanying email. The web calls it after a successful engine invite.
 * Tenant-guarded; any standard_user can trigger it for their own invite flow.
 */
@Controller('workspace')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class WorkspaceCollabController {
  constructor(private readonly email: WorkspaceCollabEmailService) {}

  @Post('collaborator-invite-email')
  send(@CurrentTenant() _ctx: TenantContext, @Body() dto: SendInviteEmailDto) {
    return this.email.sendInvite(dto);
  }
}
