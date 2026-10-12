/** @cleanup-smoke noArgsExit=2 */
/**
 * Backfill the client knowledge base index (assistant-parity F5).
 *
 *   pnpm --filter @capiro/api backfill:client-kb -- --tenant=<slug-or-uuid>            # DRY RUN
 *   pnpm --filter @capiro/api backfill:client-kb -- --tenant=<slug-or-uuid> --commit
 *   pnpm --filter @capiro/api backfill:client-kb -- --all-tenants --commit
 *
 * DRY RUN (default) prints what WOULD be indexed per client (profile/people/
 * facility/document counts) without touching Bedrock, S3, or
 * context_embeddings. --commit drives the PRODUCTION ClientKbService
 * (instantiated manually around PrismaService, the same no-Nest-container
 * pattern as generate-actions.ts), so this script can never drift from the
 * live indexer: same text builders, same chunker, same purge-then-reindex
 * semantics, same content_hash skip for unchanged rows (re-runs are cheap).
 *
 * Requires DATABASE_URL. --commit additionally needs AWS credentials with
 * Bedrock Titan access and, for document text extraction, ASSETS_BUCKET + S3
 * read access — without the bucket the service indexes docs by filename only
 * (its normal fail-open behavior). Rate-limited: 200ms sleep between clients.
 */
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ClientKbService } from '../src/embeddings/client-kb.service.js';
import type { AppConfig } from '../src/config/config.schema.js';

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
const SLEEP_MS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Minimal ConfigService stand-in covering exactly the keys ClientKbService
 * reads: AWS_REGION_DEFAULT (string, schema default us-east-1), ASSETS_BUCKET
 * (string | undefined), CLIO_CLIENT_KB_ENABLED (boolean after the zod
 * transform in config.schema.ts — replicated here so env strings behave the
 * same way as in the Nest app).
 */
const configLike = {
  get(key: string, _opts?: unknown): unknown {
    if (key === 'AWS_REGION_DEFAULT') return process.env.AWS_REGION_DEFAULT ?? 'us-east-1';
    if (key === 'CLIO_CLIENT_KB_ENABLED') {
      const raw = (process.env.CLIO_CLIENT_KB_ENABLED ?? 'true').trim().toLowerCase();
      return !['false', '0', 'no', 'off'].includes(raw);
    }
    return process.env[key];
  },
} as unknown as ConfigService<AppConfig, true>;

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
      'usage: backfill-client-kb --tenant=<slug-or-uuid> [--commit]\n' +
        '       backfill-client-kb --all-tenants [--commit]\n' +
        'DRY RUN by default; --commit embeds + writes context_embeddings.',
    );
    process.exit(2);
  }

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const kb = new ClientKbService(prisma, configLike);
    const tenants = await resolveTenants(prisma);
    console.log(
      `${COMMIT ? 'COMMIT' : 'DRY RUN'}: client-kb backfill over ${tenants.length} tenant(s)` +
        `${COMMIT && !process.env.ASSETS_BUCKET ? ' (ASSETS_BUCKET unset — docs index by filename only)' : ''}\n`,
    );

    const totals = { clients: 0, profile: 0, people: 0, facilities: 0, documents: 0, failed: 0 };

    for (const tenant of tenants) {
      // Same client filter as ClientKbService.backfillTenant.
      const clients = await prisma.withTenant(tenant.id, (tx) =>
        tx.client.findMany({
          where: { status: { not: 'archived' } },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      );
      console.log(`tenant ${tenant.slug} (${tenant.id}): ${clients.length} client(s)`);

      for (const client of clients) {
        totals.clients += 1;
        try {
          if (!COMMIT) {
            const [people, facilities, documents] = await prisma.withTenant(tenant.id, (tx) =>
              Promise.all([
                tx.clientPerson.count({ where: { clientId: client.id } }),
                tx.clientFacility.count({ where: { clientId: client.id } }),
                tx.engagementAttachment.count({ where: { clientId: client.id } }),
              ]),
            );
            totals.profile += 1;
            totals.people += people;
            totals.facilities += facilities;
            totals.documents += documents;
            console.log(
              `  would index ${client.name}: profile=1 people=${people} ` +
                `facilities=${facilities} documents=${documents}`,
            );
            continue;
          }

          const result = await kb.backfillClient(tenant.id, client.id);
          totals.profile += result.profile;
          totals.people += result.people;
          totals.facilities += result.facilities;
          totals.documents += result.documents;
          console.log(
            `  indexed ${client.name}: profile=${result.profile} people=${result.people} ` +
              `facilities=${result.facilities} documents=${result.documents}`,
          );
          // Rate-limit Bedrock/S3 between clients.
          await sleep(SLEEP_MS);
        } catch (err) {
          // One client's failure must not abort the rest of the run.
          totals.failed += 1;
          console.error(`  FAILED ${client.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    console.log(
      `\n${COMMIT ? 'COMMIT' : 'DRY RUN'} done: clients=${totals.clients} profile=${totals.profile} ` +
        `people=${totals.people} facilities=${totals.facilities} documents=${totals.documents} ` +
        `failed=${totals.failed}`,
    );
    if (totals.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((err: unknown) => {
  console.error('[backfill-client-kb] fatal', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
