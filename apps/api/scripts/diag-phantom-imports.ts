/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only PHANTOM-IMPORT diagnosis.
 *
 * Answers: why do some LDA-imported clients (e.g. RADIANT NUCLEAR, THE PRIVATE
 * SUITE LAX, TERRAFLOW ENERGY) show an [Imported] flag in the firm wizard but NOT
 * appear in the Portfolio's "active clients" list? The Portfolio list filters
 * only `status != 'archived'`, and imported clients should default to
 * status='active' / profile_status='ACTIVE' / profile_type='CLIENT'. This verb
 * dumps the actual stored status fields for every client carrying lda_client_ids
 * so we can see whether (a) the rows exist with a non-active/non-CLIENT status
 * (real bug), or (b) they are active+visible and the UI was just cache-stale.
 *
 * SAFE: SELECT-only. No writes. RLS-bypass read (clients is FORCED-RLS; a raw
 * PrismaClient sees zero rows unless app.bypass_rls is set) — same trusted
 * cross-tenant admin path as PrismaService.withSystem.
 *
 * Run as a one-off ECS task (read-only):
 *   aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"api","command":["diag-phantom-imports"]}]}'
 *   # optional name filter: ["diag-phantom-imports","--name","RADIANT"]
 */
import { PrismaClient } from '@prisma/client';
import { parseArgs } from 'node:util';

const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v);

async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx as unknown as PrismaClient);
  });
}

interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  profile_status: string;
  profile_type: string | null;
  lda_client_ids: number[] | null;
  hidden_by_portfolio_filter: boolean;
  created_at: Date;
}

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/diag-phantom-imports.ts [--tenant UUID] [--name NAME] requires DATABASE_URL (database configuration is required)';
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  let args: { tenant?: string; name?: string };
  try {
    args = parseArgs({
      options: {
        tenant: { type: 'string' },
        name: { type: 'string' },
      },
    }).values;
  } catch {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }

  // args.tenant is interpolated into raw SQL (with a ::uuid cast); reject anything
  // that is not a well-formed UUID so the value cannot escape the literal context.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (args.tenant && !UUID_RE.test(args.tenant)) {
    console.error('[diag-phantom-imports] --tenant must be a valid UUID');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const report = await withBypass(prisma, async (tx) => {
      const tenantFilter = args.tenant ? `AND c.tenant_id = '${args.tenant}'::uuid` : '';
      const nameFilter = args.name
        ? `AND c.name ILIKE '%' || ${`'${String(args.name).replace(/'/g, "''")}'`} || '%'`
        : '';

      // Every client carrying an LDA id (i.e. imported/resolved) with its stored
      // status fields + whether the Portfolio list (status != 'archived') hides it.
      const rows = await tx.$queryRawUnsafe<ClientRow[]>(`
      SELECT c.id, c.tenant_id, c.name, c.status,
             c.profile_status, c.profile_type,
             c.lda_client_ids,
             (c.status = 'archived') AS hidden_by_portfolio_filter,
             c.created_at
      FROM clients c
      WHERE coalesce(array_length(c.lda_client_ids, 1), 0) > 0
        ${tenantFilter}
        ${nameFilter}
      ORDER BY c.tenant_id, c.created_at DESC
    `);

      // Per-tenant rollup: total clients, active+visible, and how many imported
      // rows are hidden by the portfolio filter.
      const rollup = await tx.$queryRawUnsafe<
        Array<{
          tenant_id: string;
          slug: string | null;
          total_clients: bigint;
          active_visible: bigint;
          with_lda_ids: bigint;
          lda_hidden: bigint;
        }>
      >(`
      SELECT t.id AS tenant_id, t.slug,
             count(c.*) AS total_clients,
             count(*) FILTER (WHERE c.status <> 'archived') AS active_visible,
             count(*) FILTER (WHERE coalesce(array_length(c.lda_client_ids,1),0) > 0) AS with_lda_ids,
             count(*) FILTER (WHERE coalesce(array_length(c.lda_client_ids,1),0) > 0 AND c.status = 'archived') AS lda_hidden
      FROM tenants t
      LEFT JOIN clients c ON c.tenant_id = t.id
      WHERE t.status = 'active' ${args.tenant ? `AND t.id = '${args.tenant}'::uuid` : ''}
      GROUP BY t.id, t.slug
      ORDER BY t.slug
    `);

      return {
        perTenant: rollup.map((r) => ({
          tenantId: r.tenant_id,
          slug: r.slug,
          totalClients: num(r.total_clients),
          activeVisible: num(r.active_visible),
          withLdaIds: num(r.with_lda_ids),
          ldaImportsHiddenByFilter: num(r.lda_hidden),
        })),
        ldaClients: rows.map((r) => ({
          clientId: r.id,
          tenantId: r.tenant_id,
          name: r.name,
          status: r.status,
          profileStatus: r.profile_status,
          profileType: r.profile_type,
          ldaClientIds: r.lda_client_ids,
          hiddenByPortfolioFilter: r.hidden_by_portfolio_filter,
          createdAt: r.created_at,
        })),
      };
    });

    // Single tagged JSON line so the log is easy to grep out of CloudWatch.
    console.log('PHANTOM_IMPORTS ' + JSON.stringify(report));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error('[diag-phantom-imports] FAILED', err);
    process.exit(1);
  });
}
