/**
 * Sync Senate LDA federal lobbying data into lda_* tables.
 *
 *   pnpm --filter @capiro/api sync:lda
 *   pnpm --filter @capiro/api sync:lda:incremental
 *
 * Pulls from https://lda.gov/api/v1/ (the legacy lda.senate.gov host retires
 * 2026-06-30; same /api/v1 surface, just a new domain). Anonymous access works
 * but is capped at 15 req/min; set LDA_API_KEY for 120 req/min. The key is sent
 * as an `Authorization: Token <key>` header — that is the scheme the API
 * validates (a bad token 401s); the older `x-api-key` header is ignored.
 * Full sync: ~512K filings + 192K contributions over 5 years.
 * Estimated runtime: 30-45 minutes.
 *
 * --incremental  Only fetch filings/contributions posted after the most
 *                recently synced dt_posted in lda_filing.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { buildLdaText, embedAndUpsert } from '../src/embeddings/embedder.js';

dotenvConfig();

// Per-row embed on sync. Set EMBED_ON_SYNC=0 to skip (e.g. during a heavy
// full-history backfill where you'd rather batch-embed afterward).
const EMBED_ON_SYNC = process.env.EMBED_ON_SYNC !== '0';

const LDA_BASE = 'https://lda.gov/api/v1';
const LDA_API_KEY = process.env.LDA_API_KEY ?? '';
const PAGE_SIZE = 100;
const currentYear = new Date().getFullYear();
const SYNC_YEARS = Array.from({ length: 6 }, (_, i) => currentYear - 5 + i);

// ─── LDA API types ───────────────────────────────────────────────────────────

interface LdaPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

interface LdaIssueCodeRef {
  issue_code: string;
  issue_code_display: string;
}

interface LdaGovEntityRef {
  id: number;
  name: string;
}

interface LdaLobbyistRef {
  id: number;
  prefix: string | null;
  first_name: string;
  last_name: string;
  suffix: string | null;
  covered_position: string | null;
}

interface LdaActivity {
  general_issue_code: string;
  general_issue_code_display?: string;
  description: string | null;
  lobbyists: { lobbyist: LdaLobbyistRef | null }[] | null;
  government_entities: { id: number; name: string }[] | null;
}

interface LdaFilingRaw {
  filing_uuid: string;
  filing_type: string;
  filing_year: number;
  filing_period: string | null;
  income: string | null;
  expenses: string | null;
  dt_posted: string | null;
  registrant: {
    id: number;
    name: string;
    description: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    contact_name: string | null;
    contact_phone: string | null;
    house_registrant_id: number | null;
  } | null;
  client: {
    id: number;
    name: string;
    general_description: string | null;
    state: string | null;
    country: string | null;
    effective_date: string | null;
  } | null;
  lobbying_activities: LdaActivity[] | null;
  filing_document_url: string | null;
}

interface LdaContributionRaw {
  filing_uuid: string;
  filing_type: string;
  filing_year: number;
  filing_period: string | null;
  filer_type: string | null;
  dt_posted: string | null;
  registrant: { id: number; name: string } | null;
  lobbyist: { id: number; prefix: string | null; first_name: string; last_name: string } | null;
  no_contributions: boolean | null;
  pacs: unknown[] | null;
  contribution_items: unknown[] | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ldaFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${LDA_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const hdrs: Record<string, string> = { Accept: 'application/json' };
  // LDA validates `Authorization: Token <key>` (a bad token 401s); the older
  // `x-api-key` header is silently ignored, so use the Token scheme.
  if (LDA_API_KEY) hdrs['Authorization'] = `Token ${LDA_API_KEY}`;

  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url.toString(), { headers: hdrs });
    if (resp.status === 429) {
      const wait = Math.min(2000 * Math.pow(2, attempt), 60000);
      console.warn(`[lda-sync] 429 rate limited, waiting ${wait / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      throw new Error(`LDA API ${url}: ${resp.status} ${resp.statusText}`);
    }
    return (await resp.json()) as T;
  }
  throw new Error(`LDA API ${url}: exhausted ${MAX_RETRIES} retries on 429`);
}

async function fetchAllPages<T>(
  path: string,
  extraParams: Record<string, string> = {},
  onProgress?: (fetched: number, total: number) => void,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;

  while (true) {
    const data = await ldaFetch<LdaPage<T>>(path, {
      page: String(page),
      page_size: String(PAGE_SIZE),
      ...extraParams,
    });
    all.push(...(data.results ?? []));
    if (onProgress) onProgress(all.length, data.count);
    if (!data.next) break;
    page++;
    // Rate-limit politeness: sleep 200ms between pages
    await new Promise((r) => setTimeout(r, 200));
  }

  return all;
}

function safeDecimal(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function extractIssueCodes(activities: LdaActivity[] | null | undefined): string[] {
  if (!activities) return [];
  const codes = new Set<string>();
  for (const act of activities) {
    if (act?.general_issue_code) codes.add(act.general_issue_code);
  }
  return [...codes];
}

function extractLobbyists(activities: LdaActivity[] | null | undefined): object[] {
  if (!activities) return [];
  const seen = new Set<number>();
  const result: object[] = [];
  for (const act of activities) {
    for (const entry of act?.lobbyists ?? []) {
      const lob = entry?.lobbyist;
      if (!lob?.id || seen.has(lob.id)) continue;
      seen.add(lob.id);
      result.push({
        id: lob.id,
        first_name: lob.first_name ?? '',
        last_name: lob.last_name ?? '',
        covered_position: lob.covered_position ?? null,
      });
    }
  }
  return result;
}

function extractGovEntities(activities: LdaActivity[] | null | undefined): object[] {
  if (!activities) return [];
  const seen = new Set<number>();
  const result: object[] = [];
  for (const act of activities) {
    for (const ent of act?.government_entities ?? []) {
      if (!ent?.id || seen.has(ent.id)) continue;
      seen.add(ent.id);
      result.push({ id: ent.id, name: ent.name });
    }
  }
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const incremental = process.argv.includes('--incremental');
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(`[lda-sync] starting (mode=${incremental ? 'incremental' : 'full'})`);

  try {
    await runWithSyncRun(prisma as any, 'sync-lda', async () => {
    // ── 1. Reference data: issue codes ──────────────────────────────────────
    console.log('[lda-sync] fetching issue codes');
    const issueCodesRaw = await ldaFetch<{ value: string; name: string }[]>(
      '/constants/filing/lobbyingactivityissues/',
    );
    // API returns a flat array [{value, name}], not paginated
    const issueCodes = Array.isArray(issueCodesRaw) ? issueCodesRaw : [];
    for (const ic of issueCodes) {
      try {
        await prisma.ldaIssueCode.upsert({
          where: { code: ic.value },
          update: { name: ic.name, lastSyncedAt: new Date() },
          create: { code: ic.value, name: ic.name },
        });
      } catch (err) {
        console.warn(`[lda-sync] skip issue code ${ic.value}:`, (err as Error).message);
      }
    }
    console.log(`[lda-sync] upserted ${issueCodes.length} issue codes`);

    // ── 2. Reference data: government entities ───────────────────────────────
    console.log('[lda-sync] fetching government entities');
    const govEntitiesRaw = await ldaFetch<{ id: number; name: string }[]>(
      '/constants/filing/governmententities/',
    );
    // API returns a flat array [{id, name}], not paginated
    const govEntities = Array.isArray(govEntitiesRaw) ? govEntitiesRaw : [];
    for (const ge of govEntities) {
      try {
        await prisma.ldaGovernmentEntity.upsert({
          where: { id: ge.id },
          update: { name: ge.name, lastSyncedAt: new Date() },
          create: { id: ge.id, name: ge.name },
        });
      } catch (err) {
        console.warn(`[lda-sync] skip gov entity ${ge.id}:`, (err as Error).message);
      }
    }
    console.log(`[lda-sync] upserted ${govEntities.length} government entities`);

    // ── 3. Filings ────────────────────────────────────────────────────────────
    // For incremental runs, find the latest dt_posted we already have.
    let incrementalAfter: string | null = null;
    if (incremental) {
      const latest = await prisma.ldaFiling.findFirst({
        orderBy: { dtPosted: 'desc' },
        select: { dtPosted: true },
      });
      if (latest?.dtPosted) {
        incrementalAfter = latest.dtPosted.toISOString().slice(0, 10);
        console.log(`[lda-sync] incremental mode, fetching filings after ${incrementalAfter}`);
      }
    }

    // Accumulators for client/registrant/lobbyist extraction.
    const clientMap = new Map<number, { name: string; generalDescription: string | null; state: string | null; country: string; effectiveDate: Date | null }>();
    const registrantMap = new Map<number, { name: string; description: string | null; address: string | null; city: string | null; state: string | null; country: string; contactName: string | null; contactPhone: string | null; houseRegistrantId: number | null }>();
    const lobbyistMap = new Map<number, { firstName: string; lastName: string; prefix: string | null; suffix: string | null; coveredPositions: string[]; registrantIds: Set<number>; activeYears: Set<number> }>();

    let totalFilings = 0;

    const years = incremental && incrementalAfter ? [new Date().getFullYear()] : SYNC_YEARS;

    for (const year of years) {
      const extraParams: Record<string, string> = {
        filing_year: String(year),
      };
      if (incrementalAfter) {
        extraParams['filing_dt_posted_after'] = incrementalAfter;
      }

      // Estimate total by fetching first page.
      const firstPage = await ldaFetch<LdaPage<LdaFilingRaw>>('/filings/', {
        ...extraParams,
        page: '1',
        page_size: String(PAGE_SIZE),
      });

      const yearTotal = firstPage.count;
      console.log(`[lda-sync] ${year} filings: 0/${yearTotal}`);

      let yearCount = 0;
      let page = 1;
      let results = firstPage.results ?? [];

      while (true) {
        for (const f of results) {
          try {
            const activities = f.lobbying_activities ?? [];
            const issueCodes = extractIssueCodes(activities);
            const lobbyistsList = extractLobbyists(activities);
            const govEntitiesList = extractGovEntities(activities);
            const income = safeDecimal(f.income);
            const expenses = safeDecimal(f.expenses);
            const dtPosted = safeDate(f.dt_posted);

            const filing = await prisma.ldaFiling.upsert({
              where: { filingUuid: f.filing_uuid },
              update: {
                filingType: f.filing_type,
                filingYear: f.filing_year,
                filingPeriod: f.filing_period ?? null,
                income: income,
                expenses: expenses,
                dtPosted: dtPosted,
                registrantId: f.registrant?.id ?? null,
                registrantName: f.registrant?.name ?? '',
                clientId: f.client?.id ?? null,
                clientName: f.client?.name ?? '',
                clientState: f.client?.state ?? null,
                clientCountry: f.client?.country ?? 'US',
                clientDescription: f.client?.general_description ?? null,
                issueCodes: issueCodes,
                governmentEntities: govEntitiesList,
                lobbyists: lobbyistsList,
                lobbyingActivities: activities as object[],
                filingDocumentUrl: f.filing_document_url ?? null,
                lastSyncedAt: new Date(),
              },
              create: {
                id: randomUUID(),
                filingUuid: f.filing_uuid,
                filingType: f.filing_type,
                filingYear: f.filing_year,
                filingPeriod: f.filing_period ?? null,
                income: income,
                expenses: expenses,
                dtPosted: dtPosted,
                registrantId: f.registrant?.id ?? null,
                registrantName: f.registrant?.name ?? '',
                clientId: f.client?.id ?? null,
                clientName: f.client?.name ?? '',
                clientState: f.client?.state ?? null,
                clientCountry: f.client?.country ?? 'US',
                clientDescription: f.client?.general_description ?? null,
                issueCodes: issueCodes,
                governmentEntities: govEntitiesList,
                lobbyists: lobbyistsList,
                lobbyingActivities: activities as object[],
                filingDocumentUrl: f.filing_document_url ?? null,
              },
            });

            // Per-row embed. content_hash skip in embedAndUpsert means a
            // re-sync of unchanged filings is free. Bedrock errors are
            // logged but don't abort the run.
            if (EMBED_ON_SYNC) {
              try {
                await embedAndUpsert(prisma, {
                  tenantId: null,
                  sourceType: 'lda_filing',
                  sourceId: filing.id,
                  text: buildLdaText({
                    clientName: f.client?.name ?? '',
                    clientDescription: f.client?.general_description ?? null,
                    filingYear: f.filing_year,
                    filingType: f.filing_type,
                    issueCodes,
                    lobbyingActivities: activities,
                  }),
                  bypassRls: true,
                });
              } catch (e) {
                console.error(
                  `[lda-sync] embed ${filing.id} failed:`,
                  (e as Error).message,
                );
              }
            }

            // Accumulate client data.
            if (f.client?.id) {
              const existing = clientMap.get(f.client.id);
              if (!existing) {
                clientMap.set(f.client.id, {
                  name: f.client.name,
                  generalDescription: f.client.general_description ?? null,
                  state: f.client.state ?? null,
                  country: f.client.country ?? 'US',
                  effectiveDate: safeDate(f.client.effective_date),
                });
              }
            }

            // Accumulate registrant data.
            if (f.registrant?.id) {
              if (!registrantMap.has(f.registrant.id)) {
                registrantMap.set(f.registrant.id, {
                  name: f.registrant.name,
                  description: f.registrant.description ?? null,
                  address: f.registrant.address ?? null,
                  city: f.registrant.city ?? null,
                  state: f.registrant.state ?? null,
                  country: f.registrant.country ?? 'US',
                  contactName: f.registrant.contact_name ?? null,
                  contactPhone: f.registrant.contact_phone ?? null,
                  houseRegistrantId: f.registrant.house_registrant_id ?? null,
                });
              }
            }

            // Accumulate lobbyist data.
            for (const act of activities) {
              for (const entry of act?.lobbyists ?? []) {
                const lob = entry?.lobbyist;
                if (!lob?.id) continue;
                let rec = lobbyistMap.get(lob.id);
                if (!rec) {
                  rec = {
                    firstName: lob.first_name ?? '',
                    lastName: lob.last_name ?? '',
                    prefix: lob.prefix ?? null,
                    suffix: lob.suffix ?? null,
                    coveredPositions: [],
                    registrantIds: new Set(),
                    activeYears: new Set(),
                  };
                  lobbyistMap.set(lob.id, rec);
                }
                if (lob.covered_position && !rec.coveredPositions.includes(lob.covered_position)) {
                  rec.coveredPositions.push(lob.covered_position);
                }
                if (f.registrant?.id) rec.registrantIds.add(f.registrant.id);
                if (f.filing_year) rec.activeYears.add(f.filing_year);
              }
            }

            yearCount++;
          } catch (err) {
            console.warn(
              `[lda-sync] skip filing ${f.filing_uuid}:`,
              (err as Error).message,
            );
          }
        }

        totalFilings += results.length;
        console.log(`[lda-sync] ${year} filings: ${yearCount}/${yearTotal}`);

        const nextPage = await ldaFetch<LdaPage<LdaFilingRaw>>('/filings/', {
          ...extraParams,
          page: String(++page),
          page_size: String(PAGE_SIZE),
        }).catch(() => null);

        if (!nextPage?.results?.length) break;
        results = nextPage.results;
      }

      console.log(`[lda-sync] ${year} done: ${yearCount} filings`);
    }

    console.log(`[lda-sync] total filings processed: ${totalFilings}`);

    // ── 4. Upsert clients ─────────────────────────────────────────────────────
    console.log(`[lda-sync] upserting ${clientMap.size} clients`);
    let clientCount = 0;
    for (const [id, c] of clientMap) {
      try {
        // Compute aggregates from filings.
        const agg = await prisma.ldaFiling.aggregate({
          where: { clientId: id },
          _count: { id: true },
          _sum: { income: true, expenses: true },
          _max: { filingYear: true },
        });
        const totalSpending =
          Number(agg._sum.income ?? 0) + Number(agg._sum.expenses ?? 0) || null;

        // Collect unique issue codes.
        const filingIssueCodes = await prisma.$queryRaw<{ code: string }[]>`
          SELECT DISTINCT unnest(issue_codes) AS code
          FROM lda_filing
          WHERE client_id = ${id}
        `;
        const issueCodes = filingIssueCodes.map((r) => r.code).filter(Boolean);

        await prisma.ldaClient.upsert({
          where: { id },
          update: {
            name: c.name,
            generalDescription: c.generalDescription,
            state: c.state,
            country: c.country,
            effectiveDate: c.effectiveDate,
            totalFilings: agg._count.id ?? 0,
            totalSpending: totalSpending,
            latestFilingYear: agg._max.filingYear ?? null,
            issueCodes: issueCodes,
            lastSyncedAt: new Date(),
          },
          create: {
            id,
            name: c.name,
            generalDescription: c.generalDescription,
            state: c.state,
            country: c.country,
            effectiveDate: c.effectiveDate,
            totalFilings: agg._count.id ?? 0,
            totalSpending: totalSpending,
            latestFilingYear: agg._max.filingYear ?? null,
            issueCodes: issueCodes,
          },
        });
        clientCount++;
      } catch (err) {
        console.warn(`[lda-sync] skip client ${id}:`, (err as Error).message);
      }

      if (clientCount % 5000 === 0 && clientCount > 0) {
        console.log(`[lda-sync] clients: ${clientCount}/${clientMap.size}`);
      }
    }
    console.log(`[lda-sync] upserted ${clientCount} clients`);

    // ── 5. Upsert registrants ─────────────────────────────────────────────────
    console.log(`[lda-sync] upserting ${registrantMap.size} registrants`);
    let registrantCount = 0;
    for (const [id, r] of registrantMap) {
      try {
        const filingCount = await prisma.ldaFiling.count({ where: { registrantId: id } });
        const clientCount = await prisma.ldaFiling.groupBy({
          by: ['clientId'],
          where: { registrantId: id, clientId: { not: null } },
        });

        await prisma.ldaRegistrant.upsert({
          where: { id },
          update: {
            name: r.name,
            description: r.description,
            address: r.address,
            city: r.city,
            state: r.state,
            country: r.country,
            contactName: r.contactName,
            contactPhone: r.contactPhone,
            houseRegistrantId: r.houseRegistrantId,
            totalFilings: filingCount,
            totalClients: clientCount.length,
            lastSyncedAt: new Date(),
          },
          create: {
            id,
            name: r.name,
            description: r.description,
            address: r.address,
            city: r.city,
            state: r.state,
            country: r.country,
            contactName: r.contactName,
            contactPhone: r.contactPhone,
            houseRegistrantId: r.houseRegistrantId,
            totalFilings: filingCount,
            totalClients: clientCount.length,
          },
        });
        registrantCount++;
      } catch (err) {
        console.warn(`[lda-sync] skip registrant ${id}:`, (err as Error).message);
      }
    }
    console.log(`[lda-sync] upserted ${registrantCount} registrants`);

    // ── 6. Upsert lobbyists ───────────────────────────────────────────────────
    console.log(`[lda-sync] upserting ${lobbyistMap.size} lobbyists`);
    let lobbyistCount = 0;
    for (const [id, l] of lobbyistMap) {
      try {
        const coveredPositions = l.coveredPositions
          .filter(Boolean)
          .map((p) => ({ position: p }));

        await prisma.ldaLobbyist.upsert({
          where: { id },
          update: {
            firstName: l.firstName,
            lastName: l.lastName,
            prefix: l.prefix,
            suffix: l.suffix,
            coveredPositions: coveredPositions,
            registrantIds: [...l.registrantIds],
            activeYears: [...l.activeYears].sort(),
            lastSyncedAt: new Date(),
          },
          create: {
            id,
            firstName: l.firstName,
            lastName: l.lastName,
            prefix: l.prefix,
            suffix: l.suffix,
            coveredPositions: coveredPositions,
            registrantIds: [...l.registrantIds],
            activeYears: [...l.activeYears].sort(),
          },
        });
        lobbyistCount++;
      } catch (err) {
        console.warn(`[lda-sync] skip lobbyist ${id}:`, (err as Error).message);
      }
    }
    console.log(`[lda-sync] upserted ${lobbyistCount} lobbyists`);

    // ── 7. Contributions ─────────────────────────────────────────────────────
    const contribYears = incremental && incrementalAfter
      ? [new Date().getFullYear()]
      : SYNC_YEARS;

    let totalContributions = 0;
    for (const year of contribYears) {
      const extraParams: Record<string, string> = { filing_year: String(year) };
      if (incrementalAfter) extraParams['filing_dt_posted_after'] = incrementalAfter;

      const firstPage = await ldaFetch<LdaPage<LdaContributionRaw>>('/contributions/', {
        ...extraParams,
        page: '1',
        page_size: String(PAGE_SIZE),
      });

      const yearTotal = firstPage.count;
      console.log(`[lda-sync] ${year} contributions: 0/${yearTotal}`);
      let yearCount = 0;
      let page = 1;
      let results = firstPage.results ?? [];

      while (true) {
        for (const c of results) {
          try {
            await prisma.ldaContribution.upsert({
              where: { filingUuid: c.filing_uuid },
              update: {
                filingType: c.filing_type,
                filingYear: c.filing_year,
                filingPeriod: c.filing_period ?? null,
                filerType: c.filer_type ?? 'registrant',
                dtPosted: safeDate(c.dt_posted),
                registrantId: c.registrant?.id ?? null,
                registrantName: c.registrant?.name ?? null,
                lobbyistId: c.lobbyist?.id ?? null,
                lobbyistName:
                  c.lobbyist
                    ? `${c.lobbyist.first_name ?? ''} ${c.lobbyist.last_name ?? ''}`.trim()
                    : null,
                noContributions: c.no_contributions ?? false,
                pacs: (c.pacs ?? []).filter(Boolean),
                contributionItems: (c.contribution_items ?? []).filter(Boolean),
                lastSyncedAt: new Date(),
              },
              create: {
                id: randomUUID(),
                filingUuid: c.filing_uuid,
                filingType: c.filing_type,
                filingYear: c.filing_year,
                filingPeriod: c.filing_period ?? null,
                filerType: c.filer_type ?? 'registrant',
                dtPosted: safeDate(c.dt_posted),
                registrantId: c.registrant?.id ?? null,
                registrantName: c.registrant?.name ?? null,
                lobbyistId: c.lobbyist?.id ?? null,
                lobbyistName:
                  c.lobbyist
                    ? `${c.lobbyist.first_name ?? ''} ${c.lobbyist.last_name ?? ''}`.trim()
                    : null,
                noContributions: c.no_contributions ?? false,
                pacs: (c.pacs ?? []).filter(Boolean),
                contributionItems: (c.contribution_items ?? []).filter(Boolean),
              },
            });
            yearCount++;
          } catch (err) {
            console.warn(
              `[lda-sync] skip contribution ${c.filing_uuid}:`,
              (err as Error).message,
            );
          }
        }

        totalContributions += results.length;
        console.log(`[lda-sync] ${year} contributions: ${yearCount}/${yearTotal}`);

        const nextPage = await ldaFetch<LdaPage<LdaContributionRaw>>('/contributions/', {
          ...extraParams,
          page: String(++page),
          page_size: String(PAGE_SIZE),
        }).catch(() => null);

        if (!nextPage?.results?.length) break;
        results = nextPage.results;
      }

      console.log(`[lda-sync] ${year} contributions done: ${yearCount}`);
    }
    console.log(`[lda-sync] total contributions processed: ${totalContributions}`);

    // ── 8. Update issue code aggregates ──────────────────────────────────────
    console.log('[lda-sync] computing issue code aggregates');
    for (const ic of issueCodes) {
      try {
        const filingCount = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM lda_filing
          WHERE ${ic.value} = ANY(issue_codes)
        `;
        const spendingAgg = await prisma.$queryRaw<{ total: string | null }[]>`
          SELECT SUM(COALESCE(income, 0) + COALESCE(expenses, 0)) AS total
          FROM lda_filing
          WHERE ${ic.value} = ANY(issue_codes)
        `;

        await prisma.ldaIssueCode.update({
          where: { code: ic.value },
          data: {
            totalFilings5y: Number(filingCount[0]?.count ?? 0),
            totalSpending5y: spendingAgg[0]?.total ? Number(spendingAgg[0].total) : null,
            lastSyncedAt: new Date(),
          },
        });
      } catch (err) {
        console.warn(`[lda-sync] skip issue agg ${ic.value}:`, (err as Error).message);
      }
    }
    console.log('[lda-sync] issue code aggregates done');

    // ── 9. Update government entity aggregates ────────────────────────────────
    console.log('[lda-sync] computing government entity aggregates');
    const topEntities = await prisma.$queryRaw<{ id: number; cnt: bigint }[]>`
      SELECT (ge->>'id')::int AS id, COUNT(*) AS cnt
      FROM lda_filing, jsonb_array_elements(government_entities) AS ge
      WHERE ge->>'id' IS NOT NULL
      GROUP BY 1
    `;
    for (const row of topEntities) {
      try {
        await prisma.ldaGovernmentEntity.updateMany({
          where: { id: row.id },
          data: { totalFilings5y: Number(row.cnt), lastSyncedAt: new Date() },
        });
      } catch (err) {
        console.warn(`[lda-sync] skip entity agg ${row.id}:`, (err as Error).message);
      }
    }
    console.log('[lda-sync] government entity aggregates done');

    const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
    console.log(`[lda-sync] DONE in ${elapsed}m`);
      return { inserted: totalFilings + totalContributions, updated: 0, skipped: 0, errors: 0 };
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[lda-sync] FAILED', err);
  process.exit(1);
});
