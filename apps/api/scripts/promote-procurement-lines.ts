/** @cleanup-smoke noArgsExit=2 */
/**
 * promote-procurement-lines — plan (and, when doubly authorized, apply)
 * canonical writes for PROCUREMENT budget line items with no Program Element
 * parent (procurement_line / procurement_line_year / procurement_line_source).
 *
 *   tsx scripts/promote-procurement-lines.ts \
 *     --artifacts <artifact.json | dir-of-json> [--artifacts ...] \
 *     [--report <composed-family-report.json>] \
 *     [--p40-required] [--required-identity <naturalKey>]... \
 *     [--scope family|identity] [--write] [--json]
 *
 * DRY-RUN BY DEFAULT. The script composes the procurement family from the given
 * `defense_budget_extraction_v1` artifacts (or reuses `--report`), runs
 * ProcurementLineWriterService, and prints the summary: what WOULD be written
 * and every skipped assertion with its reason. Nothing is touched.
 *
 * `--write` applies the plan, and requires BOTH the flag and
 * `DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES=1` in the environment; without
 * the env var the script refuses (exit 3) rather than silently dry-running.
 * `DATABASE_URL` is only read in write mode.
 *
 * Only assertions whose verification decision is PASS are written; see
 * src/defense-budget/procurement/README.md for the gating and rules.
 *
 * Exit codes: 0 ok, 2 usage / validation, 3 write refused, 1 error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import {
  defenseBudgetExtractionArtifactV1Schema,
  type DefenseBudgetExtractionArtifactV1,
} from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import {
  composeProcurementFamily,
  type ProcurementExhibitArtifacts,
  type ProcurementFamilyReport,
} from '../src/defense-budget/procurement/procurement-composer-v1.js';
import {
  PROCUREMENT_LINE_CANONICAL_WRITES_ENV,
  procurementCanonicalWritesEnabled,
} from '../src/defense-budget/procurement/procurement-line-canonical-v1.js';
import {
  ProcurementLineWriterService,
  type ProcurementLineWriteSummary,
} from '../src/defense-budget/procurement/procurement-line-writer.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

const SCRIPT = 'promote-procurement-lines';

function usage(message: string): never {
  console.error(`${SCRIPT}: ${message}`);
  console.error(
    `usage: tsx scripts/${SCRIPT}.ts --artifacts <file|dir> [--artifacts ...] [--report <json>] [--p40-required] [--required-identity <key>]... [--scope family|identity] [--write] [--json]`,
  );
  process.exit(2);
}

function argValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag) {
      const v = process.argv[i + 1];
      if (v == null || v.startsWith('--')) usage(`${flag} requires a value`);
      out.push(v);
    }
  }
  return out;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readJson(filePath: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    usage(`cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    usage(`invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expandArtifactPaths(inputs: readonly string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) usage(`artifact path does not exist: ${input}`);
    if (fs.statSync(resolved).isDirectory()) {
      for (const entry of fs.readdirSync(resolved).sort()) {
        if (entry.toLowerCase().endsWith('.json')) files.push(path.join(resolved, entry));
      }
    } else {
      files.push(resolved);
    }
  }
  if (files.length === 0) usage('no artifact .json files found');
  return files;
}

function loadArtifacts(files: readonly string[]): DefenseBudgetExtractionArtifactV1[] {
  const artifacts: DefenseBudgetExtractionArtifactV1[] = [];
  for (const file of files) {
    const parsed = defenseBudgetExtractionArtifactV1Schema.safeParse(readJson(file));
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      usage(`${file} is not a valid defense_budget_extraction_v1 artifact:\n${issues}`);
    }
    if (parsed.data.source.family !== 'procurement') {
      usage(`${file} has family "${parsed.data.source.family}", expected "procurement"`);
    }
    artifacts.push(parsed.data);
  }
  return artifacts;
}

function bucketArtifacts(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
): { buckets: ProcurementExhibitArtifacts; ignored: string[] } {
  const buckets: ProcurementExhibitArtifacts = {
    p1Artifacts: [],
    p40Artifacts: [],
    p5Artifacts: [],
    p21Artifacts: [],
    p3aArtifacts: [],
  };
  const ignored: string[] = [];
  const push = (key: keyof ProcurementExhibitArtifacts, a: DefenseBudgetExtractionArtifactV1) =>
    (buckets[key] as DefenseBudgetExtractionArtifactV1[]).push(a);
  for (const a of artifacts) {
    switch (a.source.exhibit) {
      case 'P-1':
        push('p1Artifacts', a);
        break;
      case 'P-40':
        push('p40Artifacts', a);
        break;
      case 'P-5':
      case 'P-5A':
        push('p5Artifacts', a);
        break;
      case 'P-21':
        push('p21Artifacts', a);
        break;
      case 'P-3A':
        push('p3aArtifacts', a);
        break;
      default:
        ignored.push(`${a.artifactId} (exhibit ${a.source.exhibit})`);
    }
  }
  return { buckets, ignored };
}

function loadReport(filePath: string): ProcurementFamilyReport {
  const value = readJson(path.resolve(filePath)) as Partial<ProcurementFamilyReport>;
  const decision = value?.verification?.decision;
  if (
    decision !== 'VERIFICATION_PASSED' &&
    decision !== 'NEEDS_REVIEW' &&
    decision !== 'REJECTED'
  ) {
    usage(`${filePath} is not a ProcurementFamilyReport (verification.decision missing/invalid)`);
  }
  if (!Array.isArray(value.verification?.findings)) {
    usage(`${filePath} is not a ProcurementFamilyReport (verification.findings missing)`);
  }
  return value as ProcurementFamilyReport;
}

function printHumanSummary(summary: ProcurementLineWriteSummary, ignored: readonly string[]): void {
  const w = (s: string) => console.error(s);
  w(`${SCRIPT}: mode=${summary.mode} gate(${summary.gateEnv})=${summary.gateEnabled ? 'ON' : 'off'} decision=${summary.decision} (${summary.decisionSource}) scope=${summary.scope}`);
  if (ignored.length) w(`  ignored non-procurement-exhibit artifacts: ${ignored.join(', ')}`);
  if (summary.wouldWrite) {
    const c = summary.wouldWrite;
    w(`  would write: ${c.lines} line(s), ${c.years} year row(s), ${c.yearValues} value(s), ${c.sources} citation(s)`);
  }
  if (summary.written) {
    const c = summary.written;
    w(`  written: lines +${c.lines.inserted}/~${c.lines.updated}, years +${c.years.inserted}/~${c.years.updated}, sources +${c.sources.inserted}/~${c.sources.updated}, values ${c.yearValues}`);
  }
  w(`  lines: ${summary.lineKeys.join(', ') || '(none)'}`);
  const cnt = summary.counts;
  w(`  assertions: seen ${cnt.assertionsSeen}, values ${cnt.valueAssertionsSeen}, pass ${cnt.pass}, review ${cnt.review}, reject ${cnt.reject}, unsupported ${cnt.unsupported}`);
  if (summary.skipped.length) {
    const byReason = new Map<string, number>();
    for (const s of summary.skipped) {
      const key = `${s.decision} — ${s.reason.split(':')[0]}`;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    w('  skipped by reason:');
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      w(`    ${String(n).padStart(5)}  ${reason}`);
    }
  }
}

async function main(): Promise<void> {
  const artifactInputs = argValues('--artifacts');
  if (artifactInputs.length === 0) usage('--artifacts is required (file or directory, repeatable)');
  const reportPath = argValues('--report')[0];
  const requiredIdentityKeys = argValues('--required-identity');
  const scopeRaw = argValues('--scope')[0] ?? 'family';
  if (scopeRaw !== 'family' && scopeRaw !== 'identity') usage('--scope must be family or identity');
  const scope = scopeRaw;
  const write = hasFlag('--write');
  const json = hasFlag('--json');
  const p40Required = hasFlag('--p40-required');

  const files = expandArtifactPaths(artifactInputs);
  const artifacts = loadArtifacts(files);
  const { buckets, ignored } = bucketArtifacts(artifacts);

  const report = reportPath
    ? loadReport(reportPath)
    : composeProcurementFamily({
        artifacts: buckets,
        requiredIdentityKeys,
        p40Required,
        enrichmentRequired: false,
        requiredQuantityCategories: [],
        requiredUnitCostCategories: [],
        requiredNarrativeSections: [],
      });

  if (write && !procurementCanonicalWritesEnabled()) {
    console.error(
      `${SCRIPT}: --write refused — ${PROCUREMENT_LINE_CANONICAL_WRITES_ENV} is not '1'. Re-run without --write for a dry-run, or set the env var to apply.`,
    );
    process.exit(3);
  }

  let prisma: { $disconnect(): Promise<void> } | null = null;
  let summary: ProcurementLineWriteSummary;
  try {
    if (write) {
      if (!process.env.DATABASE_URL) usage('DATABASE_URL is required for --write');
      const { PrismaClient } = await import('@prisma/client');
      const client = new PrismaClient();
      prisma = client;
      // PrismaClient is PrismaService's superclass; the writer uses only model
      // delegates + $transaction, so the plain client satisfies it.
      const writer = new ProcurementLineWriterService(client as unknown as PrismaService);
      summary = await writer.write({ artifacts: buckets, report, scope });
    } else {
      // Dry-run never touches Prisma; no client is constructed at all.
      const writer = new ProcurementLineWriterService(null as unknown as PrismaService);
      summary = await writer.write({ artifacts: buckets, report, scope }, { dryRun: true });
    }
  } finally {
    if (prisma) await prisma.$disconnect();
  }

  printHumanSummary(summary, ignored);
  process.stdout.write(`${JSON.stringify(summary, null, json ? 0 : 2)}\n`);
}

main().catch((error) => {
  console.error(`${SCRIPT}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
