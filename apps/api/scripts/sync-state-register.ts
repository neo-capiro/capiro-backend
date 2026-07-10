/**
 * Sync state agency register notices into state_rule (Phase 1 M3.2, PD3
 * substrate). Per-state adapters — there is no 50-state API — registered in
 * `ADAPTERS` below. Only Florida is wired for v1 (the FL FAR feasibility
 * spike verified a real scrapable structure, live-fetched and confirmed;
 * see `fl-far.client.ts`'s header comment). The other 7 priority states are
 * explicitly NOT built blind: California's OAL publishes PDF-only notices
 * with no structured HTML/API (spike-verified NOT feasible without OCR);
 * the rest need their own feasibility spike before an adapter is written,
 * per the plan's own contingency ("If a state publishes no structured feed,
 * that state degrades to scheduled HTML scrape or is deferred").
 *
 * Watermark = max(publicationDate) already stored for that state (the
 * sync-federal-register.ts pattern) — walks the FL listing pages newest-
 * first and stops once a page's rows are all at-or-before the watermark.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-state-register.ts
 * Env: STATE_REGISTER_STATES (comma-separated; default = every registered
 *      adapter), STATE_REGISTER_MAX_PAGES (per-state safety cap, default 40
 *      — ~1,200 notices, comfortably above one state's weekly volume),
 *      STATE_REGISTER_DELAY_MS (politeness delay between fetches, default 400).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  fetchFlFarListingPage,
  fetchFlFarNoticeDetail,
  toStateRuleInput,
  type StateRuleUpsertInput,
} from '../src/external/state-register/fl-far.client.js';
dotenvConfig();

const prisma = new PrismaClient();
const MAX_PAGES = Number(process.env.STATE_REGISTER_MAX_PAGES ?? '40');
const DELAY_MS = Number(process.env.STATE_REGISTER_DELAY_MS ?? '400');
const WANTED_STATES = (process.env.STATE_REGISTER_STATES ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

interface StateAdapter {
  /** Walk pages newest-first, fetching + resolving each notice to a StateRule row (or null to skip it). Stops the caller's pagination when it returns fewer than a full page or signals no more pages via `hasMore=false` on the LAST yielded batch. */
  fetchAll(watermark: Date | null): AsyncGenerator<StateRuleUpsertInput | null>;
}

const ADAPTERS: Record<string, StateAdapter> = {
  FL: {
    async *fetchAll(watermark) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const listing = await fetchFlFarListingPage(page);
        if (!listing.rows.length) return;
        let anyNewer = false;
        for (const row of listing.rows) {
          if (watermark && row.publishDate && new Date(row.publishDate) <= watermark) continue;
          anyNewer = true;
          await new Promise((r) => setTimeout(r, DELAY_MS));
          try {
            const detail = await fetchFlFarNoticeDetail(row.noticeId);
            yield toStateRuleInput(detail);
          } catch (err) {
            console.error(
              `[sync-state-register] FL notice ${row.noticeId} failed:`,
              (err as Error).message,
            );
            yield null;
          }
        }
        if (!listing.hasNextPage || !anyNewer) return;
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    },
  },
};

async function main() {
  const states = (WANTED_STATES.length ? WANTED_STATES : Object.keys(ADAPTERS)).filter(
    (s) => s in ADAPTERS,
  );
  if (!states.length) {
    console.log(
      '[sync-state-register] no registered adapter matches STATE_REGISTER_STATES — nothing to do',
    );
    return;
  }

  await runWithSyncRun(prisma as never, 'sync-state-register', async () => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const state of states) {
      const watermarkRow = await prisma.stateRule.findFirst({
        where: { state },
        orderBy: { publicationDate: 'desc' },
        select: { publicationDate: true },
      });
      const watermark = watermarkRow?.publicationDate ?? null;
      console.log(
        `[sync-state-register] ${state}: watermark=${watermark?.toISOString().slice(0, 10) ?? 'none'}`,
      );

      for await (const input of ADAPTERS[state]!.fetchAll(watermark)) {
        if (!input) {
          skipped++;
          continue;
        }
        try {
          const existing = await prisma.stateRule.findUnique({
            where: { id: input.id },
            select: { id: true },
          });
          await prisma.stateRule.upsert({
            where: { id: input.id },
            create: {
              ...input,
              publicationDate: new Date(input.publicationDate),
              commentStartDate: input.commentStartDate ? new Date(input.commentStartDate) : null,
              commentEndDate: input.commentEndDate ? new Date(input.commentEndDate) : null,
              effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
            },
            update: {
              agency: input.agency,
              title: input.title,
              abstract: input.abstract,
              ruleType: input.ruleType,
              registerCitation: input.registerCitation,
              commentStartDate: input.commentStartDate ? new Date(input.commentStartDate) : null,
              commentEndDate: input.commentEndDate ? new Date(input.commentEndDate) : null,
              syncedAt: new Date(),
            },
          });
          if (existing) updated++;
          else inserted++;
        } catch (err) {
          errors++;
          console.error(`[sync-state-register] upsert ${input.id} failed:`, (err as Error).message);
        }
      }
    }

    console.log(
      `[sync-state-register] done: +${inserted} inserted, ~${updated} updated, ${skipped} skipped, ${errors} errors`,
    );
    return { inserted, updated, skipped, errors };
  });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
