/**
 * Idempotent existing-row geography repair for CPF/CDS canonical rows ingested
 * before the strict STDD normalizer (#1724). Re-derives `requester_state` via
 * `normalizeCommunityFundingGeography` — the SAME normalizer used by ingest.
 *
 *   tsx scripts/repair-cpf-cds-existing-geography.ts                  # dry run
 *   tsx scripts/repair-cpf-cds-existing-geography.ts --commit --expected-eligible <n>
 *   tsx scripts/repair-cpf-cds-existing-geography.ts --fiscal-year 2026 --limit 100
 *   tsx scripts/repair-cpf-cds-existing-geography.ts --manifest /tmp/cpf-repair.json
 *
 * SAFE: only fills NULL `requester_state` (never touches `requester_district` —
 * it must stay byte-identical to what `parseHouseXlsxRows` persisted, the raw
 * uppercased STDD token). Never overwrites non-null geography, never creates/
 * duplicates rows, never touches amounts, never assigns Senate requests a
 * district. Dry-run by default; commit guarded by --expected-eligible
 * exact-count gate. Idempotent: a second run reports 0 eligible rows.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import { buildRepairPlan } from '../src/government-data/community-funding/community-funding.geography-repair.js';

const SOURCE = 'repair-cpf-cds-existing-geography';

// ---- argument parsing (matching precedent scripts) ----

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

// ---- main ----

async function main(): Promise<void> {
  const commit = flag('commit');
  const manifestPath = value('manifest') ?? null;
  const fiscalYear = value('fiscal-year') ? Number(value('fiscal-year')) : null;
  const limit = value('limit') ? Number(value('limit')) : null;
  const expectedEligible = value('expected-eligible') ? Number(value('expected-eligible')) : null;

  if (commit && expectedEligible == null) {
    console.error('--commit requires --expected-eligible <n> (explicit expected-count gate)');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    // ---- Query candidate rows ----
    const where: Record<string, unknown> = {
      chamber: 'house',
    };
    if (fiscalYear != null) {
      where.fiscalYear = fiscalYear;
    }

    const candidates = await prisma.communityFundingRequest.findMany({
      where,
      select: {
        id: true,
        identityHash: true,
        chamber: true,
        fiscalYear: true,
        requesterState: true,
        requesterDistrict: true,
        state: true,
      },
      orderBy: { id: 'asc' },
      ...(limit != null ? { take: limit } : {}),
    });

    console.log(
      `[${SOURCE}] Found ${candidates.length} House canonical rows` +
        (fiscalYear != null ? ` for FY${fiscalYear}` : '') +
        (limit != null ? ` (limit ${limit})` : ''),
    );

    // Also fetch Senate rows for the manifest (informational, never repaired)
    const senateWhere: Record<string, unknown> = { chamber: 'senate' };
    if (fiscalYear != null) {
      senateWhere.fiscalYear = fiscalYear;
    }
    const senateRows = await prisma.communityFundingRequest.findMany({
      where: senateWhere,
      select: {
        id: true,
        identityHash: true,
        chamber: true,
        fiscalYear: true,
        requesterState: true,
        requesterDistrict: true,
        state: true,
      },
      orderBy: { id: 'asc' },
      ...(limit != null ? { take: limit } : {}),
    });

    // ---- Fetch source occurrence data for each candidate ----
    const allCandidateIds = [
      ...candidates.map((r) => r.id),
      ...senateRows.map((r) => r.id),
    ];

    const sourceRows =
      allCandidateIds.length > 0
        ? await prisma.communityFundingRequestSource.findMany({
            where: { requestId: { in: allCandidateIds } },
            select: { id: true, requestId: true, sourceDocumentId: true },
          })
        : [];

    const sourceMap = new Map<string, { ids: string[]; docIds: string[] }>();
    for (const s of sourceRows) {
      const entry = sourceMap.get(s.requestId) ?? { ids: [], docIds: [] };
      entry.ids.push(s.id);
      entry.docIds.push(s.sourceDocumentId);
      sourceMap.set(s.requestId, entry);
    }

    // ---- Build repair plan ----
    const allRows = [
      ...candidates.map((r) => {
        const src = sourceMap.get(r.id) ?? { ids: [], docIds: [] };
        return {
          id: r.id,
          identityHash: r.identityHash,
          chamber: r.chamber as 'house' | 'senate',
          fiscalYear: r.fiscalYear,
          requesterState: r.requesterState,
          requesterDistrict: r.requesterDistrict,
          state: r.state,
          sourceOccurrenceIds: src.ids,
          sourceDocumentIds: src.docIds,
        };
      }),
      ...senateRows.map((r) => {
        const src = sourceMap.get(r.id) ?? { ids: [], docIds: [] };
        return {
          id: r.id,
          identityHash: r.identityHash,
          chamber: r.chamber as 'house' | 'senate',
          fiscalYear: r.fiscalYear,
          requesterState: r.requesterState,
          requesterDistrict: r.requesterDistrict,
          state: r.state,
          sourceOccurrenceIds: src.ids,
          sourceDocumentIds: src.docIds,
        };
      }),
    ];

    const plan = buildRepairPlan(allRows);

    // ---- Output JSON manifest ----
    const manifest = {
      source: SOURCE,
      timestamp: new Date().toISOString(),
      mode: commit ? 'COMMIT' : 'DRY RUN',
      summary: plan.summary,
      beforeAfterByGroup: plan.beforeAfterByGroup,
      eligibleByFiscalYear: plan.eligibleByFiscalYear,
      rows: plan.rows.map((r) => ({
        requestId: r.requestId,
        identityHash: r.identityHash,
        chamber: r.chamber,
        fiscalYear: r.fiscalYear,
        sourceOccurrenceIds: r.sourceOccurrenceIds,
        sourceDocumentIds: r.sourceDocumentIds,
        originalRawToken: r.originalRawToken,
        before: { state: r.beforeState, district: r.beforeDistrict },
        after: { state: r.afterState, district: r.afterDistrict },
        classification: r.classification,
        reason: r.reason,
      })),
    };

    if (manifestPath) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      console.log(`[${SOURCE}] Manifest written to ${manifestPath}`);
    } else {
      const tmpPath = process.env.TMPDIR ?? '/tmp';
      const defaultPath = `${tmpPath}/cpf-cds-geography-repair-${Date.now()}.json`;
      fs.writeFileSync(defaultPath, JSON.stringify(manifest, null, 2), 'utf8');
      console.log(`[${SOURCE}] Manifest written to ${defaultPath}`);
    }

    // ---- Console report ----
    console.log(`\n[${SOURCE}] Classification summary:`);
    console.log(`  eligible:            ${plan.summary.eligible}`);
    console.log(`  already_normalized:  ${plan.summary.already_normalized}`);
    console.log(`  invalid:             ${plan.summary.invalid}`);
    console.log(`  conflicting:         ${plan.summary.conflicting}`);
    console.log(`  senate_statewide:    ${plan.summary.senate_statewide}`);
    console.log(`  total:               ${plan.summary.total}`);

    if (plan.eligibleByFiscalYear.length > 0) {
      console.log(`\n[${SOURCE}] Eligible by fiscal year:`);
      for (const fy of plan.eligibleByFiscalYear) {
        console.log(`  FY${fy.fiscalYear}: ${fy.count}`);
      }
    }

    // Print eligible rows
    if (plan.summary.eligible > 0) {
      console.log(`\n[${SOURCE}] Eligible rows:`);
      for (const row of plan.rows) {
        if (row.classification !== 'eligible') continue;
        console.log(
          `  ${row.requestId} | ${row.identityHash.slice(0, 8)}... | ` +
            `before: (${row.beforeState ?? 'null'}, ${row.beforeDistrict ?? 'null'}) -> ` +
            `after: (${row.afterState}, ${row.afterDistrict}) | ` +
            `raw token: ${row.originalRawToken} (district untouched)`,
        );
      }
    }

    // Print conflicting rows
    if (plan.summary.conflicting > 0) {
      console.log(`\n[${SOURCE}] Conflicting rows (NOT repaired):`);
      for (const row of plan.rows) {
        if (row.classification !== 'conflicting') continue;
        console.log(
          `  ${row.requestId} | existing: (${row.beforeState ?? 'null'}, ${row.beforeDistrict ?? 'null'}) | ` +
            `${row.reason}`,
        );
      }
    }

    // ---- Commit mode ----
    if (commit) {
      const eligibleCount = plan.summary.eligible;
      if (eligibleCount !== expectedEligible) {
        console.error(
          `\n[${SOURCE}] REFUSED: --expected-eligible=${expectedEligible} but actual eligible count is ${eligibleCount}`,
        );
        process.exit(1);
      }

      console.log(`\n[${SOURCE}] Committing ${eligibleCount} eligible repair(s)...`);

      let repaired = 0;
      for (const row of plan.rows) {
        if (row.classification !== 'eligible') continue;

        // Optimistic concurrency: WHERE id = $1 AND requester_state IS NULL
        // AND requester_district = row.beforeDistrict (raw token, unchanged).
        // Only requester_state is written; requester_district stays untouched.
        const result = await prisma.communityFundingRequest.updateMany({
          where: {
            id: row.requestId,
            requesterState: null,
            requesterDistrict: row.beforeDistrict,
          },
          data: {
            requesterState: row.afterState,
            // NOTE: requesterDistrict is intentionally NOT written — it must
            // stay byte-identical (the raw uppercased STDD token).
          },
        });

        if (result.count === 0) {
          console.error(
            `[${SOURCE}] FAILED: row ${row.requestId} changed since dry-run — ` +
              `expected requester_state IS NULL AND requester_district = '${row.beforeDistrict}', aborting`,
          );
          process.exit(1);
        }

        repaired++;
      }

      console.log(`[${SOURCE}] Repaired ${repaired} row(s).`);
      console.log(
        `[${SOURCE}] Verify idempotency: re-run without --commit — eligible should now be 0.`,
      );
    } else {
      console.log(
        `\n[${SOURCE}] DRY RUN — pass --commit --expected-eligible ${plan.summary.eligible} to persist`,
     );
   }
 } finally {
   await prisma.$disconnect();
 }
}

// Direct execution guard (matches precedent: repair-facility-district-codes.ts)
const direct = /repair-cpf-cds-existing-geography(\\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\\\/g, '/'),
);
if (direct) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exit(1);
  });
}

export { main };