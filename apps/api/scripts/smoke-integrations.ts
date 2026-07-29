/**
 * Read-only production smoke check for Google/Microsoft engagement
 * integrations. Prints per-connection health WITHOUT ever decrypting or
 * printing any token material.
 *
 *   pnpm --filter @capiro/api smoke:integrations -- --tenant=<slug-or-uuid>
 *
 * Completion plan (2026-07-27) Phase H, h3. This is the automated half of the
 * live-verification checklist -- the connect / send-to-self / disconnect legs
 * (docs/runbooks/integration-smoke.md) are deliberately NOT automated here:
 * they mutate a real mailbox and a real OAuth grant, which this script must
 * never do.
 *
 * SAFETY
 * ------
 * - Strictly read-only: refuses to run at all if --write is passed, as a
 *   trip-wire against accidental copy-paste from a script that DOES mutate
 *   (e.g. reclaim-google-mail.ts's --commit).
 * - Never decrypts a token, never prints ciphertext/iv/authTag or anything
 *   derived from decrypting one. The only token fact surfaced is a BOOLEAN --
 *   whether a refresh token is present -- plus its expiresAt.
 * - All DB access is tenant-scoped via PrismaService.withTenant / withSystem
 *   (capiro_app bypasses Postgres RLS, so tenant scoping is mandatory -- never
 *   a bare prisma call).
 *
 * Requires DATABASE_URL (composed from DB_* secrets in the ECS one-off task).
 */
import 'dotenv/config';
import { EngagementProvider } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GOOGLE_SCOPES } from '../src/engagement/google/google-oauth.service.js';
import { MICROSOFT_SCOPES } from '../src/engagement/microsoft/microsoft-oauth-constants.js';
import {
  googleSyncStateFields,
  googleSyncStateProblems,
  integrationConnectionProblems,
  integrationInventoryProblems,
} from './lib/integration-smoke-state.js';

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

const TENANT_ARG = arg('tenant');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SubscriptionState {
  id: string;
  resource: string;
  expirationDateTime: string;
}

function canonicalScopesFor(provider: EngagementProvider): readonly string[] | null {
  if (provider === EngagementProvider.google_workspace) return GOOGLE_SCOPES;
  if (provider === EngagementProvider.microsoft_365) return MICROSOFT_SCOPES;
  return null;
}

