/**
 * Generate Meri proactive alerts on a schedule (replaces the per-message
 * in-stream scan that previously ran generateProactiveAlerts() after every
 * chat reply). Scans every ACTIVE tenant for:
 *
 *   1. Upcoming meetings (next 48h) that have no prep notes.
 *   2. Active clients with no meeting/engagement in 30+ days.
 *
 * and writes clio_proactive_alert rows (status=pending) that the Meri bell +
 * "Scheduled briefings" banner surface via GET /api/clio/alerts. Dedupes per
 * (tenant, sourceType, sourceId) against BOTH pending AND dismissed ('read')
 * rows, so a dismissed alert stays dismissed instead of resurrecting on the
 * next run while the underlying condition still holds.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/emit-clio-alerts.ts
 *
 * Intended cadence: every 30-60 min via the existing scheduled-task runner
 * (same mechanism as sync-* / emit-bill-alerts). No schema changes — mirrors
 * MeriService.generateProactiveAlerts but runs standalone (no Nest DI) and
 * iterates all tenants. Reads meeting/client/clio_proactive_alert.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { isReviewDue } from '../src/memory/memory-staleness.helpers.js';
import {
  buildCampaignClusters,
  splitClustersByTenant,
  isClusterMaterial,
  type IntelChangeRow,
} from '../src/intelligence/campaign-reco/campaign-cluster.js';
dotenvConfig();

const prisma = new PrismaClient();

const STALE_CLIENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PER_TENANT_TAKE = 5;
// Client "position" memory (blueprint §3.2 stale-position detection). Judgment/
// strategy files — client-people is a directory, not a position.
const POSITION_TYPES = ['client-soul', 'client-compass'];
// Campaign-rec: how far back to scan legislative/budget changes, and the min
// distinct clients a single item must touch to be worth proposing a campaign.
const CAMPAIGN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const CAMPAIGN_MIN_CLIENTS = 2;

async function generateForTenant(tenantId: string): Promise<number> {
  let created = 0;

  // 1. Upcoming-meeting "prep needed" alerts — REMOVED (2026-07-14): meeting
  // prep alerts are no longer surfaced in Meri per product decision. `now` is
  // still needed by the stale-client + campaign scans below.
  const now = new Date();

  // 2. Active clients with no recent engagement (30+ days).
  const staleSince = new Date(now.getTime() - STALE_CLIENT_WINDOW_MS);
  const staleClients = await prisma.client.findMany({
    where: {
      tenantId,
      status: 'active',
      meetings: { none: { startsAt: { gte: staleSince } } },
    },
    select: { id: true, name: true },
    take: PER_TENANT_TAKE,
  });

  for (const client of staleClients) {
    const exists = await prisma.clioProactiveAlert.findFirst({
      // pending OR read: a dismissed alert must not resurrect on the next run.
      where: {
        tenantId,
        sourceType: 'stale_client',
        sourceId: client.id,
        status: { in: ['pending', 'read'] },
      },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.clioProactiveAlert.create({
      data: {
        tenantId,
        clientId: client.id,
        alertType: 'client_activity',
        title: `No recent activity: ${client.name}`,
        body: `${client.name} hasn't had a meeting or engagement in over 30 days. Consider scheduling a check-in.`,
        priority: 'normal',
        sourceType: 'stale_client',
        sourceId: client.id,
        metadata: {},
      },
    });
    created++;
  }

  // 3. Stale / contradictory client POSITIONS (blueprint §3.2). Reads REAL
  // Phase-1 governance fields (reviewCadenceDays/lastConfirmedAt → review-due;
  // reviewer-set contradictsId → flagged conflict) — never a heuristic. Scoped
  // to ACTIVE clients first so the alert's clientId FK is always valid, and the
  // standalone script has no RLS context so the tenantId/clientId filters ARE
  // the isolation guarantee. High priority so it clears the importance floor.
  const activeClients = await prisma.client.findMany({
    where: { tenantId, status: 'active' },
    select: { id: true, name: true },
  });
  if (activeClients.length > 0) {
    const clientName = new Map(activeClients.map((c) => [c.id, c.name] as const));
    const positions = await prisma.memoryItem.findMany({
      where: {
        tenantId,
        clientId: { in: activeClients.map((c) => c.id) },
        type: { in: POSITION_TYPES },
        status: 'active',
      },
      select: {
        id: true,
        clientId: true,
        title: true,
        createdAt: true,
        lastConfirmedAt: true,
        reviewCadenceDays: true,
        contradictsId: true,
      },
      orderBy: { createdAt: 'asc' },
      // Safety bound far above any firm's position count. review-due is computed
      // in-memory (per-row cadence math), so we must consider ALL active
      // positions — an arbitrary window would permanently starve flagged ones
      // in the tail.
      take: 1000,
    });
    // Flag in-memory, then surface the most urgent first: contradictions before
    // mere review-due, so a small per-tenant cap never buries a real conflict.
    const flagged = positions
      .filter((p) => p.clientId != null)
      .map((p) => ({
        p,
        contradicted: p.contradictsId != null,
        reviewDue: isReviewDue({
          reviewCadenceDays: p.reviewCadenceDays,
          lastConfirmedAt: p.lastConfirmedAt,
          createdAt: p.createdAt,
        }),
      }))
      .filter((f) => f.contradicted || f.reviewDue)
      .sort((a, b) => Number(b.contradicted) - Number(a.contradicted));
    let positionAlerts = 0;
    for (const { p, contradicted } of flagged) {
      if (positionAlerts >= PER_TENANT_TAKE) break;
      const clientId = p.clientId!;
      const exists = await prisma.clioProactiveAlert.findFirst({
        where: {
          tenantId,
          sourceType: 'stale_position',
          sourceId: p.id,
          status: { in: ['pending', 'read'] },
        },
        select: { id: true },
      });
      if (exists) continue;
      const name = clientName.get(clientId) ?? 'this client';
      const reason = contradicted
        ? `A saved position for ${name} ("${p.title}") is flagged as contradicting another memory.`
        : `A saved position for ${name} ("${p.title}") is past its review cadence and hasn't been reconfirmed.`;
      await prisma.clioProactiveAlert.create({
        data: {
          tenantId,
          clientId,
          alertType: 'stale_position',
          title: `Review client position: ${name}`,
          body: `${reason} Ask Meri to confirm, correct, or forget it before your next draft relies on it.`,
          priority: 'high',
          sourceType: 'stale_position',
          sourceId: p.id,
          metadata: {
            memoryItemId: p.id,
            reason: contradicted ? 'contradicts' : 'review_due',
          },
        },
      });
      created++;
      positionAlerts++;
    }
  }

  return created;
}

/**
 * Outreach-campaign recommendation (blueprint §3.2). Cross-tenant by nature:
 * intelligence_change is a GLOBAL table, so we scan once, cluster by shared
 * bill/PE/issue, then SPLIT strictly per tenant (splitClustersByTenant) before
 * writing — one firm's alert can never name another firm's clients. Dark by
 * default (CAMPAIGN_RECO_ENABLED), high-priority (clears the importance floor),
 * capped per tenant. Returns alerts created.
 */
