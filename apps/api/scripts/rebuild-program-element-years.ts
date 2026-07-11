/**
 * rebuild-program-element-years.ts — one-time canonical PE-year repair.
 *
 *   tsx scripts/rebuild-program-element-years.ts            # DRY RUN (default): writes nothing
 *   tsx scripts/rebuild-program-element-years.ts --commit   # apply the rebuild
 *   tsx scripts/rebuild-program-element-years.ts --limit 25 # cap dry-run sample size
 *
 * Why: rows written before the writer fix were (a) clobbered — each ingestion
 * source overwrote the whole row, so only the last source's field survived — and
 * (b) stored in THOUSANDS while the UI renders MILLIONS (so a $477M mark showed as
 * "$477000.00m"). This rebuilds each `program_element_year` row from the per-field
 * source-value log (`program_element_year_source_value`): the highest-priority
 * source wins each field, values are normalized to millions, and per-field
 * provenance is restored to `raw` (so the FY drawer's Source/Date columns fill in).
 *
 * IMPORTANT: the log holds PRE-FIX values (thousands for real sources). Run this
 * ONCE, right after deploying the writer fix and BEFORE any post-fix re-ingestion,
 * so the thousands→millions assumption holds. It only UPDATES existing rows (never
 * deletes), and only the fields the log can prove — so it is safe to dry-run first.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  assembleYearsFromSourceLog,
  REBUILD_VALUE_FIELDS,
  type RebuildValueField,
  type SourceLogEntry,
} from '../src/program-element/rebuild/rebuild-years.js';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const num = (v: Prisma.Decimal | number | null): number | null =>
  v === null || v === undefined ? null : Number(v);

async function main(): Promise<void> {
  const commit = flag('commit');
  const sampleLimit = Number(arg('limit') ?? 20);
  const prisma = new PrismaClient();
  await prisma.$connect();

  try {
    // 1. Pull the per-field source-value log (skip the legacy `__row__` audit rows).
    const log = await prisma.programElementYearSourceValue.findMany({
      where: { fieldName: { not: '__row__' }, valueDecimal: { not: null } },
      select: {
        peCode: true,
        fy: true,
        fieldName: true,
        source: true,
        valueDecimal: true,
        recordedAt: true,
      },
    });

    const entries: SourceLogEntry[] = log.map((r) => ({
      peCode: r.peCode,
      fy: r.fy,
      fieldName: r.fieldName,
      source: r.source,
      valueDecimal: num(r.valueDecimal),
      recordedAt: r.recordedAt.toISOString(),
    }));

    const rebuilt = assembleYearsFromSourceLog(entries);

    // 2. Load the existing canonical rows so we can diff + merge raw provenance.
    const existingRows = await prisma.programElementYear.findMany({
      select: {
        peCode: true,
        fy: true,
        raw: true,
        request: true,
        hascMark: true,
        sascMark: true,
        hacDMark: true,
        sacDMark: true,
        conference: true,
        ndaaConference: true,
        enacted: true,
        reprogrammed: true,
        executed: true,
      },
    });
    const existingByKey = new Map(existingRows.map((r) => [`${r.peCode}::${r.fy}`, r]));

    let changedRows = 0;
    let missingRows = 0;
    let unchangedRows = 0;
    const samples: string[] = [];

    for (const year of rebuilt) {
      const key = `${year.peCode}::${year.fy}`;
      const existing = existingByKey.get(key);
      if (!existing) {
        missingRows += 1;
        continue;
      }

      const changedFields: Array<{ field: RebuildValueField; from: number | null; to: number }> =
        [];
      for (const field of REBUILD_VALUE_FIELDS) {
        const to = year.values[field];
        if (to === undefined) continue;
        const from = num(existing[field] as Prisma.Decimal | null);
        if (from === null || Math.abs(from - to) > 1e-6) {
          changedFields.push({ field, from, to });
        }
      }
      if (changedFields.length === 0) {
        unchangedRows += 1;
        continue;
      }
      changedRows += 1;

      if (samples.length < sampleLimit) {
        const detail = changedFields
          .map((c) => `${c.field} ${c.from ?? '∅'}→${c.to} [${year.sourceAttribution[c.field]}]`)
          .join(', ');
        samples.push(`  ${year.peCode} FY${year.fy}: ${detail}`);
      }

      if (commit) {
        const existingRaw =
          existing.raw && typeof existing.raw === 'object' && !Array.isArray(existing.raw)
            ? (existing.raw as Record<string, unknown>)
            : {};
        const mergedRaw = {
          ...existingRaw,
          fieldSources: { ...(existingRaw.fieldSources as object), ...year.fieldSources },
          sourceAttribution: {
            ...(existingRaw.sourceAttribution as object),
            ...year.sourceAttribution,
          },
          datesAdded: { ...(existingRaw.datesAdded as object), ...year.datesAdded },
        };
        const data: Prisma.ProgramElementYearUncheckedUpdateInput = {
          raw: mergedRaw as Prisma.InputJsonValue,
          lastSyncedAt: new Date(),
        };
        for (const { field, to } of changedFields) {
          (data as Record<string, unknown>)[field] = new Prisma.Decimal(to);
        }
        await prisma.programElementYear.update({
          where: { peCode_fy: { peCode: year.peCode, fy: year.fy } },
          data,
        });
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: commit ? 'COMMIT' : 'DRY-RUN',
          sourceLogEntries: entries.length,
          rebuiltYears: rebuilt.length,
          rowsChanged: changedRows,
          rowsUnchanged: unchangedRows,
          rowsInLogButMissingCanonical: missingRows,
        },
        null,
        2,
      ),
    );
    if (samples.length > 0) {
      console.log(
        `\nSample of ${samples.length} changed row(s)${commit ? ' (applied)' : ' (not applied — dry run)'}:`,
      );
      console.log(samples.join('\n'));
    }
    if (!commit && changedRows > 0) {
      console.log(
        '\nRe-run with --commit to apply. Verify the from→to magnitudes look right first.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('[rebuild-program-element-years] FAILED', err);
  process.exit(1);
});
