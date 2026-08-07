/**
 * Client profile enrichment candidate generator (Funding Opportunities P20).
 *
 *   tsx scripts/generate-tango-enrichment-candidates.ts
 *   tsx scripts/generate-tango-enrichment-candidates.ts --limit=50
 *
 * For every client with a UEI — across ALL tenants — compares the client's
 * profile against its active Tango entity snapshot (P19) and durably
 * proposes review candidates for whatever differs. NEVER writes to
 * `clients` directly; see `ClientProfileEnrichmentService`'s class doc for
 * the full "propose, never overwrite" reasoning. Idempotent: re-running
 * never re-creates a candidate that already exists, pending, accepted, or
 * rejected — see the migration's own durability section.
 *
 * NOT dry-run-gated the way a mutating sync is: this script only ever
 * INSERTS into the enrichment-candidate table, never `clients` — there is
 * nothing here for a human to preview before it "commits", since proposing
 * a candidate is not itself a decision about the client's profile. Review
 * (accept/reject), which DOES change `clients`, is a separate, deliberate
 * action — see `review-tango-enrichment-candidate.ts`.
 *
 * NO database connection to Tango; this reads ONLY what P19 already synced
 * into `tango_resource_snapshot`. A client whose UEI has never been synced
 * (or whose snapshot has since gone stale) is simply skipped — run
 * `sync-tango-entities` first.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TangoStoreService } from '../src/external/tango/tango-store.service.js';
import { ClientProfileEnrichmentService } from '../src/funding-opportunities/client-profile-enrichment.service.js';

dotenvConfig();

const DEFAULT_LIMIT = 2000;
const BATCH_SIZE = 25;

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  limit: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const raw = flagValue(argv, 'limit');
  const parsed = raw != null ? Number(raw) : NaN;
  return { limit: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20_000) : DEFAULT_LIMIT };
}

export interface UeiClientRef {
  id: string;
  tenantId: string;
}

export interface GenerateSummary {
  clientsScanned: number;
  proposed: number;
  alreadyExisted: number;
  skipped: number;
}

/**
 * The testable core. `readUeiClientBatch` is injected so
 * generate-tango-enrichment-candidates.spec.ts can drive this against a
 * fake list of (tenantId, clientId) pairs with no real Postgres and no real
 * ClientProfileEnrichmentService.
 */
export async function run(
  deps: {
    readUeiClientBatch: (cursor: string | null, take: number) => Promise<UeiClientRef[]>;
    proposeCandidatesForClient: (tenantId: string, clientId: string) => Promise<{ proposed: number; alreadyExisted: number; skipped: boolean }>;
  },
  limit: number,
): Promise<GenerateSummary> {
  const summary: GenerateSummary = { clientsScanned: 0, proposed: 0, alreadyExisted: 0, skipped: 0 };
  let cursor: string | null = null;

  for (;;) {
    const remaining = limit - summary.clientsScanned;
    if (remaining <= 0) break;
    const batch = await deps.readUeiClientBatch(cursor, Math.min(BATCH_SIZE, remaining));
    if (batch.length === 0) break;

    for (const ref of batch) {
      // Defensive, not just trusting `take`: a batch reader that ever
      // returned more rows than asked for must not push clientsScanned past
      // the caller's own limit.
      if (summary.clientsScanned >= limit) break;
      summary.clientsScanned += 1;
      const result = await deps.proposeCandidatesForClient(ref.tenantId, ref.id);
      summary.proposed += result.proposed;
      summary.alreadyExisted += result.alreadyExisted;
      if (result.skipped) summary.skipped += 1;
    }
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < BATCH_SIZE) break;
  }

  return summary;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const store = new TangoStoreService(prisma);
    const enrichment = new ClientProfileEnrichmentService(prisma, store);

    const readUeiClientBatch = async (cursor: string | null, take: number): Promise<UeiClientRef[]> =>
      prisma.withSystem((tx) =>
        tx.client.findMany({
          where: { uei: { not: null } },
          orderBy: { id: 'asc' },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          take,
          select: { id: true, tenantId: true },
        }),
      );

    const summary = await run(
      {
        readUeiClientBatch,
        proposeCandidatesForClient: (tenantId, clientId) => enrichment.proposeCandidatesForClient(tenantId, clientId),
      },
      args.limit,
    );

    console.log(`TANGO_ENRICHMENT_DONE ${JSON.stringify(summary)}`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /generate-tango-enrichment-candidates(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('TANGO_ENRICHMENT_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { main };
