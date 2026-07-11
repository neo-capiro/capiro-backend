/**
 * Read-only diagnostic (plan W6.2 / D4): per-tenant usage of the LEGACY
 * EngagementCampaign surface (`/api/engagement/campaigns/*`), to decide whether it
 * is safe to retire. Reports, per tenant: campaign-row count, recipient-row count,
 * newest campaign updatedAt, and a status/type breakdown. A tenant with zero rows
 * (or only stale ones) is a retirement candidate.
 *
 *   pnpm --filter @capiro/api diag:engagement-campaigns
 *
 * NOTE: this answers D4's "row count per tenant + newest updatedAt" directly. It
 * does NOT answer read-only traffic (GET-only integrations) — there is no
 * per-request access log in the repo (no morgan/interceptor, no ALB access logs),
 * so a pure-read consumer is invisible here; combine with the generate-route AI
 * usage from `diag:outreach-usage` (workflow 'campaign_email') for the fullest
 * picture, and surface the logging gap to Ninja before deletion (see the plan).
 *
 * SAFE: aggregate reads only, no writes. Reads the tables directly (not RLS-scoped)
 * so it summarizes every tenant. Exits non-zero on error.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [campaigns, recipients, tenants] = await Promise.all([
    prisma.engagementCampaign.groupBy({
      by: ['tenantId', 'status'],
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.engagementCampaignRecipient.groupBy({
      by: ['tenantId'],
      _count: { _all: true },
    }),
    prisma.tenant.findMany({ select: { id: true, slug: true } }),
  ]);

  if (!campaigns.length) {
    // eslint-disable-next-line no-console
    console.log('No engagement_campaigns rows in ANY tenant — the legacy surface is unused.');
    return;
  }

  const slugOf = new Map(tenants.map((t) => [t.id, t.slug]));
  const recipientCount = new Map(recipients.map((r) => [r.tenantId, r._count._all]));

  // Group campaign rows by tenant.
  const byTenant = new Map<string, typeof campaigns>();
  for (const r of campaigns) {
    const list = byTenant.get(r.tenantId) ?? [];
    list.push(r);
    byTenant.set(r.tenantId, list);
  }

  // eslint-disable-next-line no-console
  console.log('Legacy EngagementCampaign usage by tenant (D4 retirement check):\n');
  for (const [tenantId, list] of byTenant) {
    const total = list.reduce((n, r) => n + r._count._all, 0);
    const newest = list
      .map((r) => r._max.updatedAt)
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const statusBreakdown = list.map((r) => `${r.status}=${r._count._all}`).join(', ');
    // eslint-disable-next-line no-console
    console.log(
      `■ ${slugOf.get(tenantId) ?? tenantId}\n` +
        `   campaigns=${total} (${statusBreakdown})\n` +
        `   recipients=${recipientCount.get(tenantId) ?? 0}\n` +
        `   newestUpdatedAt=${newest ? newest.toISOString() : 'n/a'}`,
    );
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
