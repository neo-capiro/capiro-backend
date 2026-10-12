/**
 * Sync FARA (Foreign Agents Registration Act) active registrants.
 *
 *   pnpm --filter @capiro/api sync:fara
 *
 * Source: DOJ FARA eFiling public API, Active Registrants resource:
 *   https://efile.fara.gov/api/v1/Registrants/json/Active
 *
 * History: the old `/api/v1/ActiveRegistrants` and `/api/v2/ActiveRegistrants`
 * paths this script used now 404 (verified 2026-06). The live resource is
 * `/api/v1/Registrants/json/Active`, which returns the shape:
 *
 *   { "REGISTRANTS_ACTIVE": { "ROW": [ {Registration_Number, Name,
 *       Registration_Date, Address_1, Address_2, City, State, Zip,
 *       Business_Name}, ... ] } }
 *
 * NOTE: this resource is the registrant DIRECTORY only — it does NOT carry
 * foreign-principal / country / termination data (those live behind separate
 * per-registrant document lookups that are not currently reachable as a bulk
 * feed). So `foreignPrincipal` is stored as a sentinel and country/status-detail
 * are left null. All rows in this resource are active by definition.
 *
 * No auth required.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const FP_UNSPECIFIED = '(not specified in FARA active-registrants feed)';

// Try in order; first one that yields rows wins. Primary is the live resource;
// the legacy paths are kept as fallbacks in case DOJ restores/redirects them.
const FARA_SOURCES = [
  'https://efile.fara.gov/api/v1/Registrants/json/Active',
  'https://efile.fara.gov/api/v1/ActiveRegistrants',
  'https://efile.fara.gov/api/v2/ActiveRegistrants',
];

// Raw row as returned by the eFiling API (PascalCase, snake-segmented).
interface FaraRegistrantRow {
  Registration_Number?: string | number;
  Name?: string;
  Business_Name?: string;
  Registration_Date?: string;
  Address_1?: string;
  Address_2?: string;
  City?: string;
  State?: string;
  Zip?: string | number;
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  // FARA dates are MM/DD/YYYY; new Date() parses that reliably.
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function str(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Compose a single-line address from the parts the feed provides. */
function composeAddress(r: FaraRegistrantRow): string | null {
  const cityState = [str(r.City)?.replace(/,\s*$/, ''), str(r.State)]
    .filter(Boolean)
    .join(', ');
  const parts = [
    str(r.Address_1),
    str(r.Address_2),
    [cityState, str(r.Zip)].filter(Boolean).join(' ').trim() || null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Normalize the various possible response envelopes to a flat row array.
 * Live shape: { REGISTRANTS_ACTIVE: { ROW: [...] } }  (ROW may be a single
 * object when there is exactly one registrant — coerce to array).
 * Legacy shapes: { registrants: [...] } | { results: [...] } | [...]
 */
function extractRows(data: any): FaraRegistrantRow[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  const active = data.REGISTRANTS_ACTIVE;
  if (active) {
    const row = active.ROW ?? active;
    if (Array.isArray(row)) return row;
    if (row && typeof row === 'object') return [row];
  }

  const legacy = data.registrants ?? data.results ?? data.ROW;
  if (Array.isArray(legacy)) return legacy;
  if (legacy && typeof legacy === 'object') return [legacy];

  return [];
}

async function fetchRegistrants(): Promise<FaraRegistrantRow[]> {
  for (const url of FARA_SOURCES) {
    try {
      console.log(`[fara-sync] trying ${url}`);
      const resp = await fetch(url, {
        headers: {
          Accept: 'application/json',
          // FARA WAF rejects the default node fetch UA on some paths.
          'User-Agent': 'Mozilla/5.0 (compatible; CapiroIngest/1.0)',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) {
        console.warn(`[fara-sync] ${url}: HTTP ${resp.status}`);
        continue;
      }
      const data = (await resp.json()) as any;
      const rows = extractRows(data);
      if (rows.length > 0) {
        console.log(`[fara-sync] got ${rows.length} rows from ${url}`);
        return rows;
      }
      console.warn(`[fara-sync] ${url}: 200 OK but 0 rows after parse`);
    } catch (err) {
      console.warn(`[fara-sync] ${url}: ${(err as Error).message}`);
    }
  }
  return [];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-fara.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[fara-sync] starting');

  try {
    await runWithSyncRun(prisma as any, 'sync-fara', async () => {
      const rows = await fetchRegistrants();

      if (rows.length === 0) {
        console.warn(
          '[fara-sync] no FARA source returned rows; skipping. Check that ' +
            'https://efile.fara.gov/api/v1/Registrants/json/Active still resolves.',
        );
        console.log(
          '[fara-sync] DONE (no data) in ' +
            ((Date.now() - t0) / 1000).toFixed(1) +
            's',
        );
        return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
      }

      console.log(`[fara-sync] processing ${rows.length} active registrants`);

      // Pre-load which registration numbers already exist and whether they
      // carry a real foreign-principal value, in ONE query. This lets us:
      //   (a) count inserts vs updates accurately, and
      //   (b) avoid clobbering an enriched foreignPrincipal with the sentinel.
      const regNos = rows
        .map((r) => str(r.Registration_Number))
        .filter((v): v is string => !!v);
      const existing = await prisma.faraRegistration.findMany({
        where: { registrationNumber: { in: regNos } },
        select: { registrationNumber: true, foreignPrincipal: true },
      });
      const existingFp = new Map(
        existing.map((e) => [e.registrationNumber, e.foreignPrincipal]),
      );

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let errors = 0;

      for (const r of rows) {
        const regNo = str(r.Registration_Number);
        if (!regNo) {
          skipped++;
          continue;
        }

        const registrantName = str(r.Name) ?? str(r.Business_Name) ?? 'Unknown';
        const address = composeAddress(r);
        const state = str(r.State);
        const regDate = safeDate(r.Registration_Date);
        const isExisting = existingFp.has(regNo);
        // Only set the sentinel when there is no existing real value, so a
        // future foreign-principal enrichment is never overwritten.
        const priorFp = existingFp.get(regNo);
        const keepFp = priorFp && priorFp !== FP_UNSPECIFIED;

        try {
          await prisma.faraRegistration.upsert({
            where: { registrationNumber: regNo },
            update: {
              registrantName,
              ...(keepFp ? {} : { foreignPrincipal: FP_UNSPECIFIED }),
              status: 'Active',
              registrationDate: regDate,
              address,
              state,
              syncedAt: new Date(),
            },
            create: {
              registrationNumber: regNo,
              registrantName,
              foreignPrincipal: FP_UNSPECIFIED,
              status: 'Active',
              registrationDate: regDate,
              address,
              state,
            },
          });
          if (isExisting) updated++;
          else inserted++;
        } catch (err) {
          errors++;
          console.warn(
            `[fara-sync] upsert failed for reg ${regNo}: ${(err as Error).message}`,
          );
        }

        if ((inserted + updated) % 200 === 0) {
          console.log(`[fara-sync]   ${inserted + updated} processed...`);
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[fara-sync] inserted: ${inserted}, updated: ${updated}, skipped(no reg#): ${skipped}, errors: ${errors}`,
      );
      console.log(`[fara-sync] DONE in ${elapsed}s`);
      return { inserted, updated, skipped, errors };
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[fara-sync] FAILED', err);
  process.exit(1);
});
}
