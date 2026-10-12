/**
 * Sync FEC campaign finance data (committees + top contributions).
 *   pnpm --filter @capiro/api sync:fec
 * Source: api.open.fec.gov/v1/
 * Auth: API key. Key in env: FEC_API_KEY
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { fecCycles, FEC_PAC_COMMITTEE_TYPES } from '../src/intelligence/fec-cycles.js';
import { createFecFetcher, fecSchedulePages } from './fec-api.js';
dotenvConfig();

const FEC_KEY = process.env.FEC_API_KEY ?? '';
// Each committee_type is a separate API argument (comma-joined values are invalid).
// PAC discovery must include the same types consumed by entity resolution.
const COMMITTEE_TYPES = [...FEC_PAC_COMMITTEE_TYPES, 'H', 'S', 'P'];
const fetchFec = createFecFetcher(FEC_KEY);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-fec.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  console.log('[fec-sync] starting');
  if (!FEC_KEY) throw new Error('FEC_API_KEY env var is required');

  try {
    await runWithSyncRun(prisma as any, 'sync-fec', async () => {
      const t0 = Date.now();
      // Populate the full catalog, including PACs used by client source mapping.
      let totalComms = 0;
      let errors = 0;
      let contributionSampleComplete = true;
      for (const cycle of fecCycles()) {
        for (const ctype of COMMITTEE_TYPES) {
          for (let page = 1; ; page++) {
            const data = await fetchFec<any>('/committees/', {
              cycle: String(cycle),
              page: String(page),
              committee_type: ctype, // single value — FEC rejects comma-joined lists (422)
              // NOTE: FEC /committees/ rejects sort=-receipts ("Cannot sort on receipts
              // when parameter 'q' is not set", 422). Default ordering is fine.
            });
            if (!data.results.length) break;

            for (const c of data.results) {
              await (prisma as any).fecCommittee.upsert({
                where: { id: c.committee_id },
                update: {
                  name: c.name,
                  designation: c.designation || null,
                  committeeType: c.committee_type || null,
                  party: c.party || null,
                  state: c.state || null,
                  treasurerName: c.treasurer_name || null,
                  totalReceipts: c.receipts ?? null,
                  totalDisbursements: c.disbursements ?? null,
                  cashOnHand: c.last_cash_on_hand_end_period ?? null,
                  cycles: { set: Array.from(new Set([...(c.cycles ?? []), cycle])) },
                  lastSyncedAt: new Date(),
                },
                create: {
                  id: c.committee_id,
                  name: c.name,
                  designation: c.designation || null,
                  committeeType: c.committee_type || null,
                  party: c.party || null,
                  state: c.state || null,
                  treasurerName: c.treasurer_name || null,
                  totalReceipts: c.receipts ?? null,
                  totalDisbursements: c.disbursements ?? null,
                  cashOnHand: c.last_cash_on_hand_end_period ?? null,
                  cycles: Array.from(new Set([...(c.cycles ?? []), cycle])),
                },
              });
              totalComms++;
            }
            console.log(
              `[fec-sync] committees page ${page} cycle ${cycle} type ${ctype}: ${data.results.length}`,
            );
            if (data.pagination?.pages != null && page >= data.pagination.pages) break;
          }
        } // end committee-type loop
      } // end cycles loop

      // Preserve the existing top-500, minimum-$10k Schedule A sample. It is not
      // exhaustive employer giving. Use its cursor and expose truncation to SyncRun.
      let totalContribs = 0;
      for (const cycle of fecCycles()) {
        let page = 0;
        for await (const results of fecSchedulePages<any>(fetchFec, '/schedules/schedule_a/', {
          two_year_transaction_period: String(cycle),
          sort: '-contribution_receipt_amount',
          min_amount: '10000',
        })) {
          if (++page > 5) {
            contributionSampleComplete = false;
            break;
          }
          for (const c of results) {
            if (!c.contribution_receipt_amount) continue;

            const contributionDate = c.contribution_receipt_date
              ? new Date(c.contribution_receipt_date)
              : null;
            const safeContributionDate =
              contributionDate && !Number.isNaN(contributionDate.getTime())
                ? contributionDate
                : null;

            try {
              await (prisma as any).fecContribution.create({
                data: {
                  committeeId: c.committee_id || '',
                  committeeName: c.committee?.name || c.committee_name || null,
                  candidateId: c.candidate_id || c.candidate?.candidate_id || null,
                  candidateName: c.candidate_name || c.candidate?.name || null,
                  contributorName: c.contributor_name || 'Unknown',
                  contributorEmployer: c.contributor_employer || null,
                  contributorOccupation: c.contributor_occupation || null,
                  amount: c.contribution_receipt_amount,
                  contributionDate: safeContributionDate,
                  receiptType: c.receipt_type || null,
                  memoText: c.memo_text || null,
                  state: c.contributor_state || c.committee?.state || null,
                  cycle,
                },
              });
              totalContribs++;
            } catch (err: any) {
              // P2002 = unique constraint hit (expected for re-runs); keep quiet.
              if (err?.code !== 'P2002') {
                errors++;
                console.warn(
                  `[fec-sync] contribution insert failed: ${err?.message ?? String(err)}`,
                );
              }
            }
          }
          console.log(`[fec-sync] contributions page ${page} cycle ${cycle}: ${results.length}`);
        }
      } // end contributions cycles loop

      console.log(`[fec-sync] total: ${totalComms} committees, ${totalContribs} contributions`);
      console.log(`[fec-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return {
        inserted: totalContribs,
        updated: totalComms,
        skipped: 0,
        errors,
        complete: contributionSampleComplete && errors === 0,
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[fec-sync] FAILED', err);
  process.exit(1);
});
}
