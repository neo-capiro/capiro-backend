import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ownOutreachRecordWhere } from './engagement-access.helpers.js';
import { ClassicOutreachObservationIncompleteError, withClassicOutreachEligibleIds } from './classic-outreach-authority.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Scope = { kind: 'personal_classic' } | { kind: 'client'; clientId: string };
export type ClassicOutreachMetricsResult = {
  metric: 'personal_classic_outreach_30d'; version: 1; scope: Scope;
  window: { start: string; end: string; bounds: '[start,end)'; basis: 'created_or_sent' };
  observedAt: string;
} & ({ status: 'complete'; complete: true; capped: false; count: number } |
  { status: 'incomplete'; complete: false; capped: true; count: null });

/** A fixed producer aggregate, never a count of a paginated list or an SQL tool. */
export async function readClassicOutreachMetrics(
  prisma: Pick<PrismaService, 'withTenant'>, supplied: TenantContext, query: unknown,
  now: () => number = Date.now,
): Promise<ClassicOutreachMetricsResult> {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(key => key !== 'clientId')) throw new BadRequestException('Use only an optional clientId.');
  const clientId = (query as { clientId?: unknown }).clientId;
  if (clientId !== undefined && (typeof clientId !== 'string' || !UUID.test(clientId)))
    throw new BadRequestException('clientId must be a UUID.');
  const scope: Scope = clientId === undefined ? { kind: 'personal_classic' } :
    { kind: 'client', clientId: (clientId as string).toLowerCase() };
  const ctx = { ...supplied }, end = now(), start = end - 30 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(end) || start < 0 || end > 8640000000000000)
    throw new ServiceUnavailableException('Outreach metrics clock unavailable.');
  const assertActive = () => {
    const at = now();
    if (!Number.isSafeInteger(at) || at < end || at >= end + 10_000)
      throw new ServiceUnavailableException('Outreach metrics timed out. Please retry.');
  };
  const metadata = {
    metric: 'personal_classic_outreach_30d' as const, version: 1 as const, scope,
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      bounds: '[start,end)' as const, basis: 'created_or_sent' as const },
  };
  try {
    const count = await withClassicOutreachEligibleIds(prisma, ctx, scope,
      { maxCandidates: 100, assertActive }, async ids => {
        const value = await prisma.withTenant(ctx.tenantId, tx => tx.outreachRecord.count({
          where: { tenantId: ctx.tenantId, ...ownOutreachRecordWhere(ctx.userId), deletedAt: null,
            id: { in: [...ids] }, ...(scope.kind === 'client' ? { clientId: scope.clientId } : {}),
            // OR over the primary row counts an ID once even when both dates match.
            OR: [{ createdAt: { gte: new Date(start), lt: new Date(end) } },
              { sentAt: { gte: new Date(start), lt: new Date(end) } }],
          },
        }));
        assertActive();
        if (!Number.isSafeInteger(value) || value < 0 || value > ids.length)
          throw new ServiceUnavailableException('Outreach metrics unavailable.');
        return value;
      });
    assertActive();
    return { ...metadata, observedAt: new Date(now()).toISOString(),
      status: 'complete', complete: true, capped: false, count };
  } catch (error) {
    if (!(error instanceof ClassicOutreachObservationIncompleteError)) throw error;
    assertActive();
    return { ...metadata, observedAt: new Date(now()).toISOString(),
      status: 'incomplete', complete: false, capped: true, count: null };
  }
}
