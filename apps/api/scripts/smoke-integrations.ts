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
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { EngagementProvider } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { GOOGLE_SCOPES } from '../src/engagement/google/google-oauth.service.js';
import { MICROSOFT_SCOPES } from '../src/engagement/microsoft/microsoft-oauth-constants.js';

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

  const logger = new Logger('smoke-integrations');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const prisma = app.get(PrismaService);
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
          // Selected ONLY to compute a presence boolean below -- the
          // ciphertext itself is never read again after that check, and this
          // script never calls TokenCryptoService.decrypt.
          token: { select: { expiresAt: true, refreshTokenCiphertext: true } },
        },
        orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
      }),
    );

    logger.log(
      `tenant ${tenant.slug} (${tenant.id}) -- ${connections.length} Google/Microsoft connection(s)`,
    );
    if (connections.length === 0) {
      logger.warn('No Google Workspace or Microsoft 365 connections found for this tenant.');
      return;
    }

    for (const conn of connections) {
      const canonical = canonicalScopesFor(conn.provider);
      const scopeMatch = scopesMatch(conn.scopes, canonical);
      const hasRefreshToken = Boolean(conn.token?.refreshTokenCiphertext);

      logger.log('');
      logger.log(`connection ${conn.id} [${conn.provider}]`);
      logger.log(`  status:          ${conn.status}`);
      logger.log(`  accountEmail:    ${conn.accountEmail ?? '(none)'}`);
      logger.log(`  lastSyncAt:      ${conn.lastSyncAt?.toISOString() ?? 'never'}`);
      logger.log(`  lastError:       ${conn.lastError ?? '(none)'}`);
      logger.log(`  scopes:          ${conn.scopes.join(' ') || '(none)'}`);
      logger.log(`  scopesMatch:     ${scopeMatch}`);
      logger.log(`  tokenExpiresAt:  ${conn.token?.expiresAt?.toISOString() ?? '(no token row)'}`);
      logger.log(`  hasRefreshToken: ${hasRefreshToken}`);

      if (conn.provider === EngagementProvider.microsoft_365) {
        const subscriptions = subscriptionsFrom(conn.syncState);
        if (subscriptions.length === 0) {
          logger.log('  subscriptions:   (none)');
        } else {
          for (const sub of subscriptions) {
            logger.log(
              `  subscription:    ${sub.id} [${sub.resource}] expires ${sub.expirationDateTime}`,
            );
          }
        }
      }
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('[smoke-integrations] fatal', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
