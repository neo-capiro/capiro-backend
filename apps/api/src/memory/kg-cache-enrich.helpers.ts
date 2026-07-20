/**
 * Track B cutover — System-A graph enrichment from the materialized
 * kg_edge_cache (KG_TRAVERSAL_SOURCE='cache' / per-tenant kgTraversalSource).
 *
 * The tenant graph the UI panel and the Meri graph tools build (memory-graph
 * System A) stays the seedless whole-tenant backbone; this module ADDS the
 * world-class canonical relationships (aggregated FEC money flow, LDA lobbying,
 * intel mappings, capabilities→PEs) around the tenant's own clients via
 * seed-based bounded walks — per the plan rule "no unseeded cache scan ships":
 * every read goes through kg_walk_bounded (SECURITY DEFINER), which takes the
 * MANDATORY (tenant_id, denied_client_ids[]) pair and re-applies both filters
 * at every hop. This module never reads kg_edge_cache directly (it has no
 * SELECT grant), and never seeds a walk from a denied client.
 *
 * Ceilings, all enforced here on top of the in-function bounds: per-client
 * fanout/row budget, a global edge ceiling, and a wall-clock deadline — a
 * dense tenant degrades to partial enrichment (truncated=true), never to a
 * pool-holding runaway (the RC3 lesson).
 */
import { Prisma } from '@prisma/client';
import type { FkRelation } from './memory-graph.helpers.js';
import { toUuidArrayLiteral } from './memory-wall.helpers.js';

type Tx = Prisma.TransactionClient;

/** One edge row from kg_walk_bounded (the M2 return shape, minus depth bookkeeping). */
export interface KgWalkEdgeRow {
  depth: number;
  src_kind: string;
  src_id: string;
  dst_kind: string;
  dst_id: string;
  edge_type: string;
  confidence: number | null;
  source: string | null;
  origin: string | null;
  observed_at: Date | null;
  agg_weight: unknown; // Postgres numeric → Prisma.Decimal | null
  agg_count: number | null;
}

/**
 * Edge types dropped from enrichment: meetings already exist in System A with
 * real subject labels (met-on), and mail threads are deliberately not graph
 * nodes today — cache rows for either would only duplicate or de-anonymize.
 * Unconfirmed auto-matches are dropped for the same reason the intel graph
 * drops them: the graph reflects the resolved state, not the candidate pool.
 */
const NOISE_EDGE_TYPES: ReadonlySet<string> = new Set([
  'meeting_with_client',
  'mail_thread_with_client',
]);

/** "$14,500,000 over 630" / "12 filings" agg annotation for a relation label. */
export function aggSuffix(aggWeight: unknown, aggCount: number | null): string {
  const weight = aggWeight == null ? null : Number(aggWeight);
  if (weight != null && Number.isFinite(weight) && weight > 0) {
    const dollars = `$${Math.round(weight).toLocaleString('en-US')}`;
    return aggCount ? ` (${dollars} over ${aggCount})` : ` (${dollars})`;
  }
  if (aggCount && aggCount > 1) return ` (${aggCount} filings)`;
  return '';
}

/** Stable dedup key for a cache edge (matches the MV's logical identity). */
export function cacheEdgeKey(r: KgWalkEdgeRow): string {
  return `${r.src_kind}${r.src_id}${r.edge_type}${r.dst_kind}${r.dst_id}`;
}

/** True for rows enrichment keeps (drops noise types + unconfirmed auto-matches). */
export function keepCacheEdge(r: KgWalkEdgeRow): boolean {
  if (NOISE_EDGE_TYPES.has(r.edge_type)) return false;
  if (r.source === 'auto_matched') return false;
  return true;
}

/**
 * Pure mapper: cache edges → System-A FkRelation rows. Node ids follow the
 * System-A `${kind}:${id}` convention (client ids are UUIDs in both worlds, so
 * `client:<uuid>` lands on the SAME node the FK backbone already built).
 * Aggregate money/filing totals ride in the relation label — that is the
 * reasoning-grade payload ("Acme gave $2.1M over 40 contributions").
 */
