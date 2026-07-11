/**
 * Flow-2A external setup dashboard API (/onboard-api/setup/*). Authenticated
 * with the admin's own Clerk JWT (TenantGuard); mutations additionally
 * require an org-admin role (checked in the service). apps/web's SetupGate
 * reads GET /setup/state with any member's token.
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsIn, IsString } from 'class-validator';
import type { Request } from 'express';
import { CurrentTenant, TenantGuard, type AuthTenantContext } from '@capiro/auth';
import { CapiroAdminGuard } from '../auth/capiro-admin.guard.js';
import { SetupService } from './setup.service.js';

const TASK_KEYS = ['it_email', 'import', 'firm_ai', 'invites'] as const;
const TASK_STATUSES = ['none', 'waiting', 'verifying', 'done'] as const;

class TransitionDto {
  @IsString()
  @IsIn(TASK_STATUSES as readonly string[])
  from!: (typeof TASK_STATUSES)[number];

  @IsString()
  @IsIn(TASK_STATUSES as readonly string[])
  to!: (typeof TASK_STATUSES)[number];
}

class ItInviteDto {
  @IsEmail()
  email!: string;
}

@Controller('setup')
@UseGuards(TenantGuard)
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('state')
  state(@CurrentTenant() ctx: AuthTenantContext) {
    return this.setup.getState(ctx);
  }

  @Post('tasks/:task/transition')
  transition(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('task') task: string,
    @Body() body: TransitionDto,
  ) {
    if (!(TASK_KEYS as readonly string[]).includes(task)) {
      throw new Error(`Unknown task ${task}`);
    }
    return this.setup.transitionTask(ctx, task as (typeof TASK_KEYS)[number], body.from, body.to);
  }

  @Post('it-invites')
  invite(@CurrentTenant() ctx: AuthTenantContext, @Body() body: ItInviteDto) {
    return this.setup.createItInvite(ctx, body.email);
  }

  @Post('it-invites/:inviteId/resend')
  resend(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
  ) {
    return this.setup.resendItInvite(ctx, inviteId);
  }

  @Post('complete')
  complete(@CurrentTenant() ctx: AuthTenantContext) {
    return this.setup.completeSetup(ctx);
  }
}

/**
 * Cross-tenant staff actions for Capiro-managed onboarding — capiro_admin only
 * (the capiro-internal Clerk org). Lets a Capiro team member mark a managed
 * tenant's client import complete from the admin panel, which unblocks that
 * tenant's team-invite step on the external dashboard.
 */
@Controller('admin/setup')
@UseGuards(CapiroAdminGuard)
export class SetupAdminController {
  constructor(private readonly setup: SetupService) {}

  @Get('managed-imports')
  managedImports() {
    return this.setup.adminListManagedImports();
  }

  @Post('tenants/:tenantId/mark-import-complete')
  markImportComplete(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Req() req: Request & { capiroAdmin?: { clerkUserId: string } },
  ) {
    return this.setup.adminMarkImportComplete(tenantId, req.capiroAdmin?.clerkUserId);
  }
}