async function generateCampaignRecommendations(): Promise<number> {
  if (process.env.CAMPAIGN_RECO_ENABLED !== 'true') return 0;
  const since = new Date(Date.now() - CAMPAIGN_LOOKBACK_MS);
  const changes = await prisma.intelligenceChange.findMany({
    where: { detectedAt: { gte: since }, relatedClientIds: { isEmpty: false } },
    select: {
      id: true,
      source: true,
      changeType: true,
      severity: true,
      title: true,
      description: true,
      relatedClientIds: true,
      relatedPeCodes: true,
      relatedIssues: true,
      data: true,
    },
    take: 2000,
  });
  if (changes.length === 0) return 0;

  const rows: IntelChangeRow[] = changes.map((c) => {
    const data = (c.data ?? {}) as Record<string, unknown>;
    // Federal writers store data.bill_id (snake); the state writer stores
    // data.billId (camel) — accept both so state bills cluster too.
    const billId =
      typeof data.bill_id === 'string'
        ? data.bill_id
        : typeof data.billId === 'string'
          ? data.billId
          : null;
    return {
      id: c.id,
      source: c.source,
      changeType: c.changeType,
      severity: c.severity,
      title: c.title,
      description: c.description,
      relatedClientIds: c.relatedClientIds,
      relatedPeCodes: c.relatedPeCodes,
      relatedIssues: c.relatedIssues,
      billId,
    };
  });

  const clusters = buildCampaignClusters(rows);
  // Resolve every touched client to its OWN tenant (the isolation guard input).
  const allClientIds = [...new Set(clusters.flatMap((c) => c.clientIds))];
  if (allClientIds.length === 0) return 0;
  const clients = await prisma.client.findMany({
    where: { id: { in: allClientIds } },
    select: { id: true, name: true, tenantId: true, status: true },
  });
  const clientTenant = new Map(
    clients.map(
      (c) => [c.id, { tenantId: c.tenantId, name: c.name, active: c.status === 'active' }] as const,
    ),
  );
  const perTenant = splitClustersByTenant(clusters, clientTenant, CAMPAIGN_MIN_CLIENTS);

  let created = 0;
  const perTenantCount = new Map<string, number>();
  for (const entry of perTenant) {
    if ((perTenantCount.get(entry.tenantId) ?? 0) >= PER_TENANT_TAKE) continue;
    const exists = await prisma.clioProactiveAlert.findFirst({
      where: {
        tenantId: entry.tenantId,
        sourceType: 'campaign_reco',
        sourceId: entry.cluster.key,
        status: { in: ['pending', 'read'] },
      },
      select: { id: true },
    });
    if (exists) continue;
    const names = entry.clientNames.join(', ');
    // Quote evidence scoped to THIS tenant's own changes (never another firm's).
    const ev = entry.evidence[0]?.title ?? entry.cluster.label;
    await prisma.clioProactiveAlert.create({
      data: {
        tenantId: entry.tenantId,
        clientId: null, // multi-client campaign — no single client
        alertType: 'campaign_recommendation',
        title: `Campaign opportunity: ${entry.cluster.label} affects ${entry.clientIds.length} clients`,
        body: `"${ev}" touches ${entry.clientIds.length} of your clients (${names}). Consider a coordinated outreach campaign. Ask Meri to draft it.`,
        priority: 'high',
        sourceType: 'campaign_reco',
        sourceId: entry.cluster.key,
        metadata: {
          clusterKey: entry.cluster.key,
          kind: entry.cluster.kind,
          clientIds: entry.clientIds,
          changeIds: entry.changeIds, // tenant-scoped, not the global union
          maxSeverity: entry.cluster.maxSeverity,
        },
      },
    });
    perTenantCount.set(entry.tenantId, (perTenantCount.get(entry.tenantId) ?? 0) + 1);
    created++;
  }
  return created;
}

async function main(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: { status: 'active' },
    select: { id: true, slug: true },
  });
  console.log(`[emit-clio-alerts] scanning ${tenants.length} active tenant(s)`);

  let totalCreated = 0;
  for (const tenant of tenants) {
    try {
      const n = await generateForTenant(tenant.id);
      totalCreated += n;
      if (n > 0) console.log(`[emit-clio-alerts] ${tenant.slug}: created ${n} alert(s)`);
    } catch (err) {
      // One tenant's failure must not abort the rest of the run.
      console.error(`[emit-clio-alerts] ${tenant.slug}: FAILED: ${(err as Error).message}`);
    }
  }

  // Cross-tenant campaign-recommendation pass (dark unless CAMPAIGN_RECO_ENABLED).
  try {
    const campaignN = await generateCampaignRecommendations();
    totalCreated += campaignN;
    if (campaignN > 0)
      console.log(`[emit-clio-alerts] campaign recommendations: created ${campaignN}`);
  } catch (err) {
    console.error(`[emit-clio-alerts] campaign-reco pass FAILED: ${(err as Error).message}`);
  }

  console.log(
    `[emit-clio-alerts] done. Created ${totalCreated} new alert(s) across ${tenants.length} tenant(s).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
