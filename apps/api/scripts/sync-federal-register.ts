/**
 * Sync Federal Register documents into federal_register_document table.
 *
 *   pnpm --filter @capiro/api sync:federal-register
 *
 * Source: https://www.federalregister.gov/api/v1/, no auth required.
 * Fetches all documents since 2021-01-01 (RULE, PROPOSED_RULE, NOTICE, PRESIDENTIAL_DOCUMENT).
 * Estimated: ~250K documents, ~4-6 hours.
 *
 * Upserts by document_number.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  canonicalDocumentNumber,
  dateOnly,
  FR_API,
} from '../src/federal-register/effective-date-evidence.js';
import { persistFederalRegisterObservation } from '../src/federal-register/federal-register-observation.js';

dotenvConfig();

const BASE_URL = `${FR_API}.json`;
const REFRESH_EFFECTIVE_DATES = process.argv.includes('--refresh-effective-dates');
// Default historical window when no DB checkpoint exists.
const DEFAULT_START_DATE = '2021-01-01';
const PER_PAGE = 100;
// Incremental: use only complete protocol-qualified SyncRun receipts.
// Partial document upserts never move the publication floor past an unseen tail.
const INCREMENTAL =
  process.argv.includes('--incremental') || process.env.FR_SYNC_INCREMENTAL === '1';
const SINCE_OVERRIDE = (() => {
  const i = process.argv.indexOf('--since');
  return i >= 0 ? process.argv[i + 1] : process.env.FR_SYNC_SINCE;
})();

interface FRAgency {
  name: string;
  [key: string]: unknown;
}

interface FRDocument {
  document_number: string;
  type: string;
  title: string;
  abstract: string | null;
  agencies: FRAgency[] | null;
  publication_date: string;
  comments_close_on: string | null;
  effective_on: unknown;
  correction_of?: unknown;
  corrections?: unknown;
  docket_ids: string[] | null;
  cfr_references:
    | { cfr_reference: string; [k: string]: unknown }[]
    | { title: number; part: number; [k: string]: unknown }[]
    | null;
  html_url: string | null;
  pdf_url: string | null;
  topics: string[] | null;
  significant: boolean | null;
}

interface FRResponse {
  count: number;
  next_page_url: string | null;
  results: FRDocument[];
  observedAt: Date;
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function normType(type: string): string {
  const map: Record<string, string> = {
    Rule: 'RULE',
    'Proposed Rule': 'PROPOSED_RULE',
    Notice: 'NOTICE',
    'Presidential Document': 'PRESIDENTIAL_DOCUMENT',
  };
  return map[type] ?? type.toUpperCase().replace(/\s+/g, '_');
}

function extractCfrRefs(raw: FRDocument['cfr_references']): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      if (typeof r === 'object' && r !== null) {
        if ('cfr_reference' in r && typeof r.cfr_reference === 'string') return r.cfr_reference;
        if ('title' in r && 'part' in r) return `${r.title} CFR ${r.part}`;
      }
      return String(r);
    })
    .filter(Boolean);
}

async function fetchPage(page: number, startDate: string): Promise<FRResponse | null> {
  const url = new URL(BASE_URL);
  url.searchParams.set('conditions[publication_date][gte]', startDate);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('order', 'newest');
  url.searchParams.set('fields[]', 'document_number');
  url.searchParams.append('fields[]', 'type');
  url.searchParams.append('fields[]', 'title');
  url.searchParams.append('fields[]', 'abstract');
  url.searchParams.append('fields[]', 'agencies');
  url.searchParams.append('fields[]', 'publication_date');
  url.searchParams.append('fields[]', 'comments_close_on');
  url.searchParams.append('fields[]', 'effective_on');
  url.searchParams.append('fields[]', 'correction_of');
  url.searchParams.append('fields[]', 'corrections');
  url.searchParams.append('fields[]', 'docket_ids');
  url.searchParams.append('fields[]', 'cfr_references');
  url.searchParams.append('fields[]', 'html_url');
  url.searchParams.append('fields[]', 'pdf_url');
  url.searchParams.append('fields[]', 'topics');
  url.searchParams.append('fields[]', 'significant');

  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const observedAt = new Date();
      const resp = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        redirect: 'error',
      });
      if (resp.status === 429) {
        const wait = Math.min(5000 * attempt, 60000);
        console.warn(`[fr-sync] 429 rate limited, waiting ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      return { ...((await resp.json()) as FRResponse), observedAt };
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(
          `[fr-sync] page ${page} failed after ${MAX_RETRIES} attempts:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

/** Re-read existing rule identities; a publication watermark cannot discover old corrections. */
async function refreshEffectiveDates(prisma: PrismaClient) {
  await runWithSyncRun(prisma as any, 'sync-federal-register-effective-dates', async () => {
    const upper = await prisma.federalRegisterDocument.findFirst({
      where: { type: 'RULE' },
      orderBy: { documentNumber: 'desc' },
      select: { documentNumber: true },
    });
    let cursor = '';
    let processed = 0;
    let errors = 0;
    let stale = 0;
    while (upper) {
      const batch = await prisma.federalRegisterDocument.findMany({
        where: { type: 'RULE', documentNumber: { gt: cursor, lte: upper.documentNumber } },
        orderBy: { documentNumber: 'asc' },
        take: 100,
        select: { documentNumber: true },
      });
      if (!batch.length) break;
      for (const row of batch) {
        cursor = row.documentNumber;
        try {
          if (!canonicalDocumentNumber(row.documentNumber))
            throw new Error('Invalid stored document identity');
          const observedAt = new Date();
          const response = await fetch(`${FR_API}/${row.documentNumber}.json`, {
            headers: { Accept: 'application/json' },
            redirect: 'error',
          });
          if (!response.ok) throw new Error(`Federal Register detail HTTP ${response.status}`);
          const doc = (await response.json()) as FRDocument;
          if (doc.document_number !== row.documentNumber || !dateOnly(doc.publication_date)) {
            throw new Error('Federal Register detail identity/date mismatch');
          }
          const outcome = await persistFederalRegisterObservation(prisma, doc, observedAt, {
            documentNumber: row.documentNumber,
            type: normType(doc.type),
            title: doc.title ?? '',
            abstract: doc.abstract ?? null,
            agencyNames: (doc.agencies ?? []).map((a) => a.name).filter(Boolean),
            publicationDate: new Date(doc.publication_date),
            commentEndDate: safeDate(doc.comments_close_on),
            docketIds: (doc.docket_ids ?? []).filter(Boolean),
            cfrReferences: extractCfrRefs(doc.cfr_references),
            htmlUrl: doc.html_url ?? null,
            pdfUrl: doc.pdf_url ?? null,
            topics: (doc.topics ?? []).filter(Boolean),
            significantRule: doc.significant ?? false,
          });
          if (outcome === 'stale') stale++;
          else processed++;
        } catch (error) {
          errors++;
          console.warn(
            '[fr-effective-refresh]',
            row.documentNumber,
            error instanceof Error ? error.message : error,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return {
      inserted: 0,
      updated: processed,
      skipped: stale,
      errors,
      stats: {
        schemaVersion: 1,
        scope: 'existing_rule_catalog',
        upperDocumentNumber: upper?.documentNumber ?? null,
        processedDocuments: processed,
        staleObservations: stale,
        allFederalRules: false,
        parsedFullDatesSection: false,
        separatelyIssuedCorrectionsResolved: false,
      },
    };
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-federal-register.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();

  // Only a proven complete ordinary source window may advance automatic ingestion.
  // Partial upserts and legacy/explicit --since runs cannot become a checkpoint.
  let startDate: string = DEFAULT_START_DATE;
  if (SINCE_OVERRIDE) {
    const valid = dateOnly(SINCE_OVERRIDE);
    if (!valid) throw new Error('--since must be an exact YYYY-MM-DD date');
    startDate = valid;
  } else if (INCREMENTAL) {
    const checkpoint = await prisma.syncRun.findFirst({
      where: {
        source: 'sync-federal-register',
        status: 'success',
        AND: [
          { stats: { path: ['schemaVersion'], equals: 1 } },
          { stats: { path: ['scope'], equals: 'publication_window' } },
          { stats: { path: ['incrementalCheckpointEligible'], equals: true } },
        ],
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    if (checkpoint?.startedAt) startDate = checkpoint.startedAt.toISOString().slice(0, 10);
  }
  console.log('[fr-sync] starting Federal Register sync from', startDate);

  try {
    if (REFRESH_EFFECTIVE_DATES) {
      await refreshEffectiveDates(prisma);
      return;
    }
    await runWithSyncRun(
      prisma as any,
      'sync-federal-register',
      async (_ctx) => {
        // Fetch first page to get total count.
        const firstPage = await fetchPage(1, startDate);
        if (!firstPage) throw new Error('Failed to fetch first page');

        const totalDocs = firstPage.count;
        const totalPages = Math.ceil(totalDocs / PER_PAGE);
        console.log(
          `[fr-sync] total documents: ${totalDocs.toLocaleString()}, pages: ${totalPages}`,
        );

        let processed = 0;
        let upserted = 0;
        let errored = 0;
        let complete = true;
        const observedNumbers = new Set<string>();

        const processPage = async (docs: FRDocument[], observedAt: Date) => {
          for (const doc of docs) {
            try {
              if (
                !canonicalDocumentNumber(doc.document_number) ||
                !dateOnly(doc.publication_date) ||
                observedNumbers.has(doc.document_number)
              ) {
                errored++;
                continue;
              }
              observedNumbers.add(doc.document_number);
              const agencyNames = (doc.agencies ?? []).map((a) => a.name).filter(Boolean);
              const docketIds = (doc.docket_ids ?? []).filter(Boolean);
              const cfrRefs = extractCfrRefs(doc.cfr_references);
              const topics = (doc.topics ?? []).filter(Boolean);

              const outcome = await persistFederalRegisterObservation(prisma, doc, observedAt, {
                documentNumber: doc.document_number,
                type: normType(doc.type),
                title: doc.title ?? '',
                abstract: doc.abstract ?? null,
                agencyNames,
                publicationDate: new Date(doc.publication_date),
                commentEndDate: safeDate(doc.comments_close_on),
                docketIds,
                cfrReferences: cfrRefs,
                htmlUrl: doc.html_url ?? null,
                pdfUrl: doc.pdf_url ?? null,
                topics,
                significantRule: doc.significant ?? false,
              });
              if (outcome === 'stale') continue;
              upserted++;
            } catch (err) {
              errored++;
              console.warn(
                `[fr-sync] skip doc ${doc.document_number}:`,
                err instanceof Error ? err.message : err,
              );
            }
            processed++;
          }
        };

        // Process first page.
        await processPage(firstPage.results ?? [], firstPage.observedAt);
        console.log(`[fr-sync] page 1/${totalPages}, ${processed.toLocaleString()} processed`);

        // Process remaining pages.
        for (let page = 2; page <= totalPages; page++) {
          const data = await fetchPage(page, startDate);
          if (!data?.results?.length) {
            console.warn(`[fr-sync] empty results on page ${page}, stopping`);
            complete = false;
            break;
          }
          if (data.count !== totalDocs) complete = false;
          await processPage(data.results, data.observedAt);

          if (page % 50 === 0) {
            const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
            console.log(
              `[fr-sync] page ${page}/${totalPages}, ${processed.toLocaleString()} processed, ${elapsed}m elapsed`,
            );
          }

          // Polite delay: 500ms between pages (~200 req/min, well under limits)
          await new Promise((r) => setTimeout(r, 500));
        }

        const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
        console.log(
          `[fr-sync] DONE, ${upserted.toLocaleString()} upserted, ${errored} errors, ${elapsed}m`,
        );
        return {
          inserted: 0,
          updated: upserted,
          skipped: 0,
          errors: errored,
          complete: complete && observedNumbers.size === totalDocs,
          incompleteReason: 'Publication-date window was not fully received without duplicates',
          stats: {
            schemaVersion: 1,
            scope: 'publication_window',
            incrementalCheckpointEligible:
              !SINCE_OVERRIDE && complete && observedNumbers.size === totalDocs && errored === 0,
            publicationFrom: startDate,
            expectedDocuments: totalDocs,
            observedDocuments: observedNumbers.size,
            historicalCorrectionRefresh: false,
            allFederalRules: false,
          },
        };
      },
      { overrideSince: startDate ?? null },
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fr-sync] FAILED', err);
    process.exit(1);
  });
}
