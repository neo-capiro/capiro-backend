/**
 * Backfill CongressBill sponsor fields (sponsor_name / state / party + cosponsors).
 *
 *   tsx scripts/backfill-bill-sponsors.ts [--congress 119] [--limit 5000]
 *
 * The Congress.gov sync historically read a singular `sponsor` field the API
 * never sends (it returns a `sponsors[]` array), so sponsor_name was NULL for
 * every bill — which left the Office Recommender unable to rank by bill sponsor
 * (it always fell back to committee-of-jurisdiction). The sync is now fixed for
 * new data; this re-fetches bill detail to populate sponsors on EXISTING rows.
 *
 * Only touches bills with a NULL sponsor_name. Idempotent + throttled (1 detail
 * call/bill, 200ms apart → ~5/s, well under the ~5000/hour Congress.gov limit).
 * Scope to one congress with --congress to keep a single run under the quota.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const CONGRESS_BASE = 'https://api.congress.gov/v3';
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY ?? '';

interface Sponsor {
  fullName?: string | null;
  party?: string | null;
  state?: string | null;
}
interface BillDetailResponse {
  bill?: {
    sponsors?: Sponsor[] | null;
    cosponsors?: { count?: number } | null;
  } | null;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/backfill-bill-sponsors.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  if (!CONGRESS_API_KEY) throw new Error('CONGRESS_API_KEY not set');

  const congressArg = argValue('--congress');
  const limit = Number(argValue('--limit') ?? '5000');

  const prisma = new PrismaClient();
  await prisma.$connect();

  const startedAt = Date.now();
  let updated = 0;
  let noSponsor = 0;
  let failed = 0;

  try {
    const bills = await prisma.congressBill.findMany({
      where: {
        sponsorName: null,
        ...(congressArg ? { congress: Number(congressArg) } : {}),
      },
      select: { id: true, congress: true, billType: true, billNumber: true },
      orderBy: [{ congress: 'desc' }, { id: 'asc' }],
      take: Number.isFinite(limit) && limit > 0 ? limit : 5000,
    });

    for (const bill of bills) {
      const type = bill.billType.toLowerCase();
      const url = `${CONGRESS_BASE}/bill/${bill.congress}/${type}/${bill.billNumber}?api_key=${CONGRESS_API_KEY}&format=json`;
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          failed += 1;
          await sleep(200);
          continue;
        }
        const json = (await resp.json()) as BillDetailResponse;
        const sponsor = json.bill?.sponsors?.[0];
        const cosponsors = json.bill?.cosponsors?.count;
        if (sponsor?.fullName) {
          await prisma.congressBill.update({
            where: { id: bill.id },
            data: {
              sponsorName: sponsor.fullName,
              sponsorState: sponsor.state ?? null,
              sponsorParty: sponsor.party ?? null,
              ...(typeof cosponsors === 'number' ? { cosponsorsCount: cosponsors } : {}),
            },
          });
          updated += 1;
        } else {
          noSponsor += 1;
        }
      } catch {
        failed += 1;
      }
      await sleep(200);
    }

    console.log(
      JSON.stringify(
        {
          congress: congressArg ?? 'all',
          bills_scanned: bills.length,
          sponsors_backfilled: updated,
          no_sponsor_in_api: noSponsor,
          failed,
          duration_seconds: Math.round((Date.now() - startedAt) / 1000),
        },
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
  console.error(err);
  process.exit(1);
});
}
