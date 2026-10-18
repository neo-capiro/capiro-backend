import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { CoreRetainedReadOperation } from '@capiro/shared/core-retained-principal';
import type { Request, Response } from 'express';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { applicationMembershipRequest } from './application-membership-request.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import { RetainedPrincipalService } from './retained-principal.service.js';

@Controller('clio/application-authority')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class RetainedPrincipalIssuerController {
  constructor(private readonly principal: RetainedPrincipalService) {}

  @Post('retained-research-portfolio-principal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  portfolio(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
  ) {
    return this.issue(req, res, ctx, 'get_research_portfolio', body);
  }
  @Post('retained-research-portfolio-changes-principal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  changes(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
  ) {
    return this.issue(req, res, ctx, 'get_research_portfolio_changes', body);
  }
  @Post('retained-florida-principal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  florida(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
  ) {
    return this.issue(req, res, ctx, 'get_florida_budget_project', body);
  }
  private async issue(
    req: Request,
    res: Response,
    ctx: TenantContext,
    operation: CoreRetainedReadOperation,
    body: unknown,
  ) {
    const control = applicationMembershipRequest(req, res);
    try {
      return await control.run(() =>
        this.principal.issue(req, ctx, operation, body, control),
      );
    } finally {
      control.close();
    }
  }
}

/** No native-user fallback. A future mount must explicitly preserve this fixed
 * signed-principal guard boundary when composing tenant middleware. */
@Controller('clio/retained-reads')
export class RetainedPrincipalDataController {
  constructor(private readonly principal: RetainedPrincipalService) {}

  @Post('research-portfolio')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  portfolio(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return this.read(req, res, 'get_research_portfolio', body);
  }
  @Post('research-portfolio-changes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  changes(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return this.read(req, res, 'get_research_portfolio_changes', body);
  }
  private async read(
    req: Request,
    res: Response,
    operation: 'get_research_portfolio' | 'get_research_portfolio_changes',
    body: unknown,
  ) {
    const control = applicationMembershipRequest(req, res);
    try {
      return await control.run(() =>
        this.principal.readPortfolio(
          req.headers.authorization,
          operation,
          body,
          control,
        ),
      );
    } finally {
      control.close();
    }
  }
}
