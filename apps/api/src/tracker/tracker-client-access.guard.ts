import { Injectable, NotFoundException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from '../clients/client-ordered-owner.access.js';

/** Request-start authorization for short retained CRUD. Impact inference separately
 * rechecks current authority before persistence after its external model call. */
@Injectable()
export class TrackerClientAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ tenantContext?: TenantContext; params?: { clientId?: string } }>();
    const clientId = req.params?.clientId;
    // Only the declared taxonomy route is unscoped; body/query hints never grant client access.
    if (clientId === undefined && Reflect.getMetadata(PATH_METADATA, context.getHandler()) === 'issue-areas') return true;
    const ctx = req.tenantContext;
    if (!ctx || !clientId) throw new NotFoundException('Client not found');
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, tx => requireOwnerClient(tx, ctx, clientId, false, false, 'share'));
    return true;
  }
}
