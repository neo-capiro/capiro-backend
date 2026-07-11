/**
 * Enrich federal_award rows with the DoD acquisition (MDAP) program code from the
 * USAspending AWARD DETAIL endpoint, then resolve a Program Element via the
 * reviewed program_element_acquisition_program map.
 *
 *   pnpm --filter @capiro/api enrich:award-pe -- --limit 2000
 *   tsx scripts/enrich-award-pe.ts --limit 2000 --min-amount 100000
 *   tsx scripts/enrich-award-pe.ts --refresh --limit 500     # re-read already-tagged rows (API)
 *   tsx scripts/enrich-award-pe.ts --resolve-only --commit   # re-resolve ALL stored codes vs the
 *                                                            # current map, NO API (verb: resolve-awards-from-acq-map)
 *
 * WHY: USAspending's spending_by_award SEARCH endpoint (used by sync-federal-award)
 * returns NO program element and NO acquisition program. The per-award DETAIL
 * endpoint (/api/v2/awards/<id>/) returns
 * latest_transaction_contract_data.dod_acquisition_program (+ _description) — a
 * government-assigned MDAP code (e.g. '198'/'F-35', '516'/'SSN 774'). We persist
 * that code on federal_award, then map it to a PE through the curated
 * program_element_acquisition_program table. This is the defensible PE->contractor
 * link (zero text inference); the contractor panel reads it.
 *
 * Idempotent: by default processes rows where dod_acq_program_code IS NULL,
 * highest-dollar first (those matter for the "primes on this program" view), capped
 * by --limit. Re-run (or schedule) to continue. --refresh re-reads rows that already
 * have a code (e.g. after the curated map grows) and re-resolves their PE.
 *
 * Rate: DELAY_MS between calls + exponential backoff on 429/5xx, same as
 * enrich-award-districts. Read-only against USAspending; writes only federal_award.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { AwardPeExtractorService } from '../src/program-element/extractors/award-pe-extractor.service.js';

dotenvConfig();

const DETAIL_URL = 'https://api.usaspending.gov/api/v2/awards';
const DELAY_MS = Number(process.env.USASPENDING_DELAY_MS ?? 150);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface AcqDetail {
  code: string | null;
  name: string | null;
}

/** Read the DoD acquisition program off the award detail (with backoff). */
async function fetchAcqProgram(awardId: string): Promise<AcqDetail | null> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${DETAIL_URL}/${encodeURIComponent(awardId)}/`);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1) + Math.random() * 250));
          continue;
        }
        return null;
      }
      if (!res.ok) return null;
      const d = (await res.json()) as {
        latest_transaction_contract_data?: {
          dod_acquisition_program?: string | null;
          dod_acquisition_program_description?: string | null;
        } | null;
      };
      const ctr = d.latest_transaction_contract_data ?? {};
      return {
        code: ctr.dod_acquisition_program ?? null,
        name: ctr.dod_acquisition_program_description ?? null,
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

/** Build acqProgramCode -> Set<peCode> from the curated map. */
async function loadAcqProgramMap(prisma: PrismaClient): Promise<Map<string, Set<string>>> {
  const rows = await prisma.programElementAcquisitionProgram.findMany({
    select: { acqProgramCode: true, peCode: true },
  });
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.acqProgramCode.toUpperCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(r.peCode.toUpperCase());
  }
  return map;
}

async function coverage(prisma: PrismaClient): Promise<Record<string, number>> {
  const [total, withCode, withPe] = await Promise.all([
    prisma.federalAward.count(),
    prisma.federalAward.count({ where: { dodAcqProgramCode: { not: null } } }),
    prisma.federalAward.count({ where: { peCode: { not: null } } }),
  ]);
  return { total, withAcqCode: withCode, withPeCode: withPe };
}

async function main(): Promise<void> {
  const limit = Number(arg('limit') ?? 2000);
  const minAmount = arg('min-amount') ? Number(arg('min-amount')) : null;
  const refresh = hasFlag('refresh');

  const prisma = new PrismaClient();
  await prisma.$connect();
  const extractor = new AwardPeExtractorService();
  const t0 = Date.now();

  try {
    const pes = await prisma.programElement.findMany({ select: { peCode: true } });
    const knownPeCodes = new Set(pes.map((p) => p.peCode.toUpperCase()));
    const acqMap = await loadAcqProgramMap(prisma);
    const before = await coverage(prisma);
    console.log(
      `[enrich-award-pe] limit=${limit} minAmount=${minAmount ?? 'none'} refresh=${refresh} ` +
        `knownPEs=${knownPeCodes.size} acqMapEntries=${acqMap.size} coverage=${JSON.stringify(before)}`,
    );

    // RESOLVE-ONLY: pure re-resolution against the CURRENT acq-program map, with NO
    // USAspending detail API call — the acq code is already stored on the row. For
    // every award that already has a dodAcqProgramCode, re-run resolvePe and set
    // pe_code where it resolves. This realizes the FULL existing-map coverage instantly
    // (the API-based enrich only walks --limit batches, one detail call each), and is
    // the fast way to apply a grown curated map across the whole backlog. Idempotent;
    // never clobbers an existing resolution with null. Dry-run unless --commit.
    if (hasFlag('resolve-only')) {
      const commit = hasFlag('commit');
      const BATCH = 2000;
      let scanned = 0;
      let resolved = 0;
      let updated = 0;
      let cursor: string | undefined;
      for (;;) {
        const batch = await prisma.federalAward.findMany({
          where: { dodAcqProgramCode: { not: null } },
          select: { id: true, description: true, dodAcqProgramCode: true, peCode: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        if (batch.length === 0) break;
        for (const row of batch) {
          scanned += 1;
          const r = extractor.resolvePe(
            { description: row.description, dodAcqProgramCode: row.dodAcqProgramCode },
            knownPeCodes,
            acqMap,
          );
          if (!r) continue;
          resolved += 1;
          if (row.peCode === r.peCode) continue; // already resolved to the same PE
          if (commit) {
            await prisma.federalAward.update({
              where: { id: row.id },
              data: { peCode: r.peCode, peCodeSource: r.source },
            });
          }
          updated += 1;
        }
        cursor = batch[batch.length - 1]!.id;
        if (batch.length < BATCH) break;
      }
      const after = await coverage(prisma);
      console.log(
        `[enrich-award-pe] RESOLVE-ONLY done (${commit ? 'COMMIT' : 'DRY-RUN'}): ` +
          `scanned=${scanned} resolvedByMap=${resolved} peCodeUpdates=${updated} ` +
          `coverageBefore=${JSON.stringify(before)} coverageAfter=${JSON.stringify(after)} ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return;
    }

    const rows = await prisma.federalAward.findMany({
      where: {
        ...(refresh ? {} : { dodAcqProgramCode: null }),
        ...(minAmount != null ? { amount: { gte: minAmount } } : {}),
      },
      select: { id: true, awardUniqueId: true, description: true },
      orderBy: { amount: 'desc' },
      take: limit,
    });
    console.log(`[enrich-award-pe] ${rows.length} award(s) to process`);

    let taggedCode = 0;
    let resolvedPe = 0;
    let noData = 0;
    let failed = 0;
    for (const row of rows) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const acq = await fetchAcqProgram(row.awardUniqueId);
      if (!acq) {
        failed += 1;
        continue;
      }
      if (!acq.code) {
        noData += 1;
        continue;
      }
      // Resolve PE via the tiered resolver (acq-program tier + description fallback).
      const resolved = extractor.resolvePe(
        { description: row.description, dodAcqProgramCode: acq.code },
        knownPeCodes,
        acqMap,
      );
      // pe_code is VARCHAR(16) (matching program_element + the isValidPeCode canon),
      // so variable-length Defense-Wide (e.g. 0604122D8Z) and Space Force (e.g.
      // 1203940SF) codes store directly. `resolved` is already gated by the resolver's
      // isValidPeCode check; a per-row try/catch still backstops any other write error
      // so one bad award can't kill the batch.
      try {
        await prisma.federalAward.update({
          where: { id: row.id },
          data: {
            dodAcqProgramCode: acq.code,
            dodAcqProgramName: acq.name ?? undefined,
            // Only set pe_code/source when we resolved one — never clobber an
            // existing resolution with null.
            ...(resolved ? { peCode: resolved.peCode, peCodeSource: resolved.source } : {}),
          },
        });
      } catch (err) {
        failed += 1;
        console.warn(`[enrich-award-pe] update failed for ${row.id}: ${(err as Error).message}`);
        continue;
      }
      taggedCode += 1;
      if (resolved) resolvedPe += 1;
      if (taggedCode % 100 === 0) {
        console.log(
          `[enrich-award-pe] tagged=${taggedCode} resolvedPe=${resolvedPe} noData=${noData} failed=${failed}`,
        );
      }
    }

    const after = await coverage(prisma);
    console.log(
      JSON.stringify(
        {
          processed: rows.length,
          taggedCode,
          resolvedPe,
          noData,
          failed,
          coverageBefore: before,
          coverageAfter: after,
          seconds: ((Date.now() - t0) / 1000).toFixed(1),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('[enrich-award-pe] FAILED', err);
  process.exit(1);
});
