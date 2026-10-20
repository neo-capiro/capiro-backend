import { Body, Controller, Get, Header, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { parsePortfolioLayoutInput, type PortfolioLayoutInput } from './portfolio-layout.helpers.js';
import { assertPortfolioLayoutAuthority, portfolioLayoutFailure, transactPortfolioLayout } from './portfolio-layout.transaction.js';

@Controller('me/portfolio-layout')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class PortfolioLayoutController {
  constructor(private readonly prisma: PrismaService, private readonly tenant: TenantContextMiddleware) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  read(@CurrentTenant() ctx: TenantContext, @Req() req: Request) {
    return this.operate(ctx, req);
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  save(@CurrentTenant() ctx: TenantContext, @Req() req: Request, @Body() body: unknown) {
    // Closed grammar is parsed before any authority/provider or persistence work.
    return this.operate(ctx, req, parsePortfolioLayoutInput(body));
  }

  private async operate(ctx: TenantContext, req: Request, input?: PortfolioLayoutInput) {
    const owner = { tenantId: ctx.tenantId, userId: ctx.userId };
    const proof = await this.tenant.readApplicationAuthority(req, ctx);
    assertPortfolioLayoutAuthority(proof, owner);
    try {
      return await this.prisma.withSystem((tx) => transactPortfolioLayout(tx, owner, proof, input),
        { isolationLevel: 'Serializable' });
    } catch (error) { portfolioLayoutFailure(error, input !== undefined); }
  }
}
