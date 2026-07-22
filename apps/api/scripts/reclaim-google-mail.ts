/**
 * Retroactive Gmail RE-ASSOCIATION reclaim for a tenant's Google connection(s).
 *
 *   pnpm --filter @capiro/api reclaim:google-mail -- --tenant=<slug-or-uuid>                       # DRY RUN
 *   pnpm --filter @capiro/api reclaim:google-mail -- --tenant=<slug-or-uuid> --commit
 *   pnpm --filter @capiro/api reclaim:google-mail -- --tenant=<slug-or-uuid> --connection=<uuid> --commit
 *
 * WHY THIS EXISTS
 * ---------------
 * When a Gmail message associates to no client at sync time, the live sync DROPS
 * it: persistGmailMessage returns 'skipped' before any mailThread/mailMessage row
 * is written and the raw payload is persisted NOWHERE (google-sync.service.ts, the
 * `if (!clientId && !existingThread) return 'skipped'` branch). So once a client's
 * domain / contact is added LATER, the previously-skipped mail cannot be recovered
 * from stored rows — there are none. The ONLY way to reclaim it is to RE-FETCH the
 * mailbox from Gmail so association runs again against the current client set.
 *
 * This script does exactly that WITHOUT editing the change-controlled sync service:
 * it calls the existing GoogleSyncService.syncConnectionByTenant() entrypoint with
 * { mail: true, calendar: false, reset: true } ONCE (which wipes the mail cursor and
 * re-fetches from Gmail, re-running association per message), then calls it again
 * WITHOUT reset to RESUME the backfill via the stored backfillPageToken until the
 * window is exhausted (hasMore === false). Repeating reset would restart at page 1
 * forever, so reset is used exactly once and only the first call.
 *
 * HARD CEILING: the backfill window is MAIL_BACKFILL_DAYS (365) in the sync service.
 * Mail older than ~365 days is NOT re-fetched and is UNRECOVERABLE by this script.
 *
 * SAFETY
 * ------
 * - DRY RUN (default) writes NOTHING and calls NO sync: it only enumerates the target
 *   connections and prints their current mail counts + lastSyncAt so you can see what
 *   a --commit would re-fetch.
 * - --commit runs the reset+resume loop and reports before/after mail_message and
 *   mail_thread counts per connection (the real proof that skipped mail reappeared).
 * - All DB access is tenant-scoped via PrismaService.withTenant / withSystem
 *   (capiro_app bypasses Postgres RLS, so tenant scoping is mandatory — never a bare
 *   prisma call). Manual client associations are preserved by the sync path.
 * - Run OFF-PEAK. A reset re-fetch takes the per-tenant engagement-sync advisory lock
 *   on every message upsert; it will interleave with (not freeze) any concurrent
 *   scheduled sync for the same tenant.
 *
 * Requires DATABASE_URL (composed from DB_* secrets in the ECS one-off task).
 */
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GoogleSyncService } from '../src/engagement/google/google-sync.service.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Read `--name value` or `--name=value`. */
function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : undefined;
}

const COMMIT = flag('commit');
const TENANT_ARG = arg('tenant');
const CONNECTION_ARG = arg('connection');

// Each backfill run fetches up to ~1200 messages (MAX_MAIL_PAGES_PER_LABEL_PER_RUN
// x GMAIL_PAGE_SIZE). Cap the resume loop generously so a runaway can't spin: 300
// iterations ~= 360k messages, far beyond any real 365-day mailbox.
const MAX_RESUME_ITERATIONS = 300;
const SLEEP_BETWEEN_RUNS_MS = 250;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The mail cursor scope key the sync service uses for the whole-mailbox backfill.
const MAIL_SCOPE = 'ALL';

interface TenantRow {
  id: string;
  slug: string;
}

interface ConnRow {
  id: string;
  accountEmail: string | null;
  status: string;
  lastSyncAt: Date | null;
}

interface MailCounts {
  messages: number;
  threads: number;
}

/** Sum matched/skipped/scanned and detect hasMore across every mail scope in a result. */
function summarizeMail(result: { mail?: Record<string, { scanned: number; matched: number; skipped: number; hasMore: boolean }> }): {
  scanned: number;
  matched: number;
  skipped: number;
  hasMore: boolean;
} {
  const scopes = Object.values(result.mail ?? {});
  return {
    scanned: scopes.reduce((n, s) => n + (s?.scanned ?? 0), 0),
    matched: scopes.reduce((n, s) => n + (s?.matched ?? 0), 0),
    skipped: scopes.reduce((n, s) => n + (s?.skipped ?? 0), 0),
    hasMore: scopes.some((s) => Boolean(s?.hasMore)),
  };
}

async function resolveTenant(prisma: PrismaService): Promise<TenantRow> {
  const tenant = await prisma.withSystem((tx) =>
    tx.tenant.findFirst({
      where: UUID_RE.test(TENANT_ARG as string) ? { id: TENANT_ARG } : { slug: TENANT_ARG },
      select: { id: true, slug: true },
    }),
  );
  if (!tenant) throw new Error(`tenant not found: ${TENANT_ARG}`);
  return tenant;
}

