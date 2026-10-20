import { Body, Controller, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import { assertApplicationAuthorityIdentityBody } from './application-authority.js';
import { ApplicationMembershipService } from './application-membership.service.js';
import { applicationMembershipRequest } from './application-membership-request.js';

@Controller('clio/application-authority')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ApplicationMembershipController {
  constructor(private readonly membership: ApplicationMembershipService) {}

  @Post('membership')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async applicationAuthorityMembership(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    assertApplicationAuthorityIdentityBody(body);
    const control = applicationMembershipRequest(req, res);
    try {
      control.assertActive();
      return await control.run(() => this.membership.read(req, ctx, control));
    } finally {
      control.close();
    }
  }
}
