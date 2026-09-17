import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readVisibleClientIds } from './funding-opportunity-access.js';
import { isStorableSource } from './funding-opportunity-identity.js';
import { requireFundingSourceAccess } from './funding-opportunity-source-access.js';

/** Apply the same wall to legacy catalog routes and the new workflow surfaces. */
@Injectable()
export class FundingOpportunityClientAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const ctx = req.tenantContext;
    if (!ctx?.tenantId || !ctx.userId) throw new NotFoundException();
    const source = req.params?.source;
    if (typeof source === 'string' && isStorableSource(source)) {
      await requireFundingSourceAccess(this.prisma, ctx.tenantId, source);
    }
    const clientId = req.params?.clientId ?? req.query?.clientId ?? req.body?.clientId;
    if (clientId == null || clientId === '') return true;
    if (typeof clientId !== 'string') throw new NotFoundException('Client not found.');
    const visible = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      readVisibleClientIds(tx, ctx.tenantId, ctx.userId),
    );
    if (!visible.includes(clientId)) throw new NotFoundException('Client not found.');
    return true;
  }
}
