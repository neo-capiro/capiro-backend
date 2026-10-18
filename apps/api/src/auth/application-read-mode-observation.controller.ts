import { Body, Controller, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import { applicationMembershipRequest } from './application-membership-request.js';
import { ApplicationReadModeObservationService } from './application-read-mode-observation.service.js';

@Controller('clio/application-authority')
@UseGuards(RolesGuard, ToolServiceSecretGuard)
@Roles('standard_user')
export class ApplicationReadModeObservationController {
  constructor(private readonly observation: ApplicationReadModeObservationService) {}

  @Post('read-mode-observation')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async readModeObservation(@CurrentTenant() ctx: TenantContext, @Req() req: Request,
    @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const control = applicationMembershipRequest(req, res);
    try { return await control.run(() => this.observation.read(req, ctx, body, control)); }
    finally { control.close(); }
  }
}
