#!/usr/bin/env node
/**
 * Local-only sustained query benchmark for the compiled Session 12 product reader.
 * It provisions one uniquely named, loopback-only, no-volume Postgres container,
 * applies migrations, seeds only the Session 12 synthetic fixture corpus, and
 * always stops only the container it created. No AWS, live source, or provider calls.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(repoRoot, 'docs/defense-budget/package-9/evidence');
const manifestPath = path.join(repoRoot, 'docs/defense-budget/package-9/product-query-mix-v1.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const image = 'pgvector/pgvector:pg16';
const durationIndex = process.argv.indexOf('--duration-seconds');
const outputIndex = process.argv.indexOf('--output');
const durationSeconds = durationIndex >= 0 ? Number(process.argv[durationIndex + 1]) : manifest.durationSecondsDefault;
const requestedOutputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : null;
if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 1800) {
  throw new Error('--duration-seconds must be an integer from 1 through 1800.');
}

function execute(command, args, options = {}) {
  let executable = command;
  let executableArgs = args;
  if (process.platform === 'win32' && command === 'pnpm') {
    if (!process.env.npm_execpath) throw new Error('npm_execpath is required to invoke pnpm safely on Windows.');
    executable = process.execPath;
    executableArgs = [process.env.npm_execpath, ...args];
  }
  const result = spawnSync(executable, executableArgs, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: options.timeout ?? 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function docker(args) { return execFileSync('docker', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim(); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function urlFor(hostPort, username, password) {
  const url = new URL(`postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostPort}/capiro`);
  url.searchParams.set('schema', 'public');
  return url.toString();
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)].toFixed(3));
}
function countRows(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const candidate = Object.values(value).find((item) => Array.isArray(item));
    if (Array.isArray(candidate)) return candidate.length;
  }
  return null;
}
async function waitForPostgres(containerId) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = spawnSync('docker', ['exec', containerId, 'pg_isready', '-U', 'capiro', '-d', 'capiro'],
      { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return;
    await sleep(1000);
  }
  throw new Error('Disposable PostgreSQL did not become ready within 90 seconds.');
}
function nearestRows(arr, key) { return [...arr].sort((a, b) => String(a[key]).localeCompare(String(b[key]))); }

async function main() {
  const trackedChanges = execute('git', ['status', '--porcelain', '--untracked-files=no']);
  if (trackedChanges) throw new Error(`Commit tracked changes before recording an exact benchmark revision:\n${trackedChanges}`);
  const revision = execute('git', ['rev-parse', 'HEAD']);
  const runId = `p9q-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
  const outputPath = requestedOutputPath ?? path.join(evidenceDir, `product-query-${runId}.json`);
  const containerName = `${runId}-pg`;
  const password = randomBytes(24).toString('base64url');
  let containerId;
  let admin;
  let reader;
  let runError;
  const samples = [];
  const report = {
    schemaVersion: 1,
    package: 9,
    qualification: 'local-synthetic-product-query-sustained-load',
    classification: manifest.classification,
    runId,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    environment: { kind: 'disposable-local-postgresql', revision, image, containerName, loopbackOnly: true,
      mountedVolumes: false, sourceOrProviderCalls: 0, awsCalls: 0, customerData: false },
    durationSecondsRequested: durationSeconds,
    workload: manifest,
    manifestSha256: digest(JSON.stringify(manifest)),
    corpus: null,
    samples: null,
    metrics: null,
    updateLatency: { status: 'NOT_MEASURED', reason: 'The corpus has no source-change-to-verified-buyer-visible update event path.' },
  };
  try {
    containerId = docker(['run', '--detach', '--rm', '--name', containerName,
      '--label', `capiro.package9.query-run=${runId}`, '--env', 'POSTGRES_USER=capiro',
      '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=capiro',
      '--publish', '127.0.0.1::5432', image]);
    await waitForPostgres(containerId);
    const hostPort = docker(['port', containerId, '5432/tcp']).replace(/^127\.0\.0\.1:/, '127.0.0.1:');
    const adminUrl = urlFor(hostPort, 'capiro', password);
    const readerPassword = randomBytes(24).toString('base64url');
    const readerUrl = urlFor(hostPort, 'p9q_reader', readerPassword);
    const dbEnv = { ...process.env, DATABASE_URL: adminUrl };
    execute('pnpm', ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { env: dbEnv });
    docker(['exec', containerId, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'capiro', '-d', 'capiro', '-c',
      `CREATE ROLE p9q_reader LOGIN PASSWORD '${readerPassword}' IN ROLE capiro_defense_serve`]);
    execute('pnpm', ['turbo', 'run', 'build', "--filter=@capiro/defense-api^..."], { timeout: 15 * 60 * 1000 });
    execute('pnpm', ['--filter', '@capiro/defense-api', 'exec', 'prisma', 'generate', '--schema', 'prisma/schema.prisma']);
    execute('pnpm', ['--filter', '@capiro/defense-api', 'exec', 'nest', 'build']);
    execute(process.execPath, [path.join(repoRoot, 'scripts/seed-phase8-session12-corpus.mjs')], { env: dbEnv });

    const require = createRequire(import.meta.url);
    const { PrismaClient } = require(path.join(repoRoot, 'apps/defense-api/generated/prisma-client/index.js'));
    const { PrismaBudgetLifecycleReadStore } = require(path.join(repoRoot, 'apps/defense-api/dist/budget-lifecycle-product/prisma-budget-lifecycle-read.store.js'));
    const { BudgetLifecycleQueryService } = require(path.join(repoRoot, 'apps/defense-api/dist/budget-lifecycle-product/budget-lifecycle-query.service.js'));
    const { CycleHealthService } = require(path.join(repoRoot, 'apps/defense-api/dist/budget-lifecycle/cycle-health.service.js'));
    admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    reader = new PrismaClient({ datasources: { db: { url: readerUrl } } });
    const service = new BudgetLifecycleQueryService(new PrismaBudgetLifecycleReadStore(reader), new CycleHealthService());
    const sources = await service.listExpectedSources(2029, { authorityTrack: 'appropriations' });
    if (!sources.length) throw new Error('Session 12 corpus did not seed a FY2029 appropriations source detail row.');
    const detailId = sources[0].id;

    const corpusTables = ['defense_budget_cycle', 'defense_budget_expected_source', 'defense_budget_source_observation',
      'defense_budget_watcher_adapter', 'defense_budget_watcher_run', 'defense_budget_ingestion_outbox', 'defense_budget_schedule_tick'];
    const corpusRows = [];
    for (const table of corpusTables) {
      const rows = await admin.$queryRawUnsafe(`SELECT * FROM ${table} ORDER BY id`);
      corpusRows.push({ table, rows: nearestRows(rows, 'id') });
    }
    report.corpus = { seedScript: 'scripts/seed-phase8-session12-corpus.mjs',
      seedScriptSha256: digest(readFileSync(path.join(repoRoot, 'scripts/seed-phase8-session12-corpus.mjs'))),
      contentSha256: digest(JSON.stringify(corpusRows)), rowCounts: Object.fromEntries(corpusRows.map(({ table, rows }) => [table, rows.length])),
      inspectedBy: 'local admin read', servedBy: 'capiro_defense_serve member p9q_reader', detailId };

    const dispatch = {
      'cycle-health-fy2029': () => service.getCycleHealth(2029),
      'cycle-health-fy2030': () => service.getCycleHealth(2030),
      'expected-sources-fy2029-authorization': () => service.listExpectedSources(2029, { authorityTrack: 'authorization' }),
      'coverage-inventory-fy2029': () => service.getCoverageInventory(2029),
      'review-required-detail-fy2029': () => service.getExpectedSourceDetail(detailId),
      'review-queue-fy2029': () => service.listReviewQueue(2029),
      'lifecycle-signals-fy2029': () => service.listSignals(2029),
      'schedule-tick-health': () => service.getScheduleTickHealth(),
    };
    const cycle = manifest.operationCycle.flatMap(({ operation, weight }) => Array(weight).fill(operation));
    const clientCount = manifest.concurrentClients;
    const endAt = performance.now() + durationSeconds * 1000;
    const interval = manifest.clientIntervalMilliseconds;
    let nextProgressAt = performance.now() + 60_000;
    const callers = Array.from({ length: clientCount }, (_, clientIndex) => (async () => {
      let sequence = 0;
      while (performance.now() < endAt) {
        const operation = cycle[(sequence + clientIndex * Math.ceil(cycle.length / clientCount)) % cycle.length];
        const started = performance.now();
        const wallStarted = new Date().toISOString();
        try {
          const value = await dispatch[operation]();
          const body = JSON.stringify(value);
          samples.push({ client: clientIndex + 1, sequence, operation, method: 'service-read',
            wallStartedAt: wallStarted, durationMs: Number((performance.now() - started).toFixed(3)),
            outcome: 'success', responseBytes: Buffer.byteLength(body), resultCount: countRows(value) });
        } catch (error) {
          samples.push({ client: clientIndex + 1, sequence, operation, method: 'service-read',
            wallStartedAt: wallStarted, durationMs: Number((performance.now() - started).toFixed(3)),
            outcome: 'error', errorName: error instanceof Error ? error.name : 'UnknownError', responseBytes: null, resultCount: null });
        }
        sequence++;
        const now = performance.now();
        if (now >= nextProgressAt) {
          process.stdout.write(`progress ${Math.min(100, Math.floor(100 * (now - (endAt - durationSeconds * 1000)) / (durationSeconds * 1000)))}% samples=${samples.length}\n`);
          nextProgressAt = now + 60_000;
        }
        const remaining = interval - (performance.now() - started);
        if (remaining > 0) await sleep(Math.min(remaining, Math.max(0, endAt - performance.now())));
      }
    })());
    await Promise.all(callers);
    const durations = samples.map((sample) => sample.durationMs);
    const elapsedSeconds = Number(((performance.now() - (endAt - durationSeconds * 1000)) / 1000).toFixed(3));
    const errors = samples.filter((sample) => sample.outcome !== 'success');
    const counts = Object.fromEntries([...new Set(samples.map((sample) => sample.operation))].sort()
      .map((operation) => [operation, samples.filter((sample) => sample.operation === operation).length]));
    report.finishedAt = new Date().toISOString();
    report.status = errors.length === 0 && elapsedSeconds >= durationSeconds ? 'PASS_LOCAL_SYNTHETIC_SCOPE' : 'FAIL';
    report.metrics = { elapsedSeconds, requestedDurationSeconds: durationSeconds, concurrentClients: clientCount,
      targetAggregateRequestsPerSecond: clientCount * 1000 / interval, sampleCount: samples.length,
      errorCount: errors.length, operationCounts: counts,
      latencyMs: { min: Number(Math.min(...durations).toFixed(3)), p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95), max: Number(Math.max(...durations).toFixed(3)) },
      rawSamplesSha256: digest(JSON.stringify(samples)) };
    report.samples = samples;
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: report.status, output: outputPath, samples: samples.length,
      p95Ms: report.metrics.latencyMs.p95, errors: errors.length })}\n`);
    if (report.status !== 'PASS_LOCAL_SYNTHETIC_SCOPE') process.exitCode = 1;
  } catch (error) {
    runError = error;
  } finally {
    if (reader) await reader.$disconnect();
    if (admin) await admin.$disconnect();
    if (containerId) {
      const labels = JSON.parse(docker(['inspect', containerId]))[0]?.Config?.Labels ?? {};
      if (labels['capiro.package9.query-run'] !== runId) throw new Error('Refusing cleanup: generated container label mismatch.');
      docker(['stop', containerId]);
    }
  }
  if (runError) throw runError;
}

main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exit(1); });
