/**
 * Dry-run-first audit/backfill for Phase D observation metadata.
 *
 * This command NEVER changes ProgramElementYear canonical values and never
 * deletes/merges historical observations. The Phase D migration normally
 * stamps every legacy row; this command exists to detect and repair drift.
 *
 *   tsx scripts/backfill-pe-observation-keys.ts
 *   tsx scripts/backfill-pe-observation-keys.ts --commit --approved-count 12
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const approvedRaw = arg('approved-count');
  const approvedCount = approvedRaw == null ? null : Number(approvedRaw);
  if (commit && (!Number.isSafeInteger(approvedCount) || (approvedCount ?? -1) < 0)) {
    throw new Error('--commit requires --approved-count <non-negative integer>');
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const candidates = await prisma.programElementYearSourceValue.findMany({
      where: {
        OR: [
          { observationKey: null },
          { canonicalValueM: null, valueDecimal: { not: null } },
        ],
      },
      select: {
        id: true,
        observationKey: true,
        valueDecimal: true,
        canonicalValueM: true,
        recordedAt: true,
        lastObservedAt: true,
      },
      orderBy: { id: 'asc' },
    });

    const duplicateGroups = await prisma.$queryRaw<
      Array<{ peCode: string; fy: number; fieldName: string; source: string; count: number }>
    >`
      SELECT pe_code AS "peCode", fy, field_name AS "fieldName", source, COUNT(*)::int AS count
      FROM program_element_year_source_value
      GROUP BY pe_code, fy, field_name, source, value_decimal
      HAVING COUNT(*) > 1
      ORDER BY count DESC, pe_code, fy, field_name
      LIMIT 200
    `;
    const winnerInconsistencies = await prisma.$queryRaw<
      Array<{ peCode: string; fy: number; fieldName: string; winnerCount: number }>
    >`
      SELECT pe_code AS "peCode", fy, field_name AS "fieldName",
             COUNT(*) FILTER (WHERE is_winner)::int AS "winnerCount"
      FROM program_element_year_source_value
      WHERE field_name <> '__row__'
      GROUP BY pe_code, fy, field_name
      HAVING COUNT(*) FILTER (WHERE is_winner) > 1
      ORDER BY pe_code, fy, field_name
      LIMIT 200
    `;

    const report = {
      mode: commit ? 'COMMIT' : 'DRY-RUN',
      candidateCount: candidates.length,
      alreadyLegacyStamped: await prisma.programElementYearSourceValue.count({
        where: { observationKey: { startsWith: 'legacy:' } },
      }),
      duplicateLegacyGroups: duplicateGroups,
      multipleWinnerGroups: winnerInconsistencies,
      canonicalProgramElementYearWrites: 0,
      observationDeletes: 0,
    };
    console.log(JSON.stringify(report, null, 2));

    if (!commit) return;
    if (approvedCount !== candidates.length) {
      throw new Error(
        `--approved-count ${approvedCount} does not match current candidate count ${candidates.length}; rerun dry-run and review`,
      );
    }

    await prisma.$transaction(
      candidates.map((row) =>
        prisma.programElementYearSourceValue.update({
          where: { id: row.id },
          data: {
            observationKey: row.observationKey ?? `legacy:${row.id}`,
            canonicalValueM: row.canonicalValueM ?? row.valueDecimal,
            lastObservedAt: row.lastObservedAt ?? row.recordedAt,
          },
        }),
      ),
    );
    console.log(JSON.stringify({ status: 'committed', updated: candidates.length }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[backfill-pe-observation-keys] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