function scopesMatch(actual: string[], canonical: readonly string[] | null): boolean | 'n/a' {
  if (!canonical) return 'n/a';
  const a = [...actual].sort();
  const b = [...canonical].sort();
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

interface MailRemovalCounts {
  activeMessages: number;
  removedMessages: number;
  activeThreads: number;
  allRemovedThreads: number;
}

/** Provider-neutral (Gmail and Outlook both write mail_messages/mail_threads),
 *  so this runs for every connection, not just Google. */
async function mailRemovalCounts(
  prisma: PrismaService,
  tenantId: string,
  connectionId: string,
): Promise<MailRemovalCounts> {
  return prisma.withTenant(tenantId, async (tx) => {
    const [activeMessages, removedMessages, activeThreads, allRemovedThreads] = await Promise.all([
      tx.mailMessage.count({ where: { tenantId, connectionId, removedAt: null } }),
      tx.mailMessage.count({ where: { tenantId, connectionId, removedAt: { not: null } } }),
      tx.mailThread.count({
        where: { tenantId, connectionId, messages: { some: { removedAt: null } } },
      }),
      tx.mailThread.count({
        where: {
          tenantId,
          connectionId,
          AND: [{ messages: { none: { removedAt: null } } }, { messages: { some: {} } }],
        },
      }),
    ]);
    return { activeMessages, removedMessages, activeThreads, allRemovedThreads };
  });
}

/** Microsoft's webhook subscription ids + expiries, read out of syncState.
 *  Google has no equivalent (no webhook subscriptions for Gmail/Calendar). */
function subscriptionsFrom(syncState: unknown): SubscriptionState[] {
  if (!syncState || typeof syncState !== 'object') return [];
  const webhooks = (syncState as { webhooks?: { subscriptions?: unknown } }).webhooks;
  const subs = webhooks?.subscriptions;
  if (!Array.isArray(subs)) return [];
  return subs.filter(
    (s): s is SubscriptionState =>
      Boolean(s) &&
      typeof s === 'object' &&
      typeof (s as Partial<SubscriptionState>).id === 'string' &&
      typeof (s as Partial<SubscriptionState>).resource === 'string' &&
      typeof (s as Partial<SubscriptionState>).expirationDateTime === 'string',
  );
}

async function resolveTenant(prisma: PrismaService): Promise<{ id: string; slug: string }> {
  const tenant = await prisma.withSystem((tx) =>
    tx.tenant.findFirst({
      where: UUID_RE.test(TENANT_ARG as string) ? { id: TENANT_ARG } : { slug: TENANT_ARG },
      select: { id: true, slug: true },
    }),
  );
  if (!tenant) throw new Error(`tenant not found: ${TENANT_ARG}`);
  return tenant;
}

async function main(): Promise<void> {
  // Trip-wire, checked before anything else runs (including before a DB
  // connection is opened): this script must never be the thing that mutates a
  // live connection. Fail loudly rather than silently ignoring the flag.
  if (flag('write')) {
    throw new Error('smoke-integrations is read-only; there is no --write mode');
  }
  if (!TENANT_ARG) {
    console.error('usage: smoke-integrations --tenant=<slug-or-uuid>');
    process.exit(2);
  }

  // This diagnostic depends only on PrismaService. Booting the entire Nest
  // application makes a read-only production check vulnerable to unrelated
  // module-construction failures and startup side effects. Match the established
  // one-off-script pattern: open exactly one Prisma client and close it in finally.
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const tenant = await resolveTenant(prisma);

    const connections = await prisma.withTenant(tenant.id, (tx) =>
      tx.integrationConnection.findMany({
        where: {
          tenantId: tenant.id,
          provider: { in: [EngagementProvider.google_workspace, EngagementProvider.microsoft_365] },
        },
        select: {
          id: true,
          provider: true,
          status: true,
          accountEmail: true,
          lastSyncAt: true,
          lastError: true,
          scopes: true,
          syncState: true,
          // Selected ONLY to prove the encrypted refresh-token envelope is
          // complete. No envelope value is printed, returned, or decrypted.
          token: {
            select: {
              expiresAt: true,
              refreshTokenCiphertext: true,
              refreshTokenIv: true,
              refreshTokenAuthTag: true,
            },
          },
        },
        orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
      }),
    );

    console.log(
      `tenant ${tenant.slug} (${tenant.id}) -- ${connections.length} Google/Microsoft connection(s)`,
    );
    const inventoryProblems = integrationInventoryProblems(connections.length);
    if (inventoryProblems.length > 0) {
      for (const problem of inventoryProblems) console.error(`FAILED: ${problem}.`);
      process.exitCode = 1;
      return;
    }

    let problemCount = 0;
    for (const conn of connections) {
      const canonical = canonicalScopesFor(conn.provider);
      const scopeMatch = scopesMatch(conn.scopes, canonical);
      const hasRefreshToken = Boolean(
        conn.token?.refreshTokenCiphertext &&
          conn.token?.refreshTokenIv &&
          conn.token?.refreshTokenAuthTag,
      );
      const connectionProblems = integrationConnectionProblems({
        status: conn.status,
        scopeMatch,
        hasRefreshToken,
        lastSyncAtPresent: Boolean(conn.lastSyncAt),
        lastError: conn.lastError,
      });

      console.log('');
      console.log(`connection ${conn.id} [${conn.provider}]`);
      console.log(`  status:          ${conn.status}`);
      console.log(`  accountEmail:    ${conn.accountEmail ?? '(none)'}`);
      console.log(`  lastSyncAt:      ${conn.lastSyncAt?.toISOString() ?? 'never'}`);
      console.log(`  lastError:       ${conn.lastError ?? '(none)'}`);
      console.log(`  scopes:          ${conn.scopes.join(' ') || '(none)'}`);
      console.log(`  scopesMatch:     ${scopeMatch}`);
      console.log(`  tokenExpiresAt:  ${conn.token?.expiresAt?.toISOString() ?? '(no token row)'}`);
      console.log(`  hasRefreshToken: ${hasRefreshToken}`);

      if (conn.provider === EngagementProvider.microsoft_365) {
        const subscriptions = subscriptionsFrom(conn.syncState);
        if (subscriptions.length === 0) {
          console.log('  subscriptions:   (none)');
        } else {
          for (const sub of subscriptions) {
            console.log(
              `  subscription:    ${sub.id} [${sub.resource}] expires ${sub.expirationDateTime}`,
            );
          }
        }
      }

      if (conn.provider === EngagementProvider.google_workspace) {
        const sync = googleSyncStateFields(conn.syncState);
        console.log(`  mail.historyId:                 ${sync.mailHistoryId ?? '(none)'}`);
        console.log(`  mail.incrementalPageToken:      ${sync.mailIncrementalPageToken ?? '(none)'}`);
        console.log(`  mail.incrementalLatestHistoryId:${sync.mailIncrementalLatestHistoryId ?? ' (none)'}`);
        console.log(`  mail.labels.ALL.backfillPageToken: ${sync.mailBackfillPageToken ?? '(none)'}`);
        console.log(`  mail.labels.ALL.backfillQuery:     ${sync.mailBackfillQuery ?? '(none)'}`);
        console.log(`  mail.labels.ALL.backfillDone:      ${sync.mailBackfillDone ?? '(unknown)'}`);
        console.log(`  calendar.syncTokenPresent:      ${sync.calendarSyncTokenPresent}`);
        console.log(`  calendar.pageToken:             ${sync.calendarPageToken ?? '(none)'}`);
        console.log(`  calendar.continuationMode:      ${sync.calendarContinuationMode}`);
        console.log(
          `  calendar.window:                ${sync.calendarWindow ? `${sync.calendarWindow.from} .. ${sync.calendarWindow.to}` : '(none)'}`,
        );
        connectionProblems.push(...googleSyncStateProblems(sync));
      }

      const removal = await mailRemovalCounts(prisma, tenant.id, conn.id);
      console.log(
        `  mail (active/removed):  ${removal.activeMessages}/${removal.removedMessages}`,
      );
      console.log(
        `  threads (active/all-removed): ${removal.activeThreads}/${removal.allRemovedThreads}`,
      );

      if (connectionProblems.length === 0) {
        console.log('  health:           healthy');
      } else {
        problemCount += connectionProblems.length;
        for (const problem of connectionProblems) console.error(`  ERROR: ${problem}`);
      }
    }

    if (problemCount > 0) {
      console.error(`\nFAILED: ${problemCount} integration health problem(s) found.`);
      process.exitCode = 1;
    } else {
      console.log('\nPASS: all integration connections satisfy the read-only health checks.');
    }
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((err: unknown) => {
  console.error('[smoke-integrations] fatal', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