/** Syncable Google connections for the tenant (those with a usable token). */
async function resolveConnections(prisma: PrismaService, tenantId: string): Promise<ConnRow[]> {
  return prisma.withTenant(tenantId, (tx) =>
    tx.integrationConnection.findMany({
      where: {
        tenantId,
        provider: 'google_workspace',
        // connected / error carry a stored token and are what the scheduler drives;
        // needs_configuration / disabled have no usable token to re-fetch with.
        status: { in: ['connected', 'error'] },
        ...(CONNECTION_ARG ? { id: CONNECTION_ARG } : {}),
      },
      select: { id: true, accountEmail: true, status: true, lastSyncAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

async function mailCounts(prisma: PrismaService, tenantId: string, connectionId: string): Promise<MailCounts> {
  return prisma.withTenant(tenantId, async (tx) => {
    const [messages, threads] = await Promise.all([
      tx.mailMessage.count({ where: { tenantId, connectionId } }),
      tx.mailThread.count({ where: { tenantId, connectionId } }),
    ]);
    return { messages, threads };
  });
}

/**
 * Reset + resume the Gmail backfill for one connection until the 365-day window is
 * exhausted. reset is passed ONLY on the first call; every resume call omits it so
 * the sync service continues from its stored backfillPageToken.
 */
async function reclaimConnection(
  google: GoogleSyncService,
  tenantId: string,
  connectionId: string,
  logger: Logger,
): Promise<{ runs: number; scanned: number; matched: number; skipped: number }> {
  const totals = { runs: 0, scanned: 0, matched: 0, skipped: 0 };
  for (let i = 0; i < MAX_RESUME_ITERATIONS; i += 1) {
    const reset = i === 0;
    const result = await google.syncConnectionByTenant(tenantId, connectionId, {
      mail: true,
      calendar: false,
      reset,
    });
    const s = summarizeMail(result);
    totals.runs += 1;
    totals.scanned += s.scanned;
    totals.matched += s.matched;
    totals.skipped += s.skipped;
    logger.log(
      `  run ${i + 1}${reset ? ' (reset)' : ' (resume)'} [${connectionId}]: ` +
        `scanned=${s.scanned} matched=${s.matched} skipped=${s.skipped} hasMore=${s.hasMore}`,
    );
    if (!s.hasMore) return totals;
    await sleep(SLEEP_BETWEEN_RUNS_MS);
  }
  logger.warn(
    `  [${connectionId}] hit MAX_RESUME_ITERATIONS=${MAX_RESUME_ITERATIONS} before hasMore cleared; ` +
      `re-run to continue the backfill from where it stopped.`,
  );
  return totals;
}

async function main(): Promise<void> {
  if (!TENANT_ARG) {
    console.error(
      'usage: reclaim-google-mail --tenant=<slug-or-uuid> [--connection=<uuid>] [--commit]\n' +
        'DRY RUN by default (enumerates connections, no sync); --commit runs the reset+resume re-fetch.',
    );
    process.exit(2);
  }

  const logger = new Logger('reclaim-google-mail');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const prisma = app.get(PrismaService);
    const google = app.get(GoogleSyncService);

    const tenant = await resolveTenant(prisma);
    const connections = await resolveConnections(prisma, tenant.id);

    logger.log(
      `${COMMIT ? 'COMMIT' : 'DRY RUN'}: google mail reclaim for tenant ${tenant.slug} (${tenant.id}) — ` +
        `${connections.length} syncable connection(s)` +
        (CONNECTION_ARG ? ` [filtered to ${CONNECTION_ARG}]` : ''),
    );
    if (connections.length === 0) {
      logger.warn(
        'No connected/error google_workspace connections matched. (needs_configuration / disabled ' +
          'connections have no usable token and cannot be re-fetched.)',
      );
      return;
    }

    let failed = 0;
    for (const conn of connections) {
      const before = await mailCounts(prisma, tenant.id, conn.id);
      logger.log(
        `\nconnection ${conn.accountEmail ?? '(no email)'} [${conn.id}] status=${conn.status} ` +
          `lastSyncAt=${conn.lastSyncAt?.toISOString() ?? 'never'} ` +
          `currentMessages=${before.messages} currentThreads=${before.threads}`,
      );

      if (!COMMIT) {
        logger.log(
          '  DRY RUN — would reset+resume re-fetch the trailing 365-day Gmail window and re-run ' +
            'association. Pass --commit to execute. (Mail older than 365 days is unrecoverable.)',
        );
        continue;
      }

      try {
        const totals = await reclaimConnection(google, tenant.id, conn.id, logger);
        const after = await mailCounts(prisma, tenant.id, conn.id);
        logger.log(
          `  DONE [${conn.id}]: runs=${totals.runs} scanned=${totals.scanned} matched=${totals.matched} ` +
            `skipped=${totals.skipped} | messages ${before.messages}->${after.messages} ` +
            `(+${after.messages - before.messages}) threads ${before.threads}->${after.threads} ` +
            `(+${after.threads - before.threads})`,
        );
      } catch (err) {
        failed += 1;
        logger.error(
          `  FAILED reclaim [${conn.id}]: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
        );
      }
    }

    logger.log(`\n${COMMIT ? 'COMMIT' : 'DRY RUN'} done: connections=${connections.length} failed=${failed}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(
    '[reclaim-google-mail] fatal',
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