export function cacheEdgesToFkRelations(
  rows: readonly KgWalkEdgeRow[],
  labelByNodeKey: ReadonlyMap<string, string>,
): FkRelation[] {
  return rows.map((r) => ({
    srcType: r.src_kind,
    srcSlug: r.src_id,
    srcLabel: labelByNodeKey.get(`${r.src_kind}:${r.src_id}`) ?? r.src_id,
    dstType: r.dst_kind,
    dstSlug: r.dst_id,
    dstLabel: labelByNodeKey.get(`${r.dst_kind}:${r.dst_id}`) ?? r.dst_id,
    relation: `${r.edge_type}${aggSuffix(r.agg_weight, r.agg_count)}`,
  }));
}

export interface KgCacheEnrichResult {
  relations: FkRelation[];
  clientsWalked: number;
  clientsTotal: number;
  truncated: boolean;
}

export interface KgCacheEnrichOpts {
  tenantId: string;
  /** Walled clients this viewer may not see (from fetchDeniedClientIds). */
  deniedClientIds: readonly string[];
  /** The tenant's visible clients to seed walks from (id = client UUID). */
  clients: ReadonlyArray<{ id: string; name: string }>;
  depth?: number; // default 2 (client → mapped entity → its relationships)
  perClientFanout?: number; // default 20
  perClientRowBudget?: number; // default 80
  edgeCeiling?: number; // default 600 total deduped edges
  deadlineMs?: number; // default 2500 wall-clock for ALL walks
  now?: () => number; // injectable clock for tests
}

/**
 * Seed-based bounded enrichment: one kg_walk_bounded per visible client,
 * sequential on the caller's transaction, until the edge ceiling or deadline.
 * Runs inside the caller's withTenant/withTenantUser tx so the wall snapshot
 * (deniedClientIds) and the graph read are consistent.
 */
export async function enrichFromKgCache(
  tx: Tx,
  opts: KgCacheEnrichOpts,
): Promise<KgCacheEnrichResult> {
  const depth = opts.depth ?? 2;
  const fanout = opts.perClientFanout ?? 20;
  const budget = opts.perClientRowBudget ?? 80;
  const ceiling = opts.edgeCeiling ?? 600;
  const deadlineMs = opts.deadlineMs ?? 2500;
  const now = opts.now ?? Date.now;

  const deniedSet = new Set(opts.deniedClientIds);
  // Defensive re-filter: never seed a walk at a denied client, even if the
  // caller's client list slipped one through.
  const seeds = opts.clients.filter((c) => !deniedSet.has(c.id));
  const deniedLiteral = Prisma.raw(toUuidArrayLiteral(opts.deniedClientIds));

  const started = now();
  const dedup = new Map<string, KgWalkEdgeRow>();
  let clientsWalked = 0;
  let truncated = false;

  for (const seed of seeds) {
    if (dedup.size >= ceiling || now() - started > deadlineMs) {
      truncated = true;
      break;
    }
    const rows = await tx.$queryRaw<Array<KgWalkEdgeRow>>`
      SELECT depth, src_kind, src_id, dst_kind, dst_id, edge_type, confidence,
             source, origin, observed_at, agg_weight, agg_count
      FROM kg_walk_bounded(
        ${opts.tenantId}::uuid,
        ${deniedLiteral},
        'client', ${seed.id}, ${depth}, NULL::text[], ${fanout}, ${budget}, 'both')
    `;
    clientsWalked += 1;
    for (const r of rows) {
      if (!keepCacheEdge(r)) continue;
      const key = cacheEdgeKey(r);
      if (!dedup.has(key)) dedup.set(key, r);
      if (dedup.size >= ceiling) break;
    }
  }
  if (clientsWalked < seeds.length) truncated = true;

  const kept = Array.from(dedup.values());
  const labelByNodeKey = await resolveCacheNodeLabels(tx, opts.tenantId, kept);
  // Seed clients label their own nodes (the walk rows carry only ids).
  for (const c of seeds) labelByNodeKey.set(`client:${c.id}`, c.name);

  return {
    relations: cacheEdgesToFkRelations(kept, labelByNodeKey),
    clientsWalked,
    clientsTotal: seeds.length,
    truncated,
  };
}

