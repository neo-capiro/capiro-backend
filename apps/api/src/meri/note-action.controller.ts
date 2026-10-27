import { Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { NoteActionService } from './note-action.service.js';

/**
 * Fixed native save_note endpoints. Save is a static PASS, so there is a prepare
 * (which saves once) and a read of the recorded result — never a decision route:
 * no approval is requested, and no WARN outcome is presented as an approval.
 */
@Controller('clio/tools')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class NoteActionController {
  constructor(private readonly owner: NoteActionService) {}
  @Post('prepare_note_action')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  prepare(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return withMeriToolRequestControl(req, () => this.owner.prepare(ctx, req, body));
  }
  @Post('read_note_action')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    return withMeriToolRequestControl(req, () => this.owner.read(ctx, req, body));
  }
}
