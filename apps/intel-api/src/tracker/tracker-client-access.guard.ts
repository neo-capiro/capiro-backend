import { Injectable, NotFoundException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { readTrackerClientScope, trackerMetricsClientId, TrackerMetricsError } from '@capiro/shared';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type TrackerClientRequest = { tenantContext?: WorkspaceTenantContext; params?: { clientId?: string }; trackerClientIds?: string[] };

/** Request-start authorization for short retained CRUD, using Core-owned membership
 * and wall decisions. No caller hint or administrator role bypasses a client wall. */
@Injectable()
export class TrackerClientAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<TrackerClientRequest>();
    const ctx = req.tenantContext;
    if (!ctx?.tenantId || !ctx.clerkUserId) throw new NotFoundException('Client not found');
    const clientId = req.params?.clientId;
    const route = Reflect.getMetadata(PATH_METADATA, context.getHandler()) as string | undefined;
    if ((!clientId && route !== '_all/tracker/counts') ||
      (clientId === '_all' && route !== ':clientId/tracker/board' && route !== ':clientId/tracker/bill-search'))
      throw new NotFoundException('Client not found');
    try {
      req.trackerClientIds = await this.prisma.withTenant(ctx.tenantId, async tx => {
        if (clientId && clientId !== '_all') {
          const id = trackerMetricsClientId(clientId);
          await readTrackerClientScope(tx, ctx, id);
          return [id];
        }
        const clients = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id::text FROM clients WHERE tenant_id=$1::uuid AND status::text<>'archived' ORDER BY id`, ctx.tenantId);
        const visible: string[] = [];
        for (const client of clients) {
          try { await readTrackerClientScope(tx, ctx, client.id); visible.push(client.id); }
          catch (error) { if (!(error instanceof TrackerMetricsError) || error.reason !== 'client_not_readable') throw error; }
        }
        return visible;
      }, { timeoutMs: 20_000 });
    } catch (error) {
      if (error instanceof TrackerMetricsError) throw new NotFoundException('Client not found');
      throw error;
    }
    return true;
  }
}
