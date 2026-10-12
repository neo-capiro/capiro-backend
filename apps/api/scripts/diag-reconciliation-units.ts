/**
 * Reconciliation queue unit-artifact triage (Step 0.2 maintenance).
 *
 * The PE budget model is canonical in $ MILLIONS. Every loader normalizes to
 * millions at the boundary (dollarsToMillions / thousandsToMillions). The
 * reconciliation queue stores BOTH the canonical value and the conflicting
 * source's value verbatim, so if a source ever reached the writer in RAW units
 * (full dollars / thousands) — e.g. rows queued before the 2026-06-05 unit fix,
 * or a source that skipped normalization — the queue shows the SAME figure with
 * a ~1,000x or ~1,000,000x gap. Those are false conflicts ("canonical missing
 * 0s"), not real source disagreements.
 *
 * Verdicts (READ-ONLY by default):
 *   - artifact_keep         : >=100x gap AND canonical is the SMALLER (millions)
 *                             side -> canonical is correct; safe to keep_current.
 *   - artifact_canonical_raw: >=100x gap but canonical is the BIGGER (raw) side
 *                             -> the CANONICAL itself looks wrong (inflated).
 *                             NOT auto-resolved; needs manual accept_conflicting.
 *   - genuine               : <100x gap -> a real disagreement; left untouched.
 *
 *   tsx scripts/diag-reconciliation-units.ts                 # report only
 *   tsx scripts/diag-reconciliation-units.ts --source hac_d  # filter a source
 *   tsx scripts/diag-reconciliation-units.ts --commit        # resolve artifact_keep only
 *
 * --commit resolves ONLY artifact_keep rows as keep_current (mark reviewed, NO
 * value change). Genuine disagreements AND artifact_canonical_raw rows are never
 * auto-resolved. Idempotent.
 */
import { PrismaClient } from '@prisma/client';

const UNIT_RATIO = 100; // >=100x gap = unit mismatch, not a real disagreement.

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Row = {
  id: string;
  peCode: string;
  fy: number;
  fieldName: string;
  currentValue: string | null; // canonical
  conflictingSource: string;
  conflictingValue: string | null;
  deltaPct: number | null;
};

type Verdict = 'artifact_keep' | 'artifact_canonical_raw' | 'genuine' | 'unparseable';

