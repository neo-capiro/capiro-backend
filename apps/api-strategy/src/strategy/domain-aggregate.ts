import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../planner/planner-links.service.js';

export type DomainAggregateQuery = { clientId?: string };
export type AggregateSource = { clientId: string | null; meetingId?: string | null };
export interface AggregateSnapshot {
  fingerprint: string;
  sources: AggregateSource[];
  count: (readable: ReadonlySet<string>) => number;
}
export function aggregateQuery(raw: DomainAggregateQuery): DomainAggregateQuery {
  if (
    !raw ||
    Object.keys(raw).some((key) => key !== 'clientId') ||
    (raw.clientId !== undefined &&
      (typeof raw.clientId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          raw.clientId,
        )))
  )
    throw new BadRequestException('Invalid aggregate scope');
  return raw.clientId ? { clientId: raw.clientId.toLowerCase() } : {};
}
export function aggregateSourceKey(source: AggregateSource): string {
  return JSON.stringify([
    source.clientId?.toLowerCase() ?? null,
    source.meetingId?.toLowerCase() ?? null,
  ]);
}
export function aggregateFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Re-resolve the signed-in actor from Core rows even for an empty/General population.
 * TenantGuard's JWT alone cannot establish current membership at observation time. */
export async function requireAggregateActor(
  tx: Prisma.TransactionClient,
  ctx: AuthTenantContext,
  strategy = false,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
    JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=${ctx.tenantId}::uuid
      AND u.clerk_user_id=${ctx.clerkUserId} AND m.status::text='active'
      AND t.status::text='active'
      AND m.role::text IN ('standard_user','user_admin','capiro_admin')
      AND (NOT ${strategy} OR t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb)
    FOR SHARE OF m,u,t`;
  if (rows.length !== 1) throw new ForbiddenException('Aggregate access unavailable');
}

/** Owner reads stay full-population; Core's existing client/meeting readers remain
 * authoritative. Network reads run outside owner transactions. Any change in the
 * observed population or source authority withholds the value, never a partial count. */
export async function observeDomainAggregate(
  metric: 'planner.overdue_unfinished' | 'strategy.active',
  query: DomainAggregateQuery,
  links: Pick<PlannerLinksService, 'validate'>,
  authorization: string | undefined,
  read: () => Promise<AggregateSnapshot>,
  asOf = new Date(),
) {
  const base = {
    metric,
    version: 1 as const,
    scope: query.clientId
      ? { kind: 'client' as const, clientId: query.clientId }
      : { kind: 'actor' as const },
    asOf: asOf.toISOString(),
    ...(metric === 'planner.overdue_unfinished'
      ? {
          deadline: {
            timed: 'strictly_before_asOf',
            dateOnly: 'before_local_asOf_day',
            defaultTimeZone: 'UTC',
          },
        }
      : {}),
  };
  const incomplete = (reason: string) => ({
    ...base,
    state: 'incomplete' as const,
    count: null,
    complete: false,
    capped: false,
    observedAt: new Date().toISOString(),
    reason,
  });
  const selected: AggregateSource | null = query.clientId ? { clientId: query.clientId } : null;
  const authorize = async (sources: AggregateSource[]) => {
    const result = new Set<string>();
    const unique = new Map(sources.map((source) => [aggregateSourceKey(source), source]));
    if (selected) unique.set(aggregateSourceKey(selected), selected);
    if (
      [...unique.values()].some((source) => source.clientId || source.meetingId) &&
      !authorization?.startsWith('Bearer ')
    )
      throw new ForbiddenException('Source authorization is required');
    for (const [key, source] of unique) {
      try {
        await links.validate(source, authorization, { distinguishAuthenticationFailure: true });
        result.add(key);
      } catch (error) {
        // A denied row is excluded. Transport/producer failures withhold the entire value.
        if (!(error instanceof ForbiddenException)) throw error;
        if (selected && key === aggregateSourceKey(selected)) throw error;
      }
    }
    return result;
  };
  try {
    const first = await read();
    const before = await authorize(first.sources);
    const second = await read();
    if (first.fingerprint !== second.fingerprint) return incomplete('source_changed');
    const after = await authorize(second.sources);
    if (before.size !== after.size || [...before].some((key) => !after.has(key)))
      return incomplete('authorization_changed');
    // Cover Planner grants/source edits occurring during the second Core access pass.
    const last = await read();
    if (second.fingerprint !== last.fingerprint) return incomplete('source_changed');
    const count = last.count(after);
    if (!Number.isSafeInteger(count) || count < 0) return incomplete('invalid_source');
    return {
      ...base,
      state: 'complete' as const,
      count,
      complete: true,
      capped: false,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof BadRequestException) return incomplete('invalid_source');
    throw error;
  }
}
