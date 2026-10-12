/**
 * Step 4.1 — accuracy harness CLI (§22).
 *
 *   pnpm --filter @capiro/api measure:accuracy                 # table to stdout
 *   pnpm --filter @capiro/api measure:accuracy -- --json       # machine-readable summary
 *   pnpm --filter @capiro/api measure:accuracy -- --golden-dir ./test/__golden__
 *
 * Loads the golden-set JSON files, REPLAYS them against current DB state (READ-ONLY —
 * this script never writes), computes every §22 metric via the pure
 * `src/intelligence/metrics/accuracy-metrics.ts` module, prints a table, and exits
 * NON-ZERO when any metric is under target (CI-friendly). `--json` prints the structured
 * summary instead.
 *
 * HONESTY: when a golden set has no live data to replay against (the committed sets are
 * SYNTHETIC — their ids do not resolve to real rows yet), the metric is reported as
 * "n/a (no data / golden set is synthetic)", NOT a fake pass, and it does NOT satisfy the
 * CI gate. A real measurement requires human-curated golden sets (see
 * test/__golden__/README.md).
 *
 * Money convention: $ MILLIONS (R-1 BY amounts compared in millions).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  TARGETS,
  peIdentityAccuracy,
  fundingValueAccuracy,
  programMatchPrecision,
  personRolePrecision,
  deltaAccuracy,
  summarize,
  type MetricResult,
  type R1IdentityGolden,
  type R1IdentityActual,
  type FundingGolden,
  type FundingActual,
  type LabelGolden,
  type DecisionActual,
  type DeltaGolden,
  type DeltaActual,
} from '../src/intelligence/metrics/accuracy-metrics.js';

dotenvConfig();

const DEFAULT_GOLDEN_DIR = join(process.cwd(), 'test', '__golden__');

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface GoldenFile<T> {
  _note?: string;
  rows: T[];
}

function loadGolden<T>(dir: string, file: string): GoldenFile<T> {
  const path = resolve(dir, file);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoldenFile<T>;
  if (!Array.isArray(parsed.rows)) {
    throw new Error(`Golden file ${file} has no "rows" array`);
  }
  return parsed;
}

/** Decimal | number | null → number | null (Prisma Decimal → JS number, $ MILLIONS). */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'object' && v !== null ? Number(v.toString()) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A metric the harness could not measure because no golden row resolved to live data.
 * Reported as n/a (value null), NOT a pass.
 */
function naResult(metric: string, target: number): MetricResult {
  return { metric, value: null, target, pass: false, sampleSize: 0 };
}

