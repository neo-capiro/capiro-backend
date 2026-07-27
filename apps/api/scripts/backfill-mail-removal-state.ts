/**
 * Idempotent historical repair for mail_threads whose snippet/lastMessageAt
 * predate the removed_at/removed_reason columns (remaining-items plan §3.d8).
 *
 *   pnpm --filter @capiro/api backfill:mail-removal-state -- --tenant=<slug-or-uuid>            # DRY RUN
 *   pnpm --filter @capiro/api backfill:mail-removal-state -- --tenant=<slug-or-uuid> --commit
 *   pnpm --filter @capiro/api backfill:mail-removal-state -- --all-tenants --commit
 *
 * The 20260727170000_mail_message_removal_state migration backfills removed_at
 * / removed_reason on historical rows from their old metadata.googleRemoved /
 * .graphRemoved markers, but does NOT recompute the owning mail_thread's
 * snippet / lastMessageAt / metadata.deleted — those are only ever set going
 * forward, by markMailMessageRemovedInTx (live provider removals) and normal
 * upsert (restores). This script closes that gap for threads that already had
 * a removed message before that migration ran.
 *
 * DRY RUN (default) enumerates affected threads and prints counts; it never
 * writes and makes no provider calls. --commit runs
 * recomputeMailThreadSummaryInTx per affected thread, in deterministic
 * thread-id order, each in its own short transaction. Idempotent: a second
 * run recomputes the same rows to the same result and changes nothing
 * further. Manual client associations, participants, and association fields
 * are untouched — recomputeMailThreadSummaryInTx only ever writes snippet,
 * lastMessageAt, subject (when non-empty), and metadata.deleted.
 *
 * Requires DATABASE_URL. All DB access is tenant-scoped via PrismaService
 * (RLS-safe); withSystem is used ONLY to enumerate tenants for --all-tenants.
 *
 * Deliberately uses PrismaService directly rather than
 * NestFactory.createApplicationContext(AppModule): this script's only
 * dependency is PrismaService (recomputeMailThreadSummaryInTx is a plain
 * exported function, not an injectable service), matching the established
 * pattern in backfill-google-meeting-virtuality.ts for scripts with no other
 * DI dependency. Booting the full AppModule would also currently crash before
 * reaching main() — InsightGeneratorService's ConfigService injection is
 * broken by an unrelated 2026-07-27 Intelligence-subsystem change that
 * affects every tsx one-off script going through createApplicationContext.
 */
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { recomputeMailThreadSummaryInTx } from '../src/engagement/mail-message-state.js';

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
const ALL_TENANTS = flag('all-tenants');
const TENANT_ARG = arg('tenant');
const SLEEP_EVERY = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TenantRow {
  id: string;
  slug: string;
}

/** Tenants are cross-tenant rows; enumerate via the bypass-RLS system path. */
async function resolveTenants(prisma: PrismaService): Promise<TenantRow[]> {
  return prisma.withSystem(async (tx) => {
    if (ALL_TENANTS) {
      return tx.tenant.findMany({
        where: { status: 'active' },
        orderBy: { slug: 'asc' },
        select: { id: true, slug: true },
      });
    }
    const tenant = await tx.tenant.findFirst({
      where: UUID_RE.test(TENANT_ARG as string) ? { id: TENANT_ARG } : { slug: TENANT_ARG },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new Error(`tenant not found: ${TENANT_ARG}`);
    return [tenant];
  });
}

async function main(): Promise<void> {
  if ((!TENANT_ARG && !ALL_TENANTS) || (TENANT_ARG && ALL_TENANTS)) {
    console.error(
      'usage: backfill-mail-removal-state --tenant=<slug-or-uuid> [--commit]\n' +
        '       backfill-mail-removal-state --all-tenants [--commit]\n' +
        'DRY RUN by default; --commit recomputes thread snippet/lastMessageAt/metadata.deleted.',
    );
    process.exit(2);
  }

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const tenants = await resolveTenants(prisma);
    console.log(
      `${COMMIT ? 'COMMIT' : 'DRY RUN'}: mail-removal-state thread-summary repair over ${tenants.length} tenant(s)\n`,
    );

    const totals = {
      removedMessages: 0,
      affectedThreads: 0,
      allRemovedThreads: 0,
      partiallyRemovedThreads: 0,
      repaired: 0,
      failed: 0,
    };

    for (const tenant of tenants) {
      const removedMessages = await prisma.withTenant(tenant.id, (tx) =>
        tx.mailMessage.count({ where: { tenantId: tenant.id, removedAt: { not: null } } }),
      );

      // Deterministic thread-id order — repeated runs process rows identically.
      const affected = await prisma.withTenant(tenant.id, (tx) =>
        tx.mailThread.findMany({
          where: { tenantId: tenant.id, messages: { some: { removedAt: { not: null } } } },
          select: { id: true, messages: { select: { removedAt: true } } },
          orderBy: { id: 'asc' },
        }),
      );

      let allRemoved = 0;
      let partiallyRemoved = 0;
      for (const thread of affected) {
        if (thread.messages.every((m) => m.removedAt !== null)) allRemoved += 1;
        else partiallyRemoved += 1;
      }

      totals.removedMessages += removedMessages;
      totals.affectedThreads += affected.length;
      totals.allRemovedThreads += allRemoved;
      totals.partiallyRemovedThreads += partiallyRemoved;

      console.log(
        `tenant ${tenant.slug} (${tenant.id}): removedMessages=${removedMessages} ` +
          `affectedThreads=${affected.length} allRemoved=${allRemoved} partiallyRemoved=${partiallyRemoved}`,
      );

      if (!COMMIT) continue;

      let repaired = 0;
      for (const thread of affected) {
        try {
          await prisma.withTenant(tenant.id, (tx) =>
            recomputeMailThreadSummaryInTx(tx, tenant.id, thread.id),
          );
          repaired += 1;
          totals.repaired += 1;
          if (repaired % SLEEP_EVERY === 0) await sleep(50);
        } catch (err) {
          totals.failed += 1;
          console.error(
            `  FAILED recompute ${thread.id} [${tenant.slug}]: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      console.log(`  ${tenant.slug}: repaired=${repaired}/${affected.length}`);
    }

    console.log(
      `\n${COMMIT ? 'COMMIT' : 'DRY RUN'} done: removedMessages=${totals.removedMessages} ` +
        `affectedThreads=${totals.affectedThreads} allRemoved=${totals.allRemovedThreads} ` +
        `partiallyRemoved=${totals.partiallyRemovedThreads}` +
        (COMMIT ? ` repaired=${totals.repaired}` : '') +
        ` failed=${totals.failed}`,
    );
    if (totals.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((err: unknown) => {
  console.error(
    '[backfill-mail-removal-state] fatal',
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
