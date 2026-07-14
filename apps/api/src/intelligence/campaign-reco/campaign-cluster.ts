/**
 * Phase 5 §5.3 — outreach-campaign recommendation clustering (pure, DB-free,
 * unit-tested). When one legislative/budget development touches MULTIPLE of a
 * firm's clients, that's a campaign opportunity; this groups intelligence_change
 * rows by the shared item (bill / PE / issue) and — critically — projects each
 * cluster onto per-TENANT client subsets.
 *
 * ⚠️ TENANT ISOLATION: intelligence_change is a GLOBAL table with no tenantId,
 * and relatedClientIds spans tenants. splitClustersByTenant is the ONLY thing
 * that keeps one firm's campaign alert from naming another firm's clients — it
 * must be applied before any alert is written. Kept pure so that guard is
 * directly unit-tested.
 */

export type IntelSeverity = 'info' | 'notable' | 'critical';

export interface IntelChangeRow {
  id: string;
  source: string;
  changeType: string;
  severity: string;
  title: string;
  description: string;
  relatedClientIds: string[];
  relatedPeCodes: string[];
  relatedIssues: string[];
  /** Normalized bill key the caller extracts from data.bill_id (null for non-bill rows). */
  billId?: string | null;
}

export interface CampaignCluster {
  /** Stable cluster key: `bill:<id>` | `pe:<code>` | `issue:<code>`. */
  key: string;
  kind: 'bill' | 'pe' | 'issue';
  label: string;
  changeIds: string[];
  /** Every client touched by the cluster, ACROSS tenants (not yet isolated). */
  clientIds: string[];
  maxSeverity: IntelSeverity;
  /** Count of member changes at 'notable' or higher (materiality signal). */
  notablePlusCount: number;
  peCodes: string[];
  billId?: string | null;
  /**
   * Traceable evidence for the alert body (SC 5.3.1): title + first line, plus
   * the change's own relatedClientIds so the surfaced evidence can be scoped to
   * the recipient tenant (never quote another firm's change).
   */
  evidence: Array<{ changeId: string; title: string; snippet: string; relatedClientIds: string[] }>;
}

export interface PerTenantCluster {
  tenantId: string;
  cluster: CampaignCluster;
  /** The subset of the cluster's clients that belong to THIS tenant (active). */
  clientIds: string[];
  clientNames: string[];
  /**
   * TENANT-SCOPED change ids + evidence: only the changes whose relatedClientIds
   * intersect THIS tenant's clients. The global cluster.changeIds/evidence are a
   * cross-tenant union, so alerts must use these scoped fields — never the
   * cluster's — to avoid persisting or quoting another firm's change records.
   */
  changeIds: string[];
  evidence: CampaignCluster['evidence'];
}

const SEVERITY_RANK: Record<IntelSeverity, number> = { info: 0, notable: 1, critical: 2 };
// Normalizes the two severity vocabularies in intelligence_change: federal
// writers use critical/notable/info; the state writer uses high/medium/info.
const asSeverity = (s: string): IntelSeverity =>
  s === 'critical' || s === 'high'
    ? 'critical'
    : s === 'notable' || s === 'medium'
      ? 'notable'
      : 'info';

/** The cluster keys a change belongs to: its bill, plus each PE, plus each issue. */
export function clusterKeysForRow(
  row: IntelChangeRow,
): Array<{ key: string; kind: CampaignCluster['kind']; label: string }> {
  const keys: Array<{ key: string; kind: CampaignCluster['kind']; label: string }> = [];
  if (row.billId) keys.push({ key: `bill:${row.billId}`, kind: 'bill', label: row.billId });
  for (const pe of row.relatedPeCodes ?? []) keys.push({ key: `pe:${pe}`, kind: 'pe', label: pe });
  for (const issue of row.relatedIssues ?? [])
    keys.push({ key: `issue:${issue}`, kind: 'issue', label: issue });
  return keys;
}

/** Fold change rows into clusters, unioning the clients each shared item touches. */
export function buildCampaignClusters(rows: IntelChangeRow[]): CampaignCluster[] {
  const map = new Map<string, CampaignCluster>();
  for (const row of rows) {
    const sev = asSeverity(row.severity);
    for (const { key, kind, label } of clusterKeysForRow(row)) {
      let c = map.get(key);
      if (!c) {
        c = {
          key,
          kind,
          label,
          changeIds: [],
          clientIds: [],
          maxSeverity: 'info',
          notablePlusCount: 0,
          peCodes: [],
          billId: kind === 'bill' ? row.billId : null,
          evidence: [],
        };
        map.set(key, c);
      }
      if (!c.changeIds.includes(row.id)) {
        c.changeIds.push(row.id);
        if (SEVERITY_RANK[sev] >= SEVERITY_RANK.notable) c.notablePlusCount++;
        c.evidence.push({
          changeId: row.id,
          title: row.title,
          snippet: (row.description ?? '').split('\n')[0]?.slice(0, 200) ?? '',
          relatedClientIds: row.relatedClientIds ?? [],
        });
      }
      if (SEVERITY_RANK[sev] > SEVERITY_RANK[c.maxSeverity]) c.maxSeverity = sev;
      for (const cid of row.relatedClientIds ?? [])
        if (!c.clientIds.includes(cid)) c.clientIds.push(cid);
      for (const pe of row.relatedPeCodes ?? []) if (!c.peCodes.includes(pe)) c.peCodes.push(pe);
    }
  }
  return [...map.values()];
}

/**
 * Material enough to propose a campaign: a critical development, or a cluster
 * that drew ≥2 notable-plus changes (sustained attention). Below that it's
 * noise, not a campaign (SC 5.3.3 selectivity).
 */
export function isClusterMaterial(cluster: CampaignCluster): boolean {
  return cluster.maxSeverity === 'critical' || cluster.notablePlusCount >= 2;
}

/**
 * Project clusters onto per-tenant client subsets. THE ISOLATION GUARD: a
 * client only counts for its own tenant, and only when active. Returns entries
 * only for (tenant, cluster) pairs where the tenant has ≥ minClients active
 * clients in the cluster — i.e. a real multi-client campaign for THAT firm.
 */
export function splitClustersByTenant(
  clusters: CampaignCluster[],
  clientTenant: Map<string, { tenantId: string; name: string; active: boolean }>,
  minClients: number,
): PerTenantCluster[] {
  const out: PerTenantCluster[] = [];
  for (const cluster of clusters) {
    if (!isClusterMaterial(cluster)) continue;
    // Bucket this cluster's clients by their OWN tenant (active only).
    const byTenant = new Map<string, { ids: string[]; names: string[] }>();
    for (const cid of cluster.clientIds) {
      const c = clientTenant.get(cid);
      if (!c || !c.active) continue;
      let b = byTenant.get(c.tenantId);
      if (!b) {
        b = { ids: [], names: [] };
        byTenant.set(c.tenantId, b);
      }
      b.ids.push(cid);
      b.names.push(c.name);
    }
    for (const [tenantId, b] of byTenant) {
      if (b.ids.length < minClients) continue;
      // Scope changeIds/evidence to THIS tenant: only changes that touch one of
      // its clients. cluster.changeIds/evidence are a cross-tenant union, so
      // surfacing them verbatim would persist/quote another firm's records.
      const ownSet = new Set(b.ids);
      const evidence = cluster.evidence.filter((e) =>
        e.relatedClientIds.some((cid) => ownSet.has(cid)),
      );
      out.push({
        tenantId,
        cluster,
        clientIds: b.ids,
        clientNames: b.names,
        changeIds: evidence.map((e) => e.changeId),
        evidence,
      });
    }
  }
  return out;
}
