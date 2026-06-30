/**
 * Read-only OUTLOOK / Microsoft Graph sync health report.
 *
 * For every Microsoft integration connection (across ALL tenants — RLS is
 * bypassed via set_config('app.bypass_rls','on')), prints: account email,
 * tenant, status, lastError, lastSyncAt, a summary of syncState (calendar + mail
 * last stats + when each last advanced), and per-connection row counts
 * (meetings / mail threads / mail messages). Optional argv[2] = case-insensitive
 * substring filter on the account email (e.g. "sean", "justin", "capiro.ai").
 *
 * SAFE: SELECT-only. No writes.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const filter = (process.argv[2] ?? '').toLowerCase();

interface ConnRow {
  id: string;
  tenant_id: string;
  account_email: string | null;
  display_name: string | null;
  status: string;
  last_error: string | null;
  last_sync_at: Date | null;
  next_sync_at: Date | null;
  sync_state: unknown;
  created_at: Date;
  updated_at: Date;
}

async function countWhereConnection(tx: Prisma.TransactionClient, table: string, connId: string): Promise<string> {
  try {
    const rows = await tx.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*)::bigint AS c FROM "${table}" WHERE connection_id = $1::uuid`,
      connId,
    );
    return String(Number(rows?.[0]?.c ?? 0));
  } catch (e) {
    return `ERR(${e instanceof Error ? e.message.slice(0, 40) : 'x'})`;
  }
}

function stats(s: unknown): string {
  if (!s || typeof s !== 'object') return '-';
  const o = s as Record<string, number>;
  return `scanned=${o.scanned ?? '?'} matched=${o.matched ?? '?'} skipped=${o.skipped ?? '?'} hasMore=${o.hasMore ?? '?'}`;
}

async function main(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      const conns = await tx.$queryRawUnsafe<ConnRow[]>(`
        SELECT id, tenant_id, account_email, display_name, status::text AS status,
               last_error, last_sync_at, next_sync_at, sync_state_jsonb AS sync_state,
               created_at, updated_at
        FROM engagement_connections
        WHERE provider = 'microsoft'
        ORDER BY updated_at DESC
      `);

      console.log(`\n=== Outlook connections: ${conns.length} total${filter ? ` (filter="${filter}")` : ''} ===\n`);
      let shown = 0;
      for (const c of conns) {
        if (filter && !(c.account_email ?? '').toLowerCase().includes(filter)) continue;
        shown += 1;
        const ss = (c.sync_state && typeof c.sync_state === 'object' ? c.sync_state : {}) as Record<string, any>;
        const meetings = await countWhereConnection(tx, 'meetings', c.id);
        const threads = await countWhereConnection(tx, 'mail_threads', c.id);
        const messages = await countWhereConnection(tx, 'mail_messages', c.id);

        console.log(`• ${c.account_email ?? '(no email)'}  [tenant ${c.tenant_id}]`);
        console.log(`    status=${c.status}  lastSyncAt=${c.last_sync_at?.toISOString() ?? 'never'}  connectedAt=${c.created_at.toISOString()}`);
        console.log(`    lastError=${c.last_error ? JSON.stringify(c.last_error.slice(0, 220)) : 'null'}`);
        console.log(`    calendar: ${stats(ss.calendar?.lastStats)}  (updated ${ss.calendar?.updatedAt ?? '-'})`);
        console.log(`    mail:     ${stats(ss.mail?.lastStats)}  (updated ${ss.mail?.updatedAt ?? '-'})`);
        const folders = ss.mail?.folders && typeof ss.mail.folders === 'object' ? Object.keys(ss.mail.folders) : [];
        if (folders.length) console.log(`    mail folders: ${folders.join(', ')}`);
        console.log(`    webhooks: configured=${ss.webhooks?.configured ?? false} subs=${ss.webhooks?.subscriptions?.length ?? 0}`);
        console.log(`    rows: meetings=${meetings} mailThreads=${threads} mailMessages=${messages}`);
        console.log('');
      }
      if (filter) console.log(`(${shown} matched the filter)\n`);
    },
    { timeout: 120000 },
  );
}

main()
  .catch((e) => {
    console.error('diag-outlook-sync failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
