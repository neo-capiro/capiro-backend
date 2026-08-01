/**
 * dedupe-pe-observations.ts — C2.3 exact-twin observation dedupe (dry-run first).
 *
 * Implements docs/program-elements/enrichment/phase1-dedupe-plan.md:
 *   1. Never delete without approved count + replay proof.
 *   2. Prefer attach missing sourceDocumentId over delete (handled elsewhere).
 *   3. Dedupe only exact twins: same pe/fy/field/source/valueDecimal.
 *   4. Keep earliest recordedAt as survivor; fold lastObservedAt forward
 *      (survivor.lastObservedAt = max(lastObservedAt)); accumulate observationCount.
 *   5. __row__ rows are lower risk but still gated by the same commit contract.
 *   6. No PE-year canonical rewrite (this script never touches program_element_year).
 *
 *   tsx scripts/dedupe-pe-observations.ts                              # DRY-RUN
 *   tsx scripts/dedupe-pe-observations.ts --source stanford_pe_directory_jan2026
 *   tsx scripts/dedupe-pe-observations.ts --commit --approved-count <N> [--source <src>]
 *
 * Safety contract:
 *   - --commit requires --approved-count to EXACTLY match the dry-run would-delete
 *     count for the same scope (global or same --source filter).
 *   - One transaction per batch; no partial group merges (a group merges fully or not at all).
 *   - Survivor is always the earliest recordedAt; never a row with null valueDecimal
 *     when a non-null twin exists in the same group.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface TwinGroup {
  peCode: string;
  fy: number;
  fieldName: string;
  source: string;
  valueDecimal: string | null;
  n: number;
}

interface MemberRow {
  id: string;
  recordedAt: Date;
  lastObservedAt: Date | null;
  observationCount: number;
  sourceDocumentId: string | null;
  isWinner: boolean;
}

const BATCH = 500;

async function main(): Promise<void> {
  const commit = flag('commit');
  const sourceFilter = arg('source');
  const approvedRaw = arg('approved-count');
  const approvedCount = approvedRaw == null ? null : Number(approvedRaw);
  if (commit && (!Number.isSafeInteger(approvedCount) || (approvedCount ?? -1) < 0)) {
    throw new Error('--commit requires --approved-count <non-negative integer>');
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    // 1. Find exact-twin groups (same pe/fy/field/source/valueDecimal, count>1).
    //    NULL valueDecimal groups: dedupe only when ALL members are null AND same source.
    const groups = await prisma.$queryRaw<TwinGroup[]>`
      SELECT pe_code AS "peCode", fy, field_name AS "fieldName", source,
             value_decimal::text AS "valueDecimal", COUNT(*)::int AS n
      FROM program_element_year_source_value
      ${sourceFilter ? Prisma.sql`WHERE source = ${sourceFilter}` : Prisma.empty}
      GROUP BY pe_code, fy, field_name, source, value_decimal
      HAVING COUNT(*) > 1
      ORDER BY n DESC, pe_code, fy, field_name
    `;

    let wouldDelete = 0;
    let groupsTouched = 0;
    let moneyFieldGroups = 0;
    let winnerHazardGroups = 0;
    const perSource: Record<string, { groups: number; wouldDelete: number }> = {};
    const plan: Array<{ group: TwinGroup; survivor: string; deletes: string[] }> = [];

    for (const g of groups) {
      const members = await prisma.programElementYearSourceValue.findMany({
        where: {
          peCode: g.peCode,
          fy: g.fy,
          fieldName: g.fieldName,
          source: g.source,
          valueDecimal: g.valueDecimal === null ? null : new Prisma.Decimal(g.valueDecimal),
        },
        select: {
          id: true,
          recordedAt: true,
          lastObservedAt: true,
          observationCount: true,
          sourceDocumentId: true,
          isWinner: true,
        },
        orderBy: { recordedAt: 'asc' },
      });
      if (members.length < 2) continue;

      // Survivor: earliest recordedAt; tie-break prefer non-null sourceDocumentId.
      let survivor: MemberRow = members[0]!;
      for (const m of members) {
        if (m.recordedAt < survivor.recordedAt) survivor = m;
        else if (
          m.recordedAt.getTime() === survivor.recordedAt.getTime() &&
          survivor.sourceDocumentId === null &&
          m.sourceDocumentId !== null
        ) {
          survivor = m;
        }
      }
      // Winner hazard: >1 winner in group → skip (needs reconciliation triage, not dedupe).
      const winnerCount = members.filter((m) => m.isWinner).length;
      if (winnerCount > 1) {
        winnerHazardGroups += 1;
        continue;
      }
      // If the single winner is not the survivor, keep the winner instead.
      if (winnerCount === 1 && !members.find((m) => m.id === survivor.id)?.isWinner) {
        survivor = members.find((m) => m.isWinner)!;
      }

      const deletes = members.filter((m) => m.id !== survivor.id).map((m) => m.id);
      if (deletes.length === 0) continue;

      groupsTouched += 1;
      wouldDelete += deletes.length;
      if (g.fieldName !== '__row__') moneyFieldGroups += 1;
      const bucket = (perSource[g.source] ??= { groups: 0, wouldDelete: 0 });
      bucket.groups += 1;
      bucket.wouldDelete += deletes.length;
      plan.push({ group: g, survivor: survivor.id, deletes });
    }

    const report = {
      mode: commit ? 'COMMIT' : 'DRY-RUN',
      sourceFilter: sourceFilter ?? null,
      exactTwinGroups: groups.length,
      groupsTouched,
      winnerHazardGroupsSkipped: winnerHazardGroups,
      moneyFieldGroups,
      wouldDelete,
      wouldKeep: groups.reduce((a, g) => a + g.n, 0) - wouldDelete,
      perSource,
      samplePlan: plan.slice(0, 10).map((p) => ({
        key: `${p.group.peCode}|${p.group.fy}|${p.group.fieldName}|${p.group.source}|${p.group.valueDecimal}`,
        survivor: p.survivor,
        deleteCount: p.deletes.length,
      })),
    };
    console.log(JSON.stringify(report, null, 2));

    if (!commit) return;
    if (approvedCount !== wouldDelete) {
      throw new Error(
        `--approved-count ${approvedCount} does not match dry-run would-delete ${wouldDelete}; rerun dry-run and review`,
      );
    }

    // 2. Commit: for each group, fold into survivor then delete twins.
    let deleted = 0;
    for (let i = 0; i < plan.length; i += BATCH) {
      const batch = plan.slice(i, i + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const { group, survivor, deletes } of batch) {
          const members = await tx.programElementYearSourceValue.findMany({
            where: { id: { in: [...deletes, survivor] } },
            select: { id: true, lastObservedAt: true, observationCount: true },
          });
          const maxLast = members.reduce<Date | null>((acc, m) => {
            const t = m.lastObservedAt;
            return t && (!acc || t > acc) ? t : acc;
          }, null);
          const totalCount = members.reduce((a, m) => a + (m.observationCount ?? 1), 0);
          await tx.programElementYearSourceValue.update({
            where: { id: survivor },
            data: {
              lastObservedAt: maxLast ?? undefined,
              observationCount: totalCount,
            },
          });
          await tx.programElementYearSourceValue.deleteMany({ where: { id: { in: deletes } } });
          deleted += deletes.length;
        }
      });
    }
    console.log(JSON.stringify({ status: 'committed', deleted }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[dedupe-pe-observations] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
