/**
 * compare-defense-budget-canonical-reads-v1 (Phase 7 Workstream N) — read-only.
 *
 * Serves the same Program Element through the legacy path and the snapshot
 * path and reports how the two responses differ, classified and severity-rated
 * by `compareShadowReadV1`. This is the evidence Workstream M.10 requires
 * before a canary: zero unexplained P0/P1 mismatch.
 *
 *   compare-defense-budget-canonical-reads-v1 --environment <env> \
 *     --pe-codes <a,b,c> [--fy <year>] [--domain <domain>] [--details]
 *
 * Why it spawns itself once per mode rather than calling both paths in one
 * process: `PeSnapshotGateService` resolves the mode from `ConfigService`
 * (`PE_SNAPSHOT_READ_MODE`), which is bound when the Nest context boots. There
 * is no supported way to flip it mid-process, and reaching around the gate to
 * call the private legacy/snapshot methods directly would compare something
 * other than what the service actually serves — which is the one thing this
 * command exists to measure. So each mode gets its own boot, with the env var
 * set before the context is created.
 *
 * Exit codes: 0 no blocking mismatch, 3 a P0/P1 mismatch blocks the canary,
 * 2 usage, 1 error.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import {
  blocksCanaryV1,
  compareShadowReadV1,
  worstSeverityV1,
  type MismatchSeverityV1,
  type ReadMismatchClassV1,
  type ShadowComparisonV1,
} from '../src/defense-budget/promotion/shadow-read-comparison-v1.js';

dotenvConfig();

const DEFAULT_DOMAIN = 'defense_budget';
// `process.argv[1]` rather than `import.meta.url`: this package builds to
// CommonJS, where import.meta is a compile error (TS1470).
const SCRIPT_PATH = process.argv[1] ?? '';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function databaseHost(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return 'UNAVAILABLE';
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return 'UNPARSEABLE_DATABASE_URL';
  }
}

function gitSha(): string {
  return (
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ??
    'UNVERIFIED'
  );
}

function usage(message: string): never {
  console.error(`compare-defense-budget-canonical-reads-v1: ${message}`);
  process.exit(2);
}

interface ProbeResponseV1 {
  peCode: string;
  budgetPositions: unknown;
  pbComparison: unknown;
  budgetPositionsMs: number;
  pbComparisonMs: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Probe mode — one Nest boot, one read mode                           */
/* ------------------------------------------------------------------ */

async function runProbe(peCode: string, fy: number | undefined): Promise<void> {
  // Imported dynamically so the parent process never pays for booting Nest.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module.js');
  const { ProgramElementReadService } =
    await import('../src/program-element/program-element-read.service.js');

  const app = await NestFactory.createApplicationContext(AppModule as never, {
    logger: ['error'],
  });
  try {
    const service = app.get(ProgramElementReadService);

    const positionsStart = Date.now();
    const budgetPositions = await service.getBudgetPositions(peCode, fy);
    const budgetPositionsMs = Date.now() - positionsStart;

    const comparisonStart = Date.now();
    const pbComparison = await service.getPbComparison(peCode);
    const pbComparisonMs = Date.now() - comparisonStart;

    const response: ProbeResponseV1 = {
      peCode,
      budgetPositions,
      pbComparison,
      budgetPositionsMs,
      pbComparisonMs,
    };
    process.stdout.write(JSON.stringify(response));
  } finally {
    await app.close();
  }
}

/* ------------------------------------------------------------------ */
/* Parent mode — one probe per read mode, then compare                 */
/* ------------------------------------------------------------------ */