async function main(): Promise<void> {

  const asJson = flag('json');
  const goldenDir = arg('golden-dir') ?? DEFAULT_GOLDEN_DIR;

  const prisma = new PrismaClient();
  const results: MetricResult[] = [];
  const notes: string[] = [];

  try {
    // --- PE identity + funding-value (one golden file feeds two metrics) -----------
    {
      const g = loadGolden<{ id: string; peCode: string; title: string; byAmount: number }>(
        goldenDir,
        'r1-identity.golden.json',
      );
      const peCodes = g.rows.map((r) => r.peCode);
      const pes = await prisma.programElement.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true, title: true },
      });
      const byCode = new Map(pes.map((p) => [p.peCode, p] as const));

      // BY amount: take the latest fiscal year's request from program_element_year.
      const years = await prisma.programElementYear.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true, fy: true, request: true },
        orderBy: { fy: 'desc' },
      });
      const latestRequestByCode = new Map<string, number | null>();
      for (const y of years) {
        if (!latestRequestByCode.has(y.peCode)) {
          latestRequestByCode.set(y.peCode, toNum(y.request));
        }
      }

      const idGolden: R1IdentityGolden[] = g.rows.map((r) => ({
        id: r.id,
        peCode: r.peCode,
        title: r.title,
      }));
      const idActual: R1IdentityActual[] = g.rows
        .filter((r) => byCode.has(r.peCode))
        .map((r) => ({ id: r.id, peCode: r.peCode, title: byCode.get(r.peCode)!.title }));

      const fundGolden: FundingGolden[] = g.rows.map((r) => ({ id: r.id, byAmount: r.byAmount }));
      const fundActual: FundingActual[] = g.rows
        .filter((r) => latestRequestByCode.has(r.peCode))
        .map((r) => ({ id: r.id, byAmount: latestRequestByCode.get(r.peCode) ?? null }));

      if (idActual.length === 0) {
        results.push(naResult('pe_identity_accuracy', TARGETS.PE_IDENTITY_ACCURACY));
        results.push(naResult('funding_value_accuracy', TARGETS.FUNDING_VALUE_ACCURACY));
        notes.push(
          'pe_identity_accuracy / funding_value_accuracy: n/a — no golden PE resolved to a live program_element row (synthetic set).',
        );
      } else {
        results.push(peIdentityAccuracy(idGolden, idActual));
        results.push(fundingValueAccuracy(fundGolden, fundActual));
      }
    }

    // --- PE→program precision -------------------------------------------------------
    {
      const g = loadGolden<{ id: string; correct: boolean }>(
        goldenDir,
        'program-match.golden.json',
      );
      const ids = g.rows.map((r) => r.id);
      const matches = await prisma.peProgramMatch.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
      });
      const labelGolden: LabelGolden[] = g.rows.map((r) => ({ id: r.id, correct: r.correct }));
      const decisionActual: DecisionActual[] = matches.map((m) => ({
        id: m.id,
        accepted: m.status === 'accepted',
      }));
      if (decisionActual.length === 0) {
        results.push(naResult('program_match_precision', TARGETS.PROGRAM_MATCH_PRECISION));
        notes.push(
          'program_match_precision: n/a — no golden match id resolved to a live pe_program_match row (synthetic set).',
        );
      } else {
        results.push(programMatchPrecision(labelGolden, decisionActual));
      }
    }

    // --- Person→role precision ------------------------------------------------------
    // No first-class "accepted person→role" table to replay against in this step; the
    // golden ids are synthetic. Report n/a rather than fabricate a pass. When a
    // pe_person attribution table with an accepted status lands, replay it here exactly
    // like program-match above.
    {
      loadGolden<{ id: string; correct: boolean }>(goldenDir, 'person-role.golden.json');
      results.push(naResult('person_role_precision', TARGETS.PERSON_ROLE_PRECISION));
      notes.push(
        'person_role_precision: n/a — no accepted person→role source to replay against yet (synthetic set); wire to the pe_person attribution table when it lands.',
      );
    }

    // --- Delta classification accuracy ---------------------------------------------
    {
      const g = loadGolden<{ id: string; deltaType: string }>(
        goldenDir,
        'delta-classification.golden.json',
      );
      const ids = g.rows.map((r) => r.id);
      const deltas = await prisma.programElementDelta.findMany({
        where: { id: { in: ids } },
        select: { id: true, deltaType: true },
      });
      const deltaGolden: DeltaGolden[] = g.rows.map((r) => ({ id: r.id, deltaType: r.deltaType }));
      const deltaActual: DeltaActual[] = deltas.map((d) => ({ id: d.id, deltaType: d.deltaType }));
      if (deltaActual.length === 0) {
        results.push(naResult('delta_accuracy', TARGETS.DELTA_ACCURACY));
        notes.push(
          'delta_accuracy: n/a — no golden delta id resolved to a live program_element_delta row (synthetic set).',
        );
      } else {
        results.push(deltaAccuracy(deltaGolden, deltaActual));
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  const summary = summarize(results);
  const measured = results.filter((r) => r.value !== null);
  // CI gate: fail when any MEASURED metric is under target. A run that measured nothing
  // (all n/a — the synthetic default) also fails, so CI never greens on no data.
  const gatePass = measured.length > 0 && measured.every((r) => r.pass);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          targets: TARGETS,
          metrics: summary.metrics,
          measuredCount: measured.length,
          allMeasuredPass: gatePass,
          allPass: summary.allPass,
          notes,
        },
        null,
        2,
      ),
    );
  } else {
    printTable(summary.metrics);
    if (notes.length) {
      console.log('\nNotes:');
      for (const n of notes) console.log(`  - ${n}`);
    }
    console.log(
      `\n${measured.length} of ${results.length} metric(s) measured against live data; ` +
        `${gatePass ? 'all measured metrics PASS' : 'one or more measured metrics FAIL or none measured'}.`,
    );
    if (measured.length === 0) {
      console.log(
        'NOTE: 0 metrics measured — the committed golden sets are SYNTHETIC. ' +
          'Curate real golden sets (see test/__golden__/README.md) for a trustworthy §22 number.',
      );
    }
  }

  process.exit(gatePass ? 0 : 1);
}

/** Render the §22 metric table to stdout. */
function printTable(metrics: readonly MetricResult[]): void {
  const rows = metrics.map((m) => ({
    metric: m.metric,
    value: m.value === null ? 'n/a' : m.value.toFixed(4),
    target: m.target.toFixed(2),
    n: String(m.sampleSize),
    result: m.value === null ? 'N/A' : m.pass ? 'PASS' : 'FAIL',
  }));
  const widths = {
    metric: Math.max(6, ...rows.map((r) => r.metric.length)),
    value: Math.max(5, ...rows.map((r) => r.value.length)),
    target: Math.max(6, ...rows.map((r) => r.target.length)),
    n: Math.max(3, ...rows.map((r) => r.n.length)),
    result: Math.max(6, ...rows.map((r) => r.result.length)),
  };
  const pad = (s: string, w: number) => s.padEnd(w);
  const header =
    `${pad('METRIC', widths.metric)}  ${pad('VALUE', widths.value)}  ` +
    `${pad('TARGET', widths.target)}  ${pad('N', widths.n)}  ${pad('RESULT', widths.result)}`;
  console.log('§22 accuracy metrics');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log(
      `${pad(r.metric, widths.metric)}  ${pad(r.value, widths.value)}  ` +
        `${pad(r.target, widths.target)}  ${pad(r.n, widths.n)}  ${pad(r.result, widths.result)}`,
    );
  }
}

// Guard against auto-run on import (e.g. if a test ever imports this module): only run
// main() when invoked directly as the entry script.
const invokedDirectly =
  typeof process.argv[1] === 'string' && /measure-accuracy(\.ts|\.js)?$/.test(process.argv[1]);
if (invokedDirectly) {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/measure-accuracy.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }

  void main().catch((e) => {
    console.error('[measure-accuracy] fatal', e?.stack || e);
    process.exit(1);
  });
}

export { main };
