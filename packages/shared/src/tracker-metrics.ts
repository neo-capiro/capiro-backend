import { clientMemoryAllowed, type ResourceScopeTransaction } from './client-memory-wall.js';

export type TrackerMetricsBackend = 'core' | 'intelligence';
export type TrackerMetricsActor = { tenantId: string; clerkUserId: string; userId?: string };
export interface TrackerMetricsTransaction extends ResourceScopeTransaction {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface TrackerMetricsDatabase {
  withTenant<T>(tenantId: string, read: (tx: TrackerMetricsTransaction) => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
}
export class TrackerMetricsError extends Error {
  constructor(readonly reason: 'invalid_request' | 'client_not_readable' | 'scope_changed' |
    'unsupported_bill_source' | 'invalid_aggregate' | 'deadline' | 'source_unavailable') {
    super('Tracker metric unavailable'); this.name = 'TrackerMetricsError';
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function trackerMetricsClientId(clientId: unknown): string {
  if (typeof clientId !== 'string' || !UUID.test(clientId)) throw new TrackerMetricsError('invalid_request');
  return clientId.toLowerCase();
}

/** Resolve the current actor from the signed-in Clerk subject, then reuse the
 * canonical wall decision. Both service schemas can supply their ordinary
 * tenant-scoped raw transaction; no caller-supplied user/role grants access. */
export async function readTrackerClientScope(tx: ResourceScopeTransaction, actor: TrackerMetricsActor, clientId: string) {
  const rows = await tx.$queryRawUnsafe<Array<{
    userId: string; memberId: string; role: string; memberUpdatedAt: Date; clientUpdatedAt: Date;
  }>>(
    `SELECT u.id::text AS "userId", m.id::text AS "memberId", m.role::text AS role,
            m.updated_at AS "memberUpdatedAt", c.updated_at AS "clientUpdatedAt"
     FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id
     JOIN users u ON u.id=m.user_id
     JOIN clients c ON c.tenant_id=t.id AND c.id=$2::uuid
     WHERE t.id=$1::uuid AND t.status::text='active' AND m.status::text='active'
       AND m.role::text IN ('standard_user','user_admin','capiro_admin')
       AND u.clerk_user_id=$3 AND ($4::uuid IS NULL OR u.id=$4::uuid)
       AND c.status::text<>'archived'`,
    actor.tenantId, clientId, actor.clerkUserId, actor.userId ?? null,
  );
  if (rows.length !== 1 || !await clientMemoryAllowed(tx, actor.tenantId, rows[0]!.userId, clientId))
    throw new TrackerMetricsError('client_not_readable');
  return JSON.stringify(rows[0]);
}

export interface TrackerMaterialChanges {
  metric: 'tracker.material_changes'; version: 1; backend: TrackerMetricsBackend; clientId: string;
  window: { start: string; end: string; bounds: '[start,end)'; days: 21 };
  asOf: string; observedAt: string; sourceObservedAt: string | null;
  count: number; complete: true; capped: false;
}

// Both stores already retain classified material events. Aggregate DISTINCT
// current tracked identities in SQL, without fetching pages or reclassifying.
const CORE_CHANGES = `
WITH tracked AS (
 SELECT DISTINCT bill_id FROM tracked_bill WHERE tenant_id=$1::uuid AND client_id=$2::uuid
), changes AS (
 SELECT c.data->>'bill_id' AS bill_id, max(c.detected_at) AS observed
 FROM intelligence_change c JOIN tracked t ON t.bill_id=c.data->>'bill_id'
 WHERE c.source='congress_bill' AND $2::uuid=ANY(c.related_client_ids)
   AND c.change_type<>'' AND c.detected_at >= $3::timestamptz AND c.detected_at < $4::timestamptz
 GROUP BY c.data->>'bill_id'
)
SELECT (SELECT count(*)::text FROM changes) AS count,
       (SELECT max(observed) FROM changes) AS "sourceObservedAt",
       (SELECT count(*)::text FROM tracked WHERE bill_id !~ '^[0-9]+-(hr|s|hjres|sjres|hconres|sconres|hres|sres)-[0-9]+$') AS unsupported`;

const INTEL_CHANGES = `
WITH tracked AS (
 SELECT DISTINCT bill_id, source FROM intel_tracked_bill WHERE tenant_id=$1 AND client_id=$2
), changes AS (
 SELECT t.bill_id, max(a.created_at) AS observed FROM tracked t
 JOIN intel_alert a ON a.source_ref=t.bill_id AND a.tenant_id=$1 AND a.client_id=$2
   AND ((t.source='congress' AND a.source_type='bill') OR (t.source='state' AND a.source_type='state_bill'))
 WHERE a.change_type IS NOT NULL AND a.change_type<>''
   AND a.created_at >= $3::timestamptz AND a.created_at < $4::timestamptz
 GROUP BY t.bill_id
)
SELECT (SELECT count(*)::text FROM changes) AS count,
       (SELECT max(observed) FROM changes) AS "sourceObservedAt",
       (SELECT count(*)::text FROM tracked WHERE source NOT IN ('congress','state')) AS unsupported`;

/** Fixed 21-day producer count. One database observation budget also covers
 * current access before/after COUNT; transaction cleanup is always awaited. */
export async function readTrackerMaterialChanges(
  database: TrackerMetricsDatabase, supplied: TrackerMetricsActor, rawClientId: string,
  backend: TrackerMetricsBackend, query: unknown = {}, now: () => number = Date.now,
): Promise<TrackerMaterialChanges> {
  const clientId = trackerMetricsClientId(rawClientId), actor = { ...supplied };
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length ||
      !['core', 'intelligence'].includes(backend)) throw new TrackerMetricsError('invalid_request');
  const end = now(), start = end - 21 * 86400000, mono = performance.now();
  const remaining = () => {
    const at = now(), elapsed = performance.now() - mono;
    if (!Number.isSafeInteger(end) || start < 0 || end > 8640000000000000 ||
        !Number.isSafeInteger(at) || at < end || !Number.isFinite(elapsed) || elapsed < 0)
      throw new TrackerMetricsError('deadline');
    const ms = 10000 - Math.max(at - end, elapsed);
    if (ms <= 0) throw new TrackerMetricsError('deadline');
    return Math.ceil(ms);
  };
  remaining();
  const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), bounds: '[start,end)' as const, days: 21 as const };
  try {
    const result = await database.withTenant(actor.tenantId, async tx => {
      const bounded: ResourceScopeTransaction = {
        async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
          const ms = `${remaining()}ms`;
          await tx.$executeRawUnsafe("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", ms);
          remaining(); const value = await tx.$queryRawUnsafe<T>(sql, ...values); remaining(); return value;
        },
      };
      const before = await readTrackerClientScope(bounded, actor, clientId);
      const rows = await bounded.$queryRawUnsafe<Array<{ count: string; unsupported: string; sourceObservedAt: Date | null }>>(
        backend === 'core' ? CORE_CHANGES : INTEL_CHANGES, actor.tenantId, clientId, window.start, window.end,
      );
      const after = await readTrackerClientScope(bounded, actor, clientId);
      if (before !== after) throw new TrackerMetricsError('scope_changed');
      const row = rows[0];
      if (rows.length !== 1 || !row || !/^(0|[1-9][0-9]*)$/.test(row.count) ||
          !/^(0|[1-9][0-9]*)$/.test(row.unsupported) || !Number.isSafeInteger(Number(row.count)))
        throw new TrackerMetricsError('invalid_aggregate');
      if (row.unsupported !== '0') throw new TrackerMetricsError('unsupported_bill_source');
      const sourceAt = row.sourceObservedAt === null ? null : new Date(row.sourceObservedAt).getTime();
      if (sourceAt !== null && (!Number.isFinite(sourceAt) || sourceAt < start || sourceAt >= end) ||
          (Number(row.count) === 0) !== (sourceAt === null)) throw new TrackerMetricsError('invalid_aggregate');
      return { count: Number(row.count), sourceObservedAt: sourceAt === null ? null : new Date(sourceAt).toISOString() };
    }, { timeoutMs: remaining() });
    remaining();
    return { metric: 'tracker.material_changes', version: 1, backend, clientId, window,
      asOf: window.end, observedAt: new Date(now()).toISOString(), ...result, complete: true, capped: false };
  } catch (error) {
    remaining();
    if (error instanceof TrackerMetricsError) throw error;
    throw new TrackerMetricsError('source_unavailable');
  }
}
