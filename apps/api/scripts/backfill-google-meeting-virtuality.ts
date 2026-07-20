/**
 * Backfill meeting virtuality for EXISTING Google-synced meetings.
 *
 *   pnpm --filter @capiro/api backfill:google-meeting-virtuality -- --tenant=<slug-or-uuid>            # DRY RUN
 *   pnpm --filter @capiro/api backfill:google-meeting-virtuality -- --tenant=<slug-or-uuid> --commit
 *   pnpm --filter @capiro/api backfill:google-meeting-virtuality -- --all-tenants --commit
 *
 * Before the forward fix (google-sync.service.ts googleEventVirtuality), the
 * Google calendar sync wrote every meeting with isVirtual=false/joinLink=null/
 * provider=null, so the Send Meri button could never appear. The full Google
 * event is preserved in meeting.raw, so we can re-derive virtuality WITHOUT a
 * re-sync by feeding raw back through the SAME classifier the live sync uses
 * (googleEventVirtuality) — importing it directly means this backfill can never
 * drift from the live path.
 *
 * DRY RUN (default) counts how many rows WOULD flip to virtual and prints a few
 * samples; it never writes. --commit updates isVirtual/joinLink/provider for the
 * rows that re-derive as virtual. Idempotent: a second run flips nothing new.
 * Only rows currently isVirtual=false are considered, and only those that derive
 * to isVirtual=true are written — genuinely in-person meetings stay untouched.
 *
 * Requires DATABASE_URL. All DB access is tenant-scoped via PrismaService
 * (RLS-safe). Per-row updates run in their own short transactions, so there is
 * no bulk-transaction 5s-timeout risk.
 */
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngagementSource } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { googleEventVirtuality } from '../src/engagement/google/google-sync.service.js';

type GoogleEvent = Parameters<typeof googleEventVirtuality>[0];

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
const SAMPLE_LIMIT = 5;
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

/** Redact a URL to scheme+host (no path/query) so logs never leak join tokens. */
function scrubUrl(url: string | null): string {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(unparseable)';
  }
}

async function main(): Promise<void> {
  if ((!TENANT_ARG && !ALL_TENANTS) || (TENANT_ARG && ALL_TENANTS)) {
    console.error(
      'usage: backfill-google-meeting-virtuality --tenant=<slug-or-uuid> [--commit]\n' +
        '       backfill-google-meeting-virtuality --all-tenants [--commit]\n' +
        'DRY RUN by default; --commit writes isVirtual/joinLink/provider.',
    );
    process.exit(2);
  }

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const tenants = await resolveTenants(prisma);
    console.log(
      `${COMMIT ? 'COMMIT' : 'DRY RUN'}: google meeting-virtuality backfill over ${tenants.length} tenant(s)\n`,
    );

    const totals = { scanned: 0, wouldFlip: 0, flipped: 0, failed: 0 };

    for (const tenant of tenants) {
      // Only rows the bug left misclassified: Google-sourced, currently non-virtual.
      const candidates = await prisma.withTenant(tenant.id, (tx) =>
        tx.meeting.findMany({
          where: { source: EngagementSource.google, isVirtual: false },
          select: { id: true, raw: true, subject: true },
        }),
      );
      totals.scanned += candidates.length;

      let tenantFlips = 0;
      let sampled = 0;
      for (const row of candidates) {
        let virtuality;
        try {
          virtuality = googleEventVirtuality((row.raw ?? {}) as unknown as GoogleEvent);
        } catch (err) {
          totals.failed += 1;
          console.error(`  FAILED derive ${row.id}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        // Only touch rows that become virtual; leave genuine in-person meetings.
        if (!virtuality.isVirtual) continue;
        tenantFlips += 1;
        totals.wouldFlip += 1;

        if (sampled < SAMPLE_LIMIT) {
          sampled += 1;
          console.log(
            `  ${COMMIT ? 'flip' : 'would flip'} ${row.id} [${tenant.slug}] ` +
              `provider=${virtuality.provider ?? '(virtual, no link)'} ` +
              `join=${scrubUrl(virtuality.joinLink)} — ${(row.subject ?? '').slice(0, 60)}`,
          );
        }

        if (COMMIT) {
          try {
            await prisma.withTenant(tenant.id, (tx) =>
              tx.meeting.update({
                where: { id: row.id },
                data: {
                  isVirtual: virtuality.isVirtual,
                  joinLink: virtuality.joinLink,
                  provider: virtuality.provider,
                },
              }),
            );
            totals.flipped += 1;
            if (totals.flipped % SLEEP_EVERY === 0) await sleep(50);
          } catch (err) {
            totals.failed += 1;
            console.error(`  FAILED update ${row.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      console.log(
        `tenant ${tenant.slug} (${tenant.id}): scanned=${candidates.length} ` +
          `${COMMIT ? 'flipped' : 'would flip'}=${tenantFlips}`,
      );
    }

    console.log(
      `\n${COMMIT ? 'COMMIT' : 'DRY RUN'} done: scanned=${totals.scanned} ` +
        `${COMMIT ? `flipped=${totals.flipped}` : `wouldFlip=${totals.wouldFlip}`} ` +
        `failed=${totals.failed}`,
    );
    if (totals.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((err: unknown) => {
  console.error(
    '[backfill-google-meeting-virtuality] fatal',
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
