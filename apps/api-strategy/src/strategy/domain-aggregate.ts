import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../planner/planner-links.service.js';
import type { Request } from 'express';

const OBSERVATION_MS = 10_000;
const MAX_ROWS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 256;
const MAX_SOURCE_CHECKS = 256; // Both authority passes together; never a capped total.
const unavailable = () =>
  new ServiceUnavailableException('Complete aggregate observation unavailable');

export interface AggregateBudget {
  signal: AbortSignal;
  remaining(): number;
  query<T>(tx: Prisma.TransactionClient, run: () => Promise<T>): Promise<T>;
  close(): void;
}
export function createAggregateBudget(
  signal?: AbortSignal,
  timeoutMs = OBSERVATION_MS,
): AggregateBudget {
  const duration = Math.max(1, Math.min(OBSERVATION_MS, timeoutMs));
  const deadline = performance.now() + duration;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, duration);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const remaining = () => {
    if (controller.signal.aborted || performance.now() >= deadline) {
      abort();
      throw unavailable();
    }
    return Math.max(1, Math.ceil(deadline - performance.now()));
  };
  return {
    signal: controller.signal,
    remaining,
    async query(tx, run) {
      // PostgreSQL cancels a stalled statement; we await its settlement/transaction
      // cleanup. No Promise.race or abandoned Prisma promise. Caller cancellation
      // during a statement stops subsequent work after this bounded await settles.
      const ms = `${remaining()}ms`;
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${ms}, true)`;
      remaining();
      const result = await run();
      remaining();
      return result;
    },
    close() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      abort();
    },
  };
}

/** Page the full population with finite working memory. Capacity exhaustion rejects
 * the whole observation; no first-N count is ever evaluated or returned. */
export async function aggregateRows<T extends { id: string }>(
  budget: AggregateBudget,
  page: (after: string | undefined, take: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined,
    bytes = 0;
  for (;;) {
    budget.remaining();
    const next = await page(after, PAGE_SIZE);
    budget.remaining();
    if (next.length > PAGE_SIZE || rows.length + next.length > MAX_ROWS) throw unavailable();
    for (const row of next) {
      budget.remaining();
      if (after && row.id <= after) throw unavailable();
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > MAX_BYTES) throw unavailable();
      rows.push(row);
      after = row.id;
    }
    if (next.length < PAGE_SIZE) return rows;
  }
}

export async function aggregateRequest<T>(
  req: Request,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!req.res?.writableEnded) abort();
  };
  req.once('aborted', abort);
  req.res?.once('close', closed);
  if (req.aborted || req.res?.destroyed) abort();
  try {
    return await run(controller.signal);
  } finally {
    req.off('aborted', abort);
    req.res?.off('close', closed);
    abort();
  }
}

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
  read: (budget: AggregateBudget) => Promise<AggregateSnapshot>,
  asOf = new Date(),
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const budget = createAggregateBudget(options.signal, options.timeoutMs);
  let checks = 0;
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
    budget.remaining();
    const result = new Set<string>();
    const unique = new Map(sources.map((source) => [aggregateSourceKey(source), source]));
    if (selected) unique.set(aggregateSourceKey(selected), selected);
    const atoms = new Map<string, AggregateSource>();
    for (const source of unique.values()) {
      budget.remaining();
      if (source.clientId) {
        const client = { clientId: source.clientId.toLowerCase() };
        atoms.set(aggregateSourceKey(client), client);
      }
      if (source.meetingId) {
        const meeting = { clientId: null, meetingId: source.meetingId.toLowerCase() };
        atoms.set(aggregateSourceKey(meeting), meeting);
      }
    }
    // Reserve both complete passes before the first remote read. This is an
    // unavailable observation, not a count clipped to the source capacity.
    if (atoms.size * 2 > MAX_SOURCE_CHECKS) throw unavailable();
    if (
      [...unique.values()].some((source) => source.clientId || source.meetingId) &&
      !authorization?.startsWith('Bearer ')
    )
      throw new ForbiddenException('Source authorization is required');
    const granted = new Set<string>();
    for (const [key, source] of atoms) {
      budget.remaining();
      if (++checks > MAX_SOURCE_CHECKS) throw unavailable();
      try {
        await links.validate(source, authorization, {
          distinguishAuthenticationFailure: true,
          signal: budget.signal,
        });
        budget.remaining();
        granted.add(key);
      } catch (error) {
        budget.remaining();
        // A denied row is excluded. Transport/producer failures withhold the entire value.
        if (!(error instanceof ForbiddenException)) throw error;
        if (selected && key === aggregateSourceKey(selected)) throw error;
      }
    }
    for (const [key, source] of unique) {
      budget.remaining();
      if (
        (!source.clientId || granted.has(aggregateSourceKey({ clientId: source.clientId }))) &&
        (!source.meetingId ||
          granted.has(aggregateSourceKey({ clientId: null, meetingId: source.meetingId })))
      )
        result.add(key);
    }
    return result;
  };
  try {
    budget.remaining();
    const first = await read(budget);
    budget.remaining();
    const before = await authorize(first.sources);
    const second = await read(budget);
    budget.remaining();
    if (first.fingerprint !== second.fingerprint) return incomplete('source_changed');
    const after = await authorize(second.sources);
    if (before.size !== after.size || [...before].some((key) => !after.has(key)))
      return incomplete('authorization_changed');
    // Cover Planner grants/source edits occurring during the second Core access pass.
    const last = await read(budget);
    budget.remaining();
    if (second.fingerprint !== last.fingerprint) return incomplete('source_changed');
    const count = last.count(after);
    budget.remaining();
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
    budget.remaining();
    if (error instanceof BadRequestException) return incomplete('invalid_source');
    throw error;
  } finally {
    budget.close();
  }
}
