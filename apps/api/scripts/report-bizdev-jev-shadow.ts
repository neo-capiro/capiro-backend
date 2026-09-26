/**
 * Read-only Business Development Phase 3 Jev shadow report.
 *
 * Prints aggregate operational telemetry only. It deliberately does not read
 * prompts, passages, source identifiers, subjects, prospects, people, or firm
 * configuration. The decision table itself contains no prompt/source text.
 *
 * Usage:
 *   tsx scripts/report-bizdev-jev-shadow.ts \
 *     --slug capiro-internal --since 2026-09-25T00:00:00Z
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const prefix = `--${name}`;
  const index = process.argv.indexOf(prefix);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`${prefix}=`));
  return inline?.slice(prefix.length + 1);
}

type SummaryRow = {
  task: string;
  mode: string;
  total: bigint;
  completed: bigint;
  failed: bigint;
  skipped: bigint;
  agreements: bigint;
  disagreements: bigint;
  reviewed: bigint;
  unreviewed: bigint;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  input_tokens: bigint;
  output_tokens: bigint;
  estimated_cost_usd: string;
};

type BreakdownRow = {
  task: string;
  category: string;
  value: string;
  count: bigint;
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? Number(item) : item, 2);
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const sinceRaw = arg('since');
  if (!slug || !sinceRaw) {
    throw new Error('Usage: --slug <tenant-slug> --since <ISO-8601 timestamp>');
  }
  const since = new Date(sinceRaw);
  if (!Number.isFinite(since.getTime())) throw new Error(`Invalid --since timestamp: ${sinceRaw}`);

  const report = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const tenant = await tx.tenant.findFirst({ where: { slug }, select: { id: true, slug: true } });
    if (!tenant) throw new Error(`No tenant with slug "${slug}"`);

    const summary = await tx.$queryRaw<SummaryRow[]>`
      SELECT
        task,
        mode,
        count(*)::bigint AS total,
        count(*) FILTER (WHERE status = 'completed')::bigint AS completed,
        count(*) FILTER (WHERE status = 'failed')::bigint AS failed,
        count(*) FILTER (WHERE status = 'skipped')::bigint AS skipped,
        count(*) FILTER (
          WHERE status = 'completed'
            AND outcome IS NOT NULL
            AND deterministic_outcome IS NOT NULL
            AND outcome = deterministic_outcome
        )::bigint AS agreements,
        count(*) FILTER (
          WHERE status = 'completed'
            AND outcome IS NOT NULL
            AND deterministic_outcome IS NOT NULL
            AND outcome <> deterministic_outcome
        )::bigint AS disagreements,
        count(*) FILTER (WHERE review_status <> 'unreviewed')::bigint AS reviewed,
        count(*) FILTER (WHERE review_status = 'unreviewed')::bigint AS unreviewed,
        percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms IS NOT NULL) AS p50_latency_ms,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms IS NOT NULL) AS p95_latency_ms,
        coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
        coalesce(sum(estimated_cost_usd), 0)::text AS estimated_cost_usd
      FROM business_development_jev_decisions
      WHERE tenant_id = ${tenant.id}::uuid
        AND requested_at >= ${since}
      GROUP BY task, mode
      ORDER BY task, mode
    `;

    const breakdown = await tx.$queryRaw<BreakdownRow[]>`
      SELECT task, 'status'::text AS category, status::text AS value, count(*)::bigint AS count
      FROM business_development_jev_decisions
      WHERE tenant_id = ${tenant.id}::uuid AND requested_at >= ${since}
      GROUP BY task, status
      UNION ALL
      SELECT task, 'operational_state'::text, coalesce(operational_state, 'none')::text, count(*)::bigint
      FROM business_development_jev_decisions
      WHERE tenant_id = ${tenant.id}::uuid AND requested_at >= ${since}
      GROUP BY task, operational_state
      UNION ALL
      SELECT task, 'outcome'::text, coalesce(outcome, 'none')::text, count(*)::bigint
      FROM business_development_jev_decisions
      WHERE tenant_id = ${tenant.id}::uuid AND requested_at >= ${since}
      GROUP BY task, outcome
      ORDER BY task, category, value
    `;

    return {
      tenant: { id: tenant.id, slug: tenant.slug },
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
      summary,
      breakdown,
      semantics: {
        agreement: 'typed Jev outcome equals the stored Phase 2 deterministic outcome; not human accuracy',
        reviewed: 'review_status is accepted, corrected, or rejected',
      },
    };
  });

  // Aggregate operational data only; no source, subject or private tenant fields.
  // eslint-disable-next-line no-console
  console.log(json(report));
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
