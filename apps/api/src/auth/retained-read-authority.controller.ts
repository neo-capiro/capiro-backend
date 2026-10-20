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
import type { Request, Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';
import { applicationMembershipRequest } from './application-membership-request.js';
import { RetainedReadAuthorityService } from './retained-read-authority.service.js';

/** Disabled source-only sibling module; no Meri task/fence authority is claimed. */
@Controller('clio/application-authority')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class RetainedReadAuthorityController {
  constructor(private readonly authority: RetainedReadAuthorityService) {}

  @Post('retained-research-portfolio')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  detail(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return this.portfolio(ctx, req, res, body, 'get_research_portfolio');
  }

  @Post('retained-research-portfolio-changes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  changes(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    return this.portfolio(
      ctx,
      req,
      res,
      body,
      'get_research_portfolio_changes',
    );
  }

  @Post('retained-florida-budget')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async florida(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const control = applicationMembershipRequest(req, res);
    try {
      return await control.run(() =>
        this.authority.floridaBudget(req, ctx, body, control),
      );
    } finally {
      control.close();
    }
  }

  private async portfolio(
    ctx: TenantContext,
    req: Request,
    res: Response,
    body: unknown,
    operation: 'get_research_portfolio' | 'get_research_portfolio_changes',
  ) {
    const control = applicationMembershipRequest(req, res);
    try {
      return await control.run(() =>
        this.authority.portfolio(req, ctx, operation, body, control),
      );
    } finally {
      control.close();
    }
  }
}
