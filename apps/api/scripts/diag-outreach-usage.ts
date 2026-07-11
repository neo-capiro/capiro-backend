/**
 * Read-only diagnostic (plan W3.4): per-tenant outreach AI usage over a window —
 * draft counts, input/output tokens, cost, and prompt-cache hit rate, split by
 * prompt-spec version. Arms the daily-budget tuning + the W2.7/W3 cache-savings
 * story ("v2 drafts 2..N are hitting the cache").
 *
 *   pnpm --filter @capiro/api diag:outreach-usage [--days 7]
 *
 * SAFE: aggregate reads only, no writes. Reads ai_usage_events directly (not
 * RLS-scoped) so it summarizes every tenant. Exits non-zero on error.
 */
import { PrismaClient } from '@prisma/client';

const OUTREACH_WORKFLOWS = [
  'outreach_campaign',
  'outreach_draft',
  'template_preview',
  'campaign_email',
];

const prisma = new PrismaClient();

function argDays(): number {
  const i = process.argv.indexOf('--days');
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 7;
}

async function main(): Promise<void> {
  const days = argDays();
  const since = new Date(Date.now() - days * 864e5);

  const rows = await prisma.aiUsageEvent.groupBy({
    by: ['tenantId', 'promptSpecVersion'],
    where: { workflow: { in: OUTREACH_WORKFLOWS }, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: true,
      costUsd: true,
    },
  });

  if (!rows.length) {
    // eslint-disable-next-line no-console
    console.log(`No outreach AI usage in the last ${days} day(s).`);
    return;
  }

  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  const slugOf = new Map(tenants.map((t) => [t.id, t.slug]));

  // eslint-disable-next-line no-console
  console.log(`Outreach AI usage — last ${days} day(s) (since ${since.toISOString()}):\n`);
  const byTenant = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTenant.get(r.tenantId) ?? [];
    list.push(r);
    byTenant.set(r.tenantId, list);
  }

  for (const [tenantId, list] of byTenant) {
    // eslint-disable-next-line no-console
    console.log(`■ ${slugOf.get(tenantId) ?? tenantId}`);
    for (const r of list) {
      const inp = r._sum.inputTokens ?? 0;
      const out = r._sum.outputTokens ?? 0;
      const cRead = r._sum.cacheReadTokens ?? 0;
      const cCreate = r._sum.cacheCreationTokens ?? 0;
      const promptTotal = inp + cRead + cCreate;
      const hitRate = promptTotal > 0 ? ((cRead / promptTotal) * 100).toFixed(1) : '0.0';
      const cost = Number(r._sum.costUsd ?? 0).toFixed(4);
      // eslint-disable-next-line no-console
      console.log(
        `   spec=${(r.promptSpecVersion ?? 'n/a').padEnd(4)} drafts=${String(r._count._all).padStart(5)}` +
          ` in=${inp} out=${out} cacheRead=${cRead} cacheWrite=${cCreate}` +
          ` cacheHit=${hitRate}% cost=$${cost}`,
      );
    }
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
