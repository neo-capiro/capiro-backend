/**
 * Enrich federal_award rows with congressional district from the USAspending
 * AWARD DETAIL endpoint.
 *
 *   pnpm --filter @capiro/api enrich:award-districts -- --limit 2000
 *   tsx scripts/enrich-award-districts.ts --limit 2000 --min-amount 100000
 *
 * WHY: the spending_by_award SEARCH endpoint (used by sync-federal-award) returns
 * Place-of-Performance STATE but NOT congressional district. The per-award DETAIL
 * endpoint (/api/v2/awards/<id>/) DOES return place_of_performance.congressional_code.
 * So we backfill district by calling the detail endpoint for awards that still lack
 * pop_congressional_district, highest-dollar first (those are the ones that matter
 * for a district-spend argument), capped per run.
 *
 * Idempotent: only processes rows where pop_congressional_district IS NULL. Safe to
 * re-run; each run chips away at the remaining unenriched, amount-desc.
 *
 * Rate: USAspending is generous but not unlimited; DELAY_MS between calls, and a
 * --limit cap so a single run is bounded. Re-run (or schedule) to continue.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const DETAIL_URL = 'https://api.usaspending.gov/api/v2/awards';
const DELAY_MS = Number(process.env.USASPENDING_DELAY_MS ?? 150);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface DetailLoc {
  state_code?: string | null;
  congressional_code?: string | null;
}

async function fetchDetail(awardId: string): Promise<{
  popState: string | null;
  popDistrict: string | null;
  recipientState: string | null;
  recipientDistrict: string | null;
} | null> {
  // Retry with backoff on throttling (429) / transient 5xx. USAspending throttles
  // bursts, so a single run hitting it hard sees waves of failures; backoff lets the
  // run ride them out instead of dropping ~1k awards to retry later.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${DETAIL_URL}/${encodeURIComponent(awardId)}/`);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          // Exponential backoff: 1s, 2s, 4s (+ jitter).
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1) + Math.random() * 250));
          continue;
        }
        return null;
      }
      if (!res.ok) return null;
      const d = (await res.json()) as {
        place_of_performance?: DetailLoc | null;
        recipient?: { location?: DetailLoc | null } | null;
      };
      const pop = d.place_of_performance ?? {};
      const rl = d.recipient?.location ?? {};
      return {
        popState: pop.state_code ?? null,
        popDistrict: pop.congressional_code ?? null,
        recipientState: rl.state_code ?? null,
        recipientDistrict: rl.congressional_code ?? null,
      };
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/enrich-award-districts.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const limit = Number(arg('limit') ?? 2000);
  const minAmount = arg('min-amount') ? Number(arg('min-amount')) : null;

  const prisma = new PrismaClient();
  await prisma.$connect();
  const t0 = Date.now();
  console.log(`[enrich-districts] limit=${limit} minAmount=${minAmount ?? 'none'}`);

  try {
    // Highest-dollar unenriched awards first — those drive the district argument.
    const rows = await prisma.federalAward.findMany({
      where: {
        popCongressionalDistrict: null,
        ...(minAmount != null ? { amount: { gte: minAmount } } : {}),
      },
      select: { id: true, awardUniqueId: true },
      orderBy: { amount: 'desc' },
      take: limit,
    });
    console.log(`[enrich-districts] ${rows.length} unenriched award(s) to process`);

    let enriched = 0;
    let noData = 0;
    let failed = 0;
    for (const row of rows) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const detail = await fetchDetail(row.awardUniqueId);
      if (!detail) {
        failed += 1;
        continue;
      }
      // Only write when we actually got a district (else leave NULL so a later run
      // can retry; writing '' would mask the gap).
      if (!detail.popDistrict && !detail.recipientDistrict) {
        noData += 1;
        // Still capture state if present and missing, harmless.
        if (detail.popState || detail.recipientState) {
          await prisma.federalAward.update({
            where: { id: row.id },
            data: {
              popState: detail.popState ?? undefined,
              recipientState: detail.recipientState ?? undefined,
            },
          });
        }
        continue;
      }
      await prisma.federalAward.update({
        where: { id: row.id },
        data: {
          popState: detail.popState ?? undefined,
          popCongressionalDistrict: detail.popDistrict ?? undefined,
          recipientState: detail.recipientState ?? undefined,
          recipientCongressionalDistrict: detail.recipientDistrict ?? undefined,
        },
      });
      enriched += 1;
      if (enriched % 100 === 0) {
        console.log(`[enrich-districts] enriched=${enriched} noData=${noData} failed=${failed}`);
      }
    }

    console.log(
      JSON.stringify(
        { processed: rows.length, enriched, noData, failed, seconds: ((Date.now() - t0) / 1000).toFixed(1) },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error('[enrich-districts] FAILED', err);
  process.exit(1);
});
}
