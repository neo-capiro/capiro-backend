/** @cleanup-smoke noArgsExit=2 */
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
 * Env: STATE_REGISTER_STATES (comma-separated; default when unset = every
 *      registered adapter, currently FL only — so the daily schedule runs FL
 *      with no env set; set this only to narrow/expand as adapters are added),
 *      STATE_REGISTER_MAX_PAGES (per-state safety cap, default 40
 *      — ~1,200 notices, comfortably above one state's weekly volume),
 *      STATE_REGISTER_DELAY_MS (politeness delay between fetches, default 400).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { persistNoticeEvidence } from '../src/ingestion/legal-research-evidence.js';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  fetchFlFarListingPage,
  fetchFlFarNoticeDetail,
  fetchFlRuleHistory,
  toStateRuleInput,
  type StateRuleUpsertInput,
} from '../src/external/state-register/fl-far.client.js';
dotenvConfig();


const MAX_PAGES = Number(process.env.STATE_REGISTER_MAX_PAGES ?? '40');
const DELAY_MS = Number(process.env.STATE_REGISTER_DELAY_MS ?? '400');
const REVISIT_DAYS = Number(process.env.STATE_REGISTER_REVISIT_DAYS ?? '30');
const TRACKED_RULES = (process.env.STATE_REGISTER_TRACKED_RULES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (
  !Number.isInteger(MAX_PAGES) ||
  MAX_PAGES < 1 ||
  MAX_PAGES > 100 ||
  !Number.isFinite(DELAY_MS) ||
  DELAY_MS < 0 ||
  !Number.isInteger(REVISIT_DAYS) ||
  REVISIT_DAYS < 1 ||
  REVISIT_DAYS > 366 ||
  TRACKED_RULES.length > 20
)
  throw Error('INVALID_STATE_REGISTER_BOUNDS');
const coverage = {
  source: 'fl-far',
  scope: { discovery: 'proposed', revisitDays: REVISIT_DAYS, trackedRules: TRACKED_RULES },
  complete: false,
  pages: 0,
  seen: 0,
  failed: [] as string[],
  gaps: [] as string[],
};
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
      const visited = new Set<string>();
      for (const rule of TRACKED_RULES) {
        try {
          const history = await fetchFlRuleHistory(rule);
          if (!history.complete) coverage.gaps.push(`HISTORY_TRUNCATED:${rule}`);
          for (const row of history.notices.rows.slice(0, 100))
            if (!visited.has(row.noticeId)) {
              visited.add(row.noticeId);
              try {
                yield toStateRuleInput(await fetchFlFarNoticeDetail(row.noticeId));
              } catch {
                coverage.failed.push(row.noticeId);
                yield null;
              }
            }
          if (history.notices.rows.length > 100) coverage.gaps.push(`HISTORY_CAP:${rule}`);
        } catch {
          coverage.gaps.push(`HISTORY_UNAVAILABLE:${rule}`);
        }
      }
      const revisit = watermark ? new Date(watermark.getTime() - REVISIT_DAYS * 86400000) : null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const listing = await fetchFlFarListingPage(page);
        coverage.pages++;
        if (!listing.rows.length) {
          coverage.gaps.push('EMPTY_LISTING_UNQUALIFIED');
          return;
        }
        let anyNewer = false;
        for (const row of listing.rows) {
          // W4.2: strict `<` (not `<=`) — a notice published ON the watermark
          // date is RE-FETCHED (and de-duplicated by the id-keyed upsert),
          // matching the federal inclusive-refetch pattern. `<=` silently
          // dropped every same-day notice filed after the watermark row.
          // A strictly-older row still skips + leaves anyNewer false, so a page
          // of only-older rows still stops pagination (termination holds).
          if (revisit && row.publishDate && new Date(row.publishDate) < revisit) continue;
          anyNewer = true;
          if (visited.has(row.noticeId)) continue;
          visited.add(row.noticeId);
          coverage.seen++;
          await new Promise((r) => setTimeout(r, DELAY_MS));
          try {
            const detail = await fetchFlFarNoticeDetail(row.noticeId);
            yield toStateRuleInput(detail);
          } catch (err) {
            coverage.failed.push(row.noticeId);
            console.error(
              `[sync-state-register] FL notice ${row.noticeId} failed:`,
              (err as Error).message,
            );
            yield null;
          }
        }
        if (!listing.hasNextPage || !anyNewer) {
          coverage.complete = !coverage.failed.length && !coverage.gaps.length;
          return;
        }
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
      coverage.gaps.push('PAGE_CAP');
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

  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-state-register.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
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
          const { noticeEvidence, ...fields } = input;
          await prisma.$transaction(async (tx) => {
            await tx.stateRule.upsert({
              where: { id: input.id },
              create: {
                ...fields,
                publicationDate: input.publicationDate ? new Date(input.publicationDate) : null,
                filingDate: input.filingDate ? new Date(input.filingDate) : null,
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
                publicationDate: input.publicationDate ? new Date(input.publicationDate) : null,
                filingDate: input.filingDate ? new Date(input.filingDate) : null,
                effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : null,
                linkedRuleNumbers: input.linkedRuleNumbers,
                sourceRevision: input.sourceRevision,
                commentStartDate: input.commentStartDate ? new Date(input.commentStartDate) : null,
                commentEndDate: input.commentEndDate ? new Date(input.commentEndDate) : null,
                syncedAt: new Date(),
              },
            });
            if (noticeEvidence) await persistNoticeEvidence(tx, noticeEvidence);
          });
          if (existing) updated++;
          else inserted++;
        } catch (err) {
          errors++;
          coverage.failed.push(input.id);
          console.error(`[sync-state-register] upsert ${input.id} failed:`, (err as Error).message);
        }
      }
    }

    console.log(
      `[sync-state-register] done: +${inserted} inserted, ~${updated} updated, ${skipped} skipped, ${errors} errors`,
    );
    coverage.complete = coverage.complete && !errors && !skipped;
    const id = createHash('sha256')
      .update(JSON.stringify([coverage, new Date().toISOString()]))
      .digest('hex');
    await prisma.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${id},'fl-far',${JSON.stringify(coverage.scope)}::jsonb,${JSON.stringify(coverage)}::jsonb,${coverage.complete})`;
    return { inserted, updated, skipped, errors };
  });

  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
