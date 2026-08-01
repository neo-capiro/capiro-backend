/**
 * repair-pe-thousands-as-millions.ts — C1 units firebreak live residual.
 *
 * Fixes canonical program_element_year money fields that store the printed
 * THOUSANDS figure as if it were already millions (e.g. request=133334 when
 * PDF says 133,334 thousands → correct millions = 133.334).
 *
 * THIS IS NOT normalize-pe-units.ts (that divides by 1e6 for raw DOLLARS).
 * This path divides by 1e3 only.
 *
 * Default DRY-RUN. Commit:
 *   tsx scripts/repair-pe-thousands-as-millions.ts --commit --approved-count <N>
 *
 * Also divides matching observation value_decimal rows for the same
 * pe/fy/field when abs(value) equals the pre-repair canonical (so winners
 * stay consistent). Never invents PE codes — only magnitude repair.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

dotenvConfig();

const MONEY_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];

/** Above any real PE request in $M; at/above printed-thousands mis-scale floor. */
const THRESHOLD_M = 100_000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface PlanRow {
  peCode: string;
  fy: number;
  field: MoneyField;
  before: number;
  after: number;
  peYearId: string;
  obsIds: string[];
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const approvedRaw = arg('approved-count');
  const approvedCount = approvedRaw == null ? null : Number(approvedRaw);
  if (commit && (!Number.isSafeInteger(approvedCount) || (approvedCount ?? -1) < 0)) {
    throw new Error('--commit requires --approved-count <non-negative integer>');
  }

  const fieldFilter = arg('field') as MoneyField | undefined;
  const fields = fieldFilter ? ([fieldFilter] as MoneyField[]) : (['request'] as MoneyField[]);
  for (const f of fields) {
    if (!MONEY_FIELDS.includes(f)) throw new Error(`invalid --field ${f}`);
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const plan: PlanRow[] = [];

    for (const field of fields) {
      const col = Prisma.raw(`"${field}"`);
      // pe_code / fy column names are snake in DB via Prisma map — use model API where possible.
      const rows = await prisma.programElementYear.findMany({
        where: {
          [field]: { not: null },
        } as any,
        select: {
          id: true,
          peCode: true,
          fy: true,
          [field]: true,
        } as any,
      });

      for (const row of rows as Array<Record<string, unknown>>) {
        const raw = row[field];
        if (raw == null) continue;
        const before = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(before) || Math.abs(before) <= THRESHOLD_M) continue;
        // Only repair when value looks like whole thousands (or .xxx leftover of thousands print)
        // Guard: after /1000 must be a sane PE request (0 < |after| < 100000)
        const after = before / 1000;
        if (!Number.isFinite(after) || Math.abs(after) > THRESHOLD_M) continue;
        if (Math.abs(after) === 0) continue;

        const peCode = String(row.peCode);
        const fy = Number(row.fy);
        const peYearId = String(row.id);

        // Matching observations: same pe/fy/field with value ~= before (within 0.001)
        const obs = await prisma.programElementYearSourceValue.findMany({
          where: {
            peCode,
            fy,
            fieldName: field,
          },
          select: { id: true, valueDecimal: true, source: true },
        });
        const obsIds: string[] = [];
        for (const o of obs) {
          if (o.valueDecimal == null) continue;
          const v = Number(o.valueDecimal);
          if (!Number.isFinite(v)) continue;
          if (Math.abs(v - before) < 0.01 || Math.abs(v) > THRESHOLD_M) {
            // same inflated scale
            if (Math.abs(v) > THRESHOLD_M) obsIds.push(o.id);
          }
        }

        plan.push({ peCode, fy, field, before, after, peYearId, obsIds });
      }
    }

    plan.sort((a, b) => a.peCode.localeCompare(b.peCode) || a.fy - b.fy);

    console.log(
      JSON.stringify(
        {
          mode: commit ? 'COMMIT' : 'DRY-RUN',
          threshold: THRESHOLD_M,
          divideBy: 1000,
          fields,
          wouldRepairCanonical: plan.length,
          wouldRepairObservations: plan.reduce((n, p) => n + p.obsIds.length, 0),
          plan: plan.map((p) => ({
            peCode: p.peCode,
            fy: p.fy,
            field: p.field,
            before: p.before,
            after: p.after,
            obsCount: p.obsIds.length,
          })),
        },
        null,
        2,
      ),
    );

    if (!commit) return;
    if (approvedCount !== plan.length) {
      throw new Error(
        `--approved-count ${approvedCount} does not match wouldRepairCanonical ${plan.length}; rerun dry-run`,
      );
    }

    let canonicalUpdated = 0;
    let obsUpdated = 0;
    await prisma.$transaction(async (tx) => {
      for (const p of plan) {
        // Dynamic field update
        await tx.programElementYear.update({
          where: { id: p.peYearId },
          data: { [p.field]: p.after } as any,
        });
        canonicalUpdated += 1;
        if (p.obsIds.length > 0) {
          // Divide each obs individually to preserve precision
          for (const id of p.obsIds) {
            const o = await tx.programElementYearSourceValue.findUnique({
              where: { id },
              select: { valueDecimal: true },
            });
            if (!o?.valueDecimal) continue;
            const v = Number(o.valueDecimal);
            if (!Number.isFinite(v) || Math.abs(v) <= THRESHOLD_M) continue;
            await tx.programElementYearSourceValue.update({
              where: { id },
              data: { valueDecimal: new Prisma.Decimal(v / 1000) },
            });
            obsUpdated += 1;
          }
        }
      }
    });

    console.log(JSON.stringify({ status: 'repaired', canonicalUpdated, obsUpdated }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(
      '[repair-pe-thousands-as-millions] FAILED',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