function classify(row: Row): { verdict: Verdict; ratio: number | null } {
  const canon = row.currentValue === null ? NaN : Number(row.currentValue);
  const conf = row.conflictingValue === null ? NaN : Number(row.conflictingValue);
  if (!Number.isFinite(canon) || !Number.isFinite(conf)) return { verdict: 'unparseable', ratio: null };
  if (canon === 0 || conf === 0) return { verdict: 'genuine', ratio: null };
  const ratio = Math.abs(conf / canon); // conflicting / canonical
  if (ratio >= UNIT_RATIO) return { verdict: 'artifact_keep', ratio }; // canonical smaller = millions (correct)
  if (ratio <= 1 / UNIT_RATIO) return { verdict: 'artifact_canonical_raw', ratio }; // canonical bigger = raw (suspect)
  return { verdict: 'genuine', ratio };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/diag-reconciliation-units.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const commit = process.argv.includes('--commit');
  // Also resolve artifact_canonical_raw rows. Use ONLY after verifying the LIVE
  // program_element_year values are correct $M (so the snapshots are stale, not a
  // real canonical that needs accept_conflicting). keep_current never changes a
  // value, so this only clears stale rows.
  const includeCanonRaw = process.argv.includes('--include-canonical-raw');
  // Resolve specific row ids as keep_current — for operator-confirmed stale rows
  // the ratio classifier leaves as 'genuine' (e.g. canonical=0 snapshots that a
  // later correct load already superseded). Comma-separated. No value change.
  const resolveIds = (argValue('resolve-ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const sourceFilter = argValue('source');
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const rows = (await prisma.reconciliationReviewQueue.findMany({
      where: { status: 'open', ...(sourceFilter ? { conflictingSource: sourceFilter } : {}) },
      select: {
        id: true, peCode: true, fy: true, fieldName: true,
        currentValue: true, conflictingSource: true, conflictingValue: true, deltaPct: true,
      },
      orderBy: [{ conflictingSource: 'asc' }, { fieldName: 'asc' }],
    })) as Row[];

    if (rows.length === 0) {
      console.log(`No OPEN reconciliation rows${sourceFilter ? ` for source=${sourceFilter}` : ''}.`);
      return;
    }

    type Bucket = { keep: Row[]; canonRaw: Row[]; genuine: Row[]; unparseable: Row[] };
    const bySource = new Map<string, Bucket>();
    for (const r of rows) {
      const { verdict } = classify(r);
      const b = bySource.get(r.conflictingSource) ?? { keep: [], canonRaw: [], genuine: [], unparseable: [] };
      if (verdict === 'artifact_keep') b.keep.push(r);
      else if (verdict === 'artifact_canonical_raw') b.canonRaw.push(r);
      else if (verdict === 'genuine') b.genuine.push(r);
      else b.unparseable.push(r);
      bySource.set(r.conflictingSource, b);
    }

    const sample = (r: Row | undefined): string => {
      if (!r) return '';
      const { ratio } = classify(r);
      const dir = ratio === null ? '' : ratio >= 1 ? `~${Math.round(ratio)}x larger` : `~${Math.round(1 / ratio)}x smaller`;
      return `${r.peCode} FY${r.fy} ${r.fieldName}: canonical=${r.currentValue} vs ${r.conflictingSource}=${r.conflictingValue} (${dir})`;
    };

    console.log(`\n=== OPEN reconciliation queue: ${rows.length} row(s) ===\n`);
    let totalKeep = 0, totalCanonRaw = 0;
    for (const [source, b] of [...bySource.entries()].sort()) {
      totalKeep += b.keep.length;
      totalCanonRaw += b.canonRaw.length;
      console.log(
        `SOURCE "${source}":  ${b.keep.length} artifact_keep · ${b.canonRaw.length} CANONICAL-RAW(!) · ` +
          `${b.genuine.length} genuine · ${b.unparseable.length} unparseable`,
      );
      if (b.keep[0]) console.log(`    keep   e.g. ${sample(b.keep[0])}`);
      if (b.canonRaw[0]) console.log(`    !! raw e.g. ${sample(b.canonRaw[0])}`);
      if (b.genuine[0]) console.log(`    real   e.g. ${sample(b.genuine[0])}`);
    }
    console.log(`\nartifact_keep (false conflicts, canonical correct): ${totalKeep}`);
    if (totalCanonRaw > 0) {
      console.log(`⚠️  artifact_canonical_raw (canonical itself looks inflated): ${totalCanonRaw} — NOT auto-resolved; review manually (likely accept_conflicting).`);
    }

    if (!commit) {
      const extra = includeCanonRaw ? ` + ${totalCanonRaw} artifact_canonical_raw` : '';
      console.log(`\nDRY RUN — pass --commit to resolve ${totalKeep} artifact_keep${extra} row(s) as keep_current.`);
      if (!includeCanonRaw && totalCanonRaw > 0) {
        console.log(`(add --include-canonical-raw to ALSO sweep the ${totalCanonRaw} canonical-raw rows — only after verifying live data is correct.)`);
      }
      if (resolveIds.length > 0) console.log(`(--resolve-ids would close ${resolveIds.length} operator-specified row(s).)`);
      return;
    }

    const keepIds = rows.filter((r) => classify(r).verdict === 'artifact_keep').map((r) => r.id);
    const rawIds = includeCanonRaw
      ? rows.filter((r) => classify(r).verdict === 'artifact_canonical_raw').map((r) => r.id)
      : [];
    if (keepIds.length === 0 && rawIds.length === 0 && resolveIds.length === 0) {
      console.log('\nNothing to resolve.');
      return;
    }
    if (keepIds.length > 0) {
      const res = await prisma.reconciliationReviewQueue.updateMany({
        where: { id: { in: keepIds }, status: 'open' },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes:
            'auto-resolved (diag-reconciliation-units): unit-mismatch artifact — conflicting value in raw $ vs canonical $M; kept canonical (no value change).',
        },
      });
      console.log(`\nResolved ${res.count} artifact_keep row(s) as keep_current.`);
    }
    if (rawIds.length > 0) {
      const res = await prisma.reconciliationReviewQueue.updateMany({
        where: { id: { in: rawIds }, status: 'open' },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes:
            'auto-resolved (diag-reconciliation-units --include-canonical-raw): stale snapshot from a pre-fix loader pass; live canonical verified correct in $M; kept canonical (no value change).',
        },
      });
      console.log(`Resolved ${res.count} artifact_canonical_raw row(s) as keep_current (stale; live verified correct).`);
    }
    if (!includeCanonRaw && totalCanonRaw > 0) {
      console.log(`Left ${totalCanonRaw} CANONICAL-RAW row(s) open (pass --include-canonical-raw to sweep, after verifying live data).`);
    }
    if (resolveIds.length > 0) {
      const res = await prisma.reconciliationReviewQueue.updateMany({
        where: { id: { in: resolveIds }, status: 'open' },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes:
            'operator-confirmed stale (live program_element_year verified correct in $M); closed via diag-reconciliation-units --resolve-ids.',
        },
      });
      console.log(`Resolved ${res.count} operator-specified row(s) by id as keep_current.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
}
