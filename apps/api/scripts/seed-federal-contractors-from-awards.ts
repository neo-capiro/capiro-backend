/**
 * Seed / refresh `federal_contractor` from live `federal_award` aggregates.
 *
 *   pnpm --filter @capiro/api seed:federal-contractors-from-awards
 *   tsx scripts/seed-federal-contractors-from-awards.ts --min-awards 1 --min-total 0
 *
 * Why this exists
 * ───────────────
 * Entity resolution matches clients → contracting mappings ONLY against
 * `federal_contractor` (OpenSpending top-N). Live sole-live had ~41 rows there
 * and ~11k distinct contractor names in `federal_award`, so real DoD primes
 * (e.g. L3Harris) never appeared as candidates. Profiles then showed "—" for
 * Federal Awards even though USAspending money was already in Postgres.
 *
 * District Nexus / portfolio awards read confirmed contracting mappings by
 * exact `external_name` = `federal_award.contractor_name`. Seeding the catalog
 * from awards makes those names resolvable, and preserves UEI when awards
 * carry `recipient_uei` so tier-1 auto-confirm can fire on create/resolve.
 *
 * Idempotent: upserts on unique `federal_contractor.name`. Never deletes.
 * Does not write client_intel_mapping — that stays on entity-resolution /
 * match-contractor-identifiers / human confirm.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

dotenvConfig();

export interface AwardContractorAggregate {
  contractorName: string;
  awardCount: number;
  totalObligated: number;
  /** Best non-null UEI seen on awards for this name, if any. */
  recipientUei: string | null;
}

export interface SeedArgs {
  minAwards: number;
  minTotal: number;
  limit: number | null;
}

export function parseSeedArgs(argv: string[]): SeedArgs {
  const num = (name: string, fallback: number): number => {
    const withEq = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEq) return Number(withEq.slice(`--${name}=`.length));
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < argv.length) return Number(argv[i + 1]);
    return fallback;
  };
  const limitRaw = (() => {
    const withEq = argv.find((a) => a.startsWith('--limit='));
    if (withEq) return withEq.slice('--limit='.length);
    const i = argv.indexOf('--limit');
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  })();
  return {
    minAwards: num('min-awards', 1),
    minTotal: num('min-total', 0),
    limit: limitRaw != null && limitRaw !== '' ? Number(limitRaw) : null,
  };
}

/** Prefer a well-formed 12-char UEI; otherwise null. */
export function pickUei(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{12}$/.test(s) ? s : null;
}

/**
 * Pure merge helper used by tests: when an existing contractor row already has
 * a UEI, keep it; only fill empty UEI from awards. Totals always refresh from
 * the award aggregate so the catalog tracks the spend footprint.
 */
export function mergeContractorSeed(
  existing: { uei: string | null; totalContracts: number | null } | null,
  agg: AwardContractorAggregate,
): { uei: string | null; totalContracts: number } {
  const fromAwards = pickUei(agg.recipientUei);
  const keep = pickUei(existing?.uei ?? null);
  return {
    uei: keep ?? fromAwards,
    totalContracts: agg.totalObligated,
  };
}

export async function seedFederalContractorsFromAwards(
  prisma: PrismaClient,
  args: SeedArgs = { minAwards: 1, minTotal: 0, limit: null },
): Promise<{ upserted: number; ueiFilled: number }> {
  const t0 = Date.now();
  console.log(
    `[seed-federal-contractors] starting minAwards=${args.minAwards} minTotal=${args.minTotal}` +
      (args.limit != null ? ` limit=${args.limit}` : ''),
  );

  const all = await prisma.$queryRaw<
    Array<{
      contractor_name: string;
      award_count: bigint;
      total_obligated: number | null;
      recipient_uei: string | null;
    }>
  >`
    SELECT
      contractor_name,
      COUNT(*)::bigint AS award_count,
      COALESCE(SUM(amount), 0)::float8 AS total_obligated,
      MAX(recipient_uei) FILTER (
        WHERE recipient_uei ~ '^[A-Za-z0-9]{12}$'
      ) AS recipient_uei
    FROM federal_award
    WHERE contractor_name IS NOT NULL
      AND length(trim(contractor_name)) > 1
    GROUP BY contractor_name
    HAVING COUNT(*) >= ${args.minAwards}
       AND COALESCE(SUM(amount), 0) >= ${args.minTotal}
    ORDER BY COALESCE(SUM(amount), 0) DESC
  `;
  const rows = args.limit != null ? all.slice(0, args.limit) : all;

  let upserted = 0;
  let ueiFilled = 0;
  for (const r of rows) {
    const name = (r.contractor_name ?? '').trim();
    if (!name) continue;
    const agg: AwardContractorAggregate = {
      contractorName: name,
      awardCount: Number(r.award_count),
      totalObligated: Number(r.total_obligated ?? 0),
      recipientUei: r.recipient_uei,
    };
    const existing = await prisma.federalContractor.findUnique({
      where: { name },
      select: { id: true, uei: true, totalContracts: true },
    });
    const merged = mergeContractorSeed(
      existing
        ? {
            uei: existing.uei,
            totalContracts:
              existing.totalContracts != null ? Number(existing.totalContracts) : null,
          }
        : null,
      agg,
    );
    if (!existing?.uei && merged.uei) ueiFilled += 1;

    await prisma.federalContractor.upsert({
      where: { name },
      create: {
        id: randomUUID(),
        name,
        uei: merged.uei,
        totalContracts: merged.totalContracts,
        category: 'Defense',
        lastSyncedAt: new Date(),
        raw: {
          seededFrom: 'federal_award',
          awardCount: agg.awardCount,
          seededAt: new Date().toISOString(),
        },
      },
      update: {
        ...(merged.uei ? { uei: merged.uei } : {}),
        totalContracts: merged.totalContracts,
        lastSyncedAt: new Date(),
      },
    });
    upserted += 1;
  }

  console.log(
    `[seed-federal-contractors] upserted=${upserted} ueiFilled=${ueiFilled} ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  return { upserted, ueiFilled };
}

async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    await seedFederalContractorsFromAwards(prisma, args);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed as a script (tsx/node). Jest imports the helpers.
const isDirectRun =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isDirectRun) {
  main().catch((err) => {
    console.error('[seed-federal-contractors] FAILED', err);
    process.exit(1);
  });
}