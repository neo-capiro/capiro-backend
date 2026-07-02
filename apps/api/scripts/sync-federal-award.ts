/**
 * Step 28 — federal_award sync from USAspending.gov, enriched with PE attribution.
 *
 *   pnpm --filter @capiro/api sync:federal-award                 # daily: DoD, last 7 days
 *   tsx scripts/sync-federal-award.ts --days 7
 *   tsx scripts/sync-federal-award.ts --backfill --since 2020-10-01   # separate backfill
 *
 * USAspending API v2 (api.usaspending.gov/api/v2/search/spending_by_award), filtered
 * to DoD awarding agency, delta on action_date. Cursor (page)-based pagination. For
 * each award: resolve a PE code (explicit field, else regex on description), validate
 * against program_element (keep only known PEs; otherwise pe_code stays NULL — NOT
 * quarantined), and upsert by generated_unique_award_id. SyncRun row tracks the run.
 *
 * Idempotent: upsert keyed on award_unique_id; re-running the same window changes
 * nothing. Deterministic PE extraction.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { AwardPeExtractorService } from '../src/program-element/extractors/award-pe-extractor.service.js';

dotenvConfig();

const USASPENDING = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

interface AwardResult {
  generatedInternalId: string;
  piid: string | null;
  fain: string | null;
  recipientName: string | null;
  recipientUei: string | null;
  amount: number | null;
  description: string | null;
  awardingAgency: string | null;
  awardingSubTier: string | null;
  actionDate: string | null;
  popState: string | null;
  popCongressionalDistrict: string | null;
  recipientState: string | null;
  recipientCongressionalDistrict: string | null;
}

/** Fetch one page of DoD awards in [startDate, endDate] (action_date). */
async function fetchPage(startDate: string, endDate: string, page: number): Promise<{ results: AwardResult[]; hasNext: boolean }> {
  const body = {
    filters: {
      time_period: [{ start_date: startDate, end_date: endDate, date_type: 'action_date' }],
      // USAspending spending_by_award requires the agency by NAME (toptier_code is
      // rejected here with a misleading "filters required" 422).
      agencies: [{ type: 'awarding', tier: 'toptier', name: 'Department of Defense' }],
      award_type_codes: ['A', 'B', 'C', 'D'], // contract award types
    },
    // Only request fields the endpoint actually returns for contracts. 'Action Date'
    // is requested but often null; fall back to 'Last Modified Date' for awarded_at.
    fields: [
      'Award ID', 'Recipient Name', 'Award Amount',
      'Description', 'Awarding Agency', 'Awarding Sub Agency', 'Action Date', 'Last Modified Date',
      // Location fields for district nexus. USAspending returns these for contracts.
      'Place of Performance State Code', 'Place of Performance Congressional District',
      'Recipient Location State Code', 'Recipient Location Congressional District',
    ],
    page,
    limit: 100,
    sort: 'Award Amount',
    order: 'desc',
  };
  const res = await fetch(USASPENDING, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`USAspending ${res.status}: ${await res.text().catch(() => '')}`);
  const json = (await res.json()) as { results?: Record<string, unknown>[]; page_metadata?: { hasNext?: boolean } };
  const results: AwardResult[] = (json.results ?? []).map((r) => ({
    // generated_internal_id is the stable idempotency key; internal_id is a fallback.
    generatedInternalId: String(r.generated_internal_id ?? r.internal_id ?? ''),
    piid: (r['Award ID'] as string) ?? null,
    fain: null,
    recipientName: (r['Recipient Name'] as string) ?? null,
    recipientUei: null,
    amount: r['Award Amount'] != null ? Number(r['Award Amount']) : null,
    description: (r['Description'] as string) ?? null,
    awardingAgency: (r['Awarding Agency'] as string) ?? null,
    awardingSubTier: (r['Awarding Sub Agency'] as string) ?? null,
    actionDate: (r['Action Date'] as string) ?? (r['Last Modified Date'] as string) ?? null,
    popState: (r['Place of Performance State Code'] as string) ?? null,
    popCongressionalDistrict: (r['Place of Performance Congressional District'] as string) ?? null,
    recipientState: (r['Recipient Location State Code'] as string) ?? null,
    recipientCongressionalDistrict: (r['Recipient Location Congressional District'] as string) ?? null,
  }));
  return { results, hasNext: Boolean(json.page_metadata?.hasNext) };
}

async function main(): Promise<void> {
  const backfill = hasFlag('backfill');
  const endDate = isoDaysAgo(0);
  const startDate = backfill ? (arg('since') ?? '2020-10-01') : isoDaysAgo(Number(arg('days') ?? 7));
  const source = 'usaspending_federal_award';

  const prisma = new PrismaClient();
  await prisma.$connect();
  const extractor = new AwardPeExtractorService();

  const run = await prisma.syncRun.create({
    data: { source, startedAt: new Date(), status: 'running' },
  });

  let inserted = 0;
  let updated = 0;
  let errors = 0;
  let withPe = 0;
  let windowsProcessed = 0;
  let windowsSplit = 0;

  try {
    // Load known PE codes once (validation set).
    const pes = await prisma.programElement.findMany({ select: { peCode: true } });
    const knownPeCodes = new Set(pes.map((p) => p.peCode.toUpperCase()));
    console.error(`Loaded ${knownPeCodes.size} known PE codes; window ${startDate}..${endDate}`);

    const processWindow = async (winStart: string, winEnd: string): Promise<void> => {
      let page = 1;
      const maxPages = backfill ? 1000 : 200; // circuit breaker
      for (; page <= maxPages; page += 1) {
        const { results, hasNext } = await fetchPage(winStart, winEnd, page);
        for (const a of results) {
          if (!a.generatedInternalId) {
            errors += 1;
            continue;
          }
          // High-volume sync resolves PE from fields present on the search payload
          // (explicit/description). The DoD-acquisition-program tier needs the
          // per-award detail call, so it runs in the enrich-award-pe backfill task,
          // not here. resolvePe still returns provenance so pe_code_source is set.
          const resolved = extractor.resolvePe({ description: a.description }, knownPeCodes);
          const peCode = resolved?.peCode ?? null;
          const peCodeSource = resolved?.source ?? null;
          if (peCode) withPe += 1;

          const data = {
            awardUniqueId: a.generatedInternalId,
            piid: a.piid,
            fain: a.fain,
            awardingAgency: a.awardingAgency,
            awardingSubTier: a.awardingSubTier,
            contractorName: a.recipientName,
            recipientUei: a.recipientUei,
            amount: a.amount,
            description: a.description,
            peCode,
            peCodeSource,
            popState: a.popState,
            popCongressionalDistrict: a.popCongressionalDistrict,
            recipientState: a.recipientState,
            recipientCongressionalDistrict: a.recipientCongressionalDistrict,
            actionDate: a.actionDate ? new Date(a.actionDate) : null,
            awardedAt: a.actionDate ? new Date(a.actionDate) : null,
            raw: a as object,
            lastSyncedAt: new Date(),
          };

          const existing = await prisma.federalAward.findUnique({
            where: { awardUniqueId: a.generatedInternalId },
            select: { id: true },
          });
          await prisma.federalAward.upsert({
            where: { awardUniqueId: a.generatedInternalId },
            create: data,
            update: data,
          });
          if (existing) updated += 1;
          else inserted += 1;
        }
        if (!hasNext || results.length === 0) break;
      }
    };

    // USAspending's spending_by_award SILENTLY CAPS pagination at 10,000 results
    // per query (100 pages x 100/page) — a single 2020->today backfill window only
    // ever yields the top-10k awards, which is why federal_award plateaued ~10k.
    // Fix: adaptive date-window splitting. Before paging a backfill window, probe
    // page 100: if it is full (or the API claims more), the window holds >=10k
    // rows, so bisect it and enqueue the halves instead. Upserts are idempotent,
    // so overlap between probe and processing is harmless.
    const dayMs = 86_400_000;
    const addDays = (iso: string, d: number): string =>
      new Date(new Date(`${iso}T00:00:00Z`).getTime() + d * dayMs).toISOString().slice(0, 10);
    const daysBetween = (s: string, e: string): number =>
      Math.round((new Date(`${e}T00:00:00Z`).getTime() - new Date(`${s}T00:00:00Z`).getTime()) / dayMs);
    const windowSaturated = async (s: string, e: string): Promise<boolean> => {
      const probe = await fetchPage(s, e, 100);
      return probe.hasNext || probe.results.length === 100;
    };

    const queue: Array<[string, string]> = [[startDate, endDate]];
    while (queue.length > 0) {
      const win = queue.shift();
      if (!win) break;
      const [winStart, winEnd] = win;
      if (backfill && daysBetween(winStart, winEnd) >= 2 && (await windowSaturated(winStart, winEnd))) {
        const mid = addDays(winStart, Math.floor(daysBetween(winStart, winEnd) / 2));
        console.error(`window ${winStart}..${winEnd} holds >=10k awards — splitting at ${mid}`);
        windowsSplit += 1;
        queue.unshift([winStart, mid], [addDays(mid, 1), winEnd]);
        continue;
      }
      await processWindow(winStart, winEnd);
      windowsProcessed += 1;
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'success', rowsInserted: inserted, rowsUpdated: updated, errorCount: errors },
    });
    console.log(
      JSON.stringify(
        { source, window: { startDate, endDate }, inserted, updated, withPe, errors, windowsProcessed, windowsSplit },
        null,
        2,
      ),
    );
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'error', rowsInserted: inserted, rowsUpdated: updated, errorCount: errors + 1, errorMessage: String(err) },
    });
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
