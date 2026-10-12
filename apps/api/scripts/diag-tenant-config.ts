/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only TENANT/CLIENT CONFIG EXPORT. Dumps everything a tenant (and its
 * clients) has configured — a record snapshot. Resolves the search term against
 * tenant name/slug, client name, AND member email domain. Always prints an
 * all-tenants summary as a fallback for eyeballing.
 *
 *   diag-tenant-config "c2 strategies"
 *
 * tenants/clients are RLS-protected, so this runs inside a transaction with
 * app.bypass_rls='on' (mirrors PrismaService.withSystem). SELECT-only — no
 * writes. Member emails are included (own-tenant config record); OAuth token
 * tables are intentionally NOT dumped.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const num = (_k: string, v: unknown) => (typeof v === 'bigint' ? Number(v) : v);

const CHILD_TABLES = [
  'client_capabilities',
  'client_people',
  'client_facilities',
  'client_intel_mapping',
  'client_association_overrides',
  'client_submission_history',
  // Engagement activity: status fields here diagnose "sent outreach not
  // showing as sent" class issues (type/status/sent_at vs created_at).
  'outreach_records',
  'engagement_campaigns',
];

async function run(tx: Prisma.TransactionClient): Promise<void> {
  const q = <T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> =>
    tx.$queryRawUnsafe<T[]>(sql, ...params);

  const term = (process.argv.slice(2).join(' ') || 'c2 strategies').trim();
  const like = `%${term}%`;
  const likeNoSpace = `%${term.replace(/\s+/g, '')}%`;

  // Always: an all-tenants summary for eyeballing (small).
  const allTenants = await q(
    `SELECT t.id, t.name, t.slug, t.status, t.plan_tier, t.account_type, t.clerk_org_id, t.created_at,
            (SELECT count(*)::int FROM clients c WHERE c.tenant_id = t.id) AS client_count,
            (SELECT count(*)::int FROM tenant_memberships m WHERE m.tenant_id = t.id) AS member_count
       FROM tenants t ORDER BY t.created_at`,
  );
  console.log('TC_ALL_TENANTS ' + JSON.stringify({ count: allTenants.length, tenants: allTenants }, num, 2));

  const byNameSlug = await q<{ id: string }>(
    `SELECT id FROM tenants WHERE name ILIKE $1 OR slug ILIKE $1 OR slug ILIKE $2`, like, likeNoSpace);
  const byEmail = await q<{ tenant_id: string }>(
    `SELECT DISTINCT m.tenant_id FROM tenant_memberships m JOIN users u ON u.id = m.user_id
      WHERE u.email ILIKE $1 OR u.email ILIKE $2`, likeNoSpace, like);
  const byClient = await q<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM clients WHERE name ILIKE $1`, like);

  const tenantIds = Array.from(new Set([
    ...byNameSlug.map((r) => String(r.id)),
    ...byEmail.map((r) => String(r.tenant_id)),
    ...byClient.map((r) => String(r.tenant_id)),
  ]));
  console.log('TC_RESOLVED ' + JSON.stringify({ term, byNameSlug: byNameSlug.length, byEmail: byEmail.length, byClient: byClient.length, tenantIds }, num, 2));

  if (tenantIds.length === 0) {
    console.log('TC_DONE ' + JSON.stringify({ matched: 0, note: 'no match — pick from TC_ALL_TENANTS and re-run with that name' }, num, 2));
    return;
  }

  const tenants = await q(`SELECT * FROM tenants WHERE id::text = ANY($1::text[]) ORDER BY created_at`, tenantIds);
  for (const t of tenants) {
    const tid = String((t as { id: string }).id);
    const members = await q(
      `SELECT m.role, m.status, m.joined_at, u.email, u.first_name, u.last_name, u.title, u.last_seen_at
         FROM tenant_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id::text = $1 ORDER BY m.role`, tid);
    console.log(`TC_TENANT ${(t as { name: string }).name} ` + JSON.stringify({ tenant: t, members }, num, 2));
  }

  const clients = await q(
    `SELECT * FROM clients WHERE tenant_id::text = ANY($1::text[]) OR name ILIKE $2 ORDER BY created_at`, tenantIds, like);
  console.log('TC_CLIENTS_SUMMARY ' + JSON.stringify({ matched: clients.length, names: clients.map((c) => (c as { name: string }).name) }, num, 2));

  for (const c of clients) {
    const id = String((c as { id: string }).id);
    const block: Record<string, unknown> = { client: c };
    for (const tbl of CHILD_TABLES) {
      try {
        block[tbl] = await q(`SELECT * FROM ${tbl} WHERE client_id::text = $1`, id);
      } catch (e) {
        block[tbl] = `ERR:${e instanceof Error ? e.message.slice(0, 120) : 'x'}`;
      }
    }
    console.log(`TC_CLIENT ${(c as { name: string }).name} ` + JSON.stringify(block, num, 2));
  }

  console.log('TC_DONE ' + JSON.stringify({ tenants: tenants.length, clients: clients.length }, num, 2));
}

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/diag-tenant-config.ts [search-term ...] requires DATABASE_URL (database configuration is required)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (args.some((arg) => arg.startsWith('--'))) {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    // tenants/clients are RLS-protected — mirror PrismaService.withSystem().
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await run(tx);
      },
      { timeout: 120_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error('TC_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
