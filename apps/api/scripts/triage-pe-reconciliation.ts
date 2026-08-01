/**
 * triage-pe-reconciliation.ts — C2.4 reconciliation queue triage (SELECT-first).
 *
 * Classifies the open ReconciliationReviewQueue backlog into:
 *   A. unauthorized_field_source — auto-closeable when the ownership map already
 *      prevents that source from winning the field (canonical is by definition right).
 *   B. value_conflict noise-class — committee marks restating the request line on the
 *      `request` field (marks own their own mark fields; they never win `request`
 *      because ownership blocks them). Auto-closeable with ACK.
 *   C. value_conflict material — real money deltas needing human/Neo review. KEEP OPEN.
 *   D. lp_wrong_field — llamaparse_* observations on enacted/executed (R-2 prior-year
 *      Actuals/Enacted columns mapping to wrong canonical fields). Resolved by C1
 *      ownership enforcement at write time; existing items auto-closeable with ACK.
 *
 *   tsx scripts/triage-pe-reconciliation.ts                    # SELECT report only
 *   tsx scripts/triage-pe-reconciliation.ts --resolve-class unauthorized_field_source \
 *       --commit --approved-count <N> --notes "<why>"
 *
 * Resolution never mutates canonical PE rows (schema contract) — it only marks
 * queue entries resolved with notes.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Sources that are committee marks — they own ONLY their own mark field and can
// never canonically win `request`; a `request|<mark_source>` conflict is noise.
const MARK_SOURCES = new Set([
  'hasc_report', 'hasc_report_fy26', 'hasc_report_fy27',
  'sasc_report', 'sasc_report_fy26', 'sasc_report_fy27',
  'hac_d_report', 'hac_d_report_fy27',
  'sac_d_report', 'sac_d_report_fy27',
  'conference_report', 'conference_report_fy26', 'conference_report_fy27',
]);
// LP R-2 sources whose prior-year Actuals/Enacted columns mapped to wrong fields (C1 class).
const LP_SOURCES = new Set([
  'llamaparse_af_rdte_vol1', 'llamaparse_fy2027_r1', 'llamaparse_rdte_vol_1_budget_activity_1',
]);
// o1 OM loader wrote enacted under PB authority (C1.4 fixed going forward).
const O1_SOURCES = new Set(['o1', 'o1_fy2027']);

type TriageClass = 'A_unauthorized' | 'B_mark_request_noise' | 'C_material' | 'D_lp_wrong_field' | 'E_o1_enacted';

function classify(item: {
  fieldName: string;
  conflictType: string;
  conflictingSource: string;
  deltaPct: number | null;
}): TriageClass {
  if (item.conflictType === 'unauthorized_field_source') return 'A_unauthorized';
  const src = item.conflictingSource;
  if (item.conflictType === 'value_conflict') {
    if (item.fieldName === 'request' && MARK_SOURCES.has(src)) return 'B_mark_request_noise';
    if ((item.fieldName === 'enacted' || item.fieldName === 'executed') && LP_SOURCES.has(src)) {
      return 'D_lp_wrong_field';
    }
    if (item.fieldName === 'enacted' && O1_SOURCES.has(src)) return 'E_o1_enacted';
  }
  return 'C_material';
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const resolveClass = arg('resolve-class');
  const approvedRaw = arg('approved-count');
  const approvedCount = approvedRaw == null ? null : Number(approvedRaw);
  const notes = arg('notes') ?? null;
  if (commit) {
    if (!resolveClass) throw new Error('--commit requires --resolve-class <class>');
    if (!Number.isSafeInteger(approvedCount) || (approvedCount ?? -1) < 0) {
      throw new Error('--commit requires --approved-count <non-negative integer>');
    }
    if (!notes) throw new Error('--commit requires --notes "<resolution notes>"');
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const open = await prisma.reconciliationReviewQueue.findMany({
      where: { status: 'open' },
      select: {
        id: true, peCode: true, fy: true, fieldName: true, conflictType: true,
        currentValue: true, currentSource: true, conflictingSource: true,
        conflictingValue: true, deltaPct: true, queuedAt: true, observationCount: true,
      },
      orderBy: { queuedAt: 'asc' },
    });

    const byClass: Record<TriageClass, typeof open> = {
      A_unauthorized: [], B_mark_request_noise: [], C_material: [], D_lp_wrong_field: [], E_o1_enacted: [],
    };
    for (const item of open) byClass[classify(item)].push(item);

    const summarize = (rows: typeof open) => {
      const byField: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      let bigDelta = 0;
      for (const r of rows) {
        byField[r.fieldName] = (byField[r.fieldName] ?? 0) + 1;
        bySource[r.conflictingSource] = (bySource[r.conflictingSource] ?? 0) + 1;
        if (r.deltaPct !== null && Math.abs(r.deltaPct) > 25) bigDelta += 1;
      }
      return { count: rows.length, byField, bySource, deltaPctOver25: bigDelta };
    };

    const report = {
      mode: commit ? 'COMMIT' : 'SELECT-ONLY',
      openTotal: open.length,
      classes: {
        A_unauthorized: summarize(byClass.A_unauthorized),
        B_mark_request_noise: summarize(byClass.B_mark_request_noise),
        C_material: summarize(byClass.C_material),
        D_lp_wrong_field: summarize(byClass.D_lp_wrong_field),
        E_o1_enacted: summarize(byClass.E_o1_enacted),
      },
      materialSamples: byClass.C_material.slice(0, 20).map((r) => ({
        id: r.id, peCode: r.peCode, fy: r.fy, fieldName: r.fieldName,
        currentValue: r.currentValue, currentSource: r.currentSource,
        conflictingValue: r.conflictingValue, conflictingSource: r.conflictingSource,
        deltaPct: r.deltaPct, queuedAt: r.queuedAt, observationCount: r.observationCount,
      })),
    };
    console.log(JSON.stringify(report, null, 2));

    if (!commit) return;

    const validClasses: Record<string, TriageClass> = {
      unauthorized_field_source: 'A_unauthorized',
      mark_request_noise: 'B_mark_request_noise',
      lp_wrong_field: 'D_lp_wrong_field',
      o1_enacted: 'E_o1_enacted',
    };
    const target = validClasses[resolveClass!];
    if (!target) {
      throw new Error(`--resolve-class must be one of: ${Object.keys(validClasses).join(', ')}`);
    }
    const rows = byClass[target];
    if (approvedCount !== rows.length) {
      throw new Error(
        `--approved-count ${approvedCount} does not match current ${target} count ${rows.length}; rerun SELECT report and review`,
      );
    }
    const ids = rows.map((r) => r.id);
    const batch = 1000;
    let resolved = 0;
    for (let i = 0; i < ids.length; i += batch) {
      const chunk = ids.slice(i, i + batch);
      const res = await prisma.reconciliationReviewQueue.updateMany({
        where: { id: { in: chunk }, status: 'open' },
        data: { status: 'resolved', resolvedAt: new Date(), resolutionNotes: notes },
      });
      resolved += res.count;
    }
    console.log(JSON.stringify({ status: 'resolved', class: resolveClass, resolved }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[triage-pe-reconciliation] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