function probe(peCode: string, fy: number | undefined, mode: string): ProbeResponseV1 {
  const args = [
    'tsx',
    SCRIPT_PATH,
    '--__probe',
    '--pe-code',
    peCode,
    ...(fy !== undefined ? ['--fy', String(fy)] : []),
  ];
  const result = spawnSync('npx', args, {
    cwd: path.resolve(path.dirname(SCRIPT_PATH), '..'),
    encoding: 'utf8',
    // Set before the child boots, which is the only point the gate reads it.
    env: { ...process.env, PE_SNAPSHOT_READ_MODE: mode },
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = (result.stdout ?? '').trim();
  if (stdout === '') {
    return {
      peCode,
      budgetPositions: null,
      pbComparison: null,
      budgetPositionsMs: -1,
      pbComparisonMs: -1,
      error: `probe in ${mode} mode produced no output (status ${result.status}): ${(result.stderr ?? '').slice(-400)}`,
    };
  }
  try {
    return JSON.parse(stdout) as ProbeResponseV1;
  } catch {
    return {
      peCode,
      budgetPositions: null,
      pbComparison: null,
      budgetPositionsMs: -1,
      pbComparisonMs: -1,
      error: `probe in ${mode} mode did not return JSON: ${stdout.slice(0, 300)}`,
    };
  }
}

/** Strips the bodies: a comparison report must locate a difference, not quote it. */
function summarize(comparison: ShadowComparisonV1, includeDetails: boolean) {
  return {
    matched: comparison.matched,
    legacyDigest: comparison.legacyDigest,
    snapshotDigest: comparison.snapshotDigest,
    classes: comparison.classes,
    severity: comparison.severity,
    blocksCanary: comparison.blocksCanary,
    counts: comparison.counts,
    ...(includeDetails ? { details: comparison.details } : {}),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--__probe')) {
    const peCode = argValue('--pe-code');
    if (!peCode) usage('--pe-code is required in probe mode');
    const fyRaw = argValue('--fy');
    await runProbe(peCode, fyRaw != null ? Number(fyRaw) : undefined);
    return;
  }

  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const environment = argValue('--environment');
  const peCodesRaw = argValue('--pe-codes');
  const includeDetails = process.argv.includes('--details');

  if (!environment) usage('--environment is required');
  if (!peCodesRaw) usage('--pe-codes is required (comma-separated)');

  const peCodes = peCodesRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (peCodes.length === 0) usage('--pe-codes must name at least one program element');

  const fyRaw = argValue('--fy');
  const fy = fyRaw != null ? Number(fyRaw) : undefined;
  if (fy !== undefined && !Number.isInteger(fy)) usage(`--fy must be an integer (got ${fyRaw})`);

  const comparisons: Array<Record<string, unknown>> = [];
  const allClasses: ReadMismatchClassV1[] = [];
  let probeFailures = 0;

  for (const peCode of peCodes) {
    const legacy = probe(peCode, fy, 'legacy');
    const snapshot = probe(peCode, fy, 'snapshot');

    if (legacy.error != null || snapshot.error != null) {
      probeFailures += 1;
      comparisons.push({
        peCode,
        probed: false,
        legacyError: legacy.error ?? null,
        snapshotError: snapshot.error ?? null,
      });
      continue;
    }

    const positions = compareShadowReadV1({
      legacy: legacy.budgetPositions,
      snapshot: snapshot.budgetPositions,
      timing: { legacyMs: legacy.budgetPositionsMs, snapshotMs: snapshot.budgetPositionsMs },
    });
    const comparison = compareShadowReadV1({
      legacy: legacy.pbComparison,
      snapshot: snapshot.pbComparison,
      timing: { legacyMs: legacy.pbComparisonMs, snapshotMs: snapshot.pbComparisonMs },
    });

    allClasses.push(...positions.classes, ...comparison.classes);
    comparisons.push({
      peCode,
      probed: true,
      getBudgetPositions: summarize(positions, includeDetails),
      getPbComparison: summarize(comparison, includeDetails),
      timing: {
        legacyMs: legacy.budgetPositionsMs + legacy.pbComparisonMs,
        snapshotMs: snapshot.budgetPositionsMs + snapshot.pbComparisonMs,
      },
    });
  }

  const overallSeverity: MismatchSeverityV1 = worstSeverityV1(allClasses);
  const blocking = blocksCanaryV1(overallSeverity);

  console.log(
    JSON.stringify(
      {
        environment,
        domain,
        databaseHost: databaseHost(),
        gitSha: gitSha(),
        mode: 'compare',
        safety:
          'Read-only. No write statement issued. Differences are located, never quoted. No secrets included.',
        generatedAt: new Date().toISOString(),
        programElementCount: peCodes.length,
        probeFailures,
        overallSeverity,
        blocksCanary: blocking,
        canaryVerdict: blocking
          ? 'BLOCKED — resolve or explain every P0/P1 mismatch before enabling snapshot reads'
          : probeFailures > 0
            ? 'INCONCLUSIVE — at least one program element could not be probed'
            : 'CLEAR — no P0/P1 mismatch across the compared surfaces',
        comparisons,
      },
      null,
      2,
    ),
  );

  if (blocking || probeFailures > 0) process.exit(3);
}

void main().catch((error) => {
  console.error('compare-defense-budget-canonical-reads-v1 FAILED:', error);
  process.exit(1);
});