/**
 * Batch human-label resolution for the id-keyed node kinds the cache emits
 * (mirrors the intel graph's lookup set — without it the panel renders
 * "189497"-style labels). Self-labeled kinds (employer, candidate,
 * lda_issue_code, program_element) need no lookup. One query per kind that is
 * actually present; all reads are canonical/no-RLS except the tenant-scoped
 * capability lookup.
 */
export async function resolveCacheNodeLabels(
  tx: Tx,
  tenantId: string,
  rows: ReadonlyArray<{ src_kind: string; src_id: string; dst_kind: string; dst_id: string }>,
): Promise<Map<string, string>> {
  const idsByKind = new Map<string, Set<string>>();
  for (const r of rows) {
    (idsByKind.get(r.src_kind) ?? idsByKind.set(r.src_kind, new Set()).get(r.src_kind)!).add(
      r.src_id,
    );
    (idsByKind.get(r.dst_kind) ?? idsByKind.set(r.dst_kind, new Set()).get(r.dst_kind)!).add(
      r.dst_id,
    );
  }
  const labels = new Map<string, string>();
  const intIds = (kind: string) =>
    Array.from(idsByKind.get(kind) ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));

  const ldaClientIds = intIds('lda_client');
  if (ldaClientIds.length) {
    const found = await tx.$queryRaw<Array<{ id: number; name: string }>>`
      SELECT id, name FROM lda_client WHERE id = ANY(${ldaClientIds}::int[])`;
    for (const r of found) labels.set(`lda_client:${r.id}`, r.name);
  }
  const ldaRegistrantIds = intIds('lda_registrant');
  if (ldaRegistrantIds.length) {
    const found = await tx.$queryRaw<Array<{ id: number; name: string }>>`
      SELECT id, name FROM lda_registrant WHERE id = ANY(${ldaRegistrantIds}::int[])`;
    for (const r of found) labels.set(`lda_registrant:${r.id}`, r.name);
  }
  const fecCommitteeIds = Array.from(idsByKind.get('fec_committee') ?? []);
  if (fecCommitteeIds.length) {
    // Names come from fec_committee (one row per committee, PK id) — NOT a
    // DISTINCT over fec_contribution, whose committee_id index would still
    // heap-scan a mega-committee's entire contribution history (10^5-10^6 rows)
    // inside the pooled graph tx (the RC3 pooled-hold class this cutover closes).
    const found = await tx.$queryRaw<Array<{ id: string; name: string | null }>>`
      SELECT id, name FROM fec_committee WHERE id = ANY(${fecCommitteeIds}::text[])`;
    for (const r of found) {
      if (r.name) labels.set(`fec_committee:${r.id}`, r.name);
    }
  }
  const capabilityIds = Array.from(idsByKind.get('capability') ?? []);
  if (capabilityIds.length) {
    const found = await tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM client_capabilities
      WHERE tenant_id = ${tenantId}::uuid AND id::text = ANY(${capabilityIds}::text[])`;
    for (const r of found) labels.set(`capability:${r.id}`, r.name);
  }
  const billIds = Array.from(idsByKind.get('bill') ?? []);
  if (billIds.length) {
    const found = await tx.$queryRaw<Array<{ id: string; title: string | null }>>`
      SELECT id, title FROM congress_bill WHERE id = ANY(${billIds}::text[])`;
    for (const r of found) {
      if (r.title) labels.set(`bill:${r.id}`, r.title);
    }
  }
  return labels;
}
