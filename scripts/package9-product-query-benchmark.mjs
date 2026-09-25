#!/usr/bin/env node
/**
 * Local-only sustained query benchmark for the compiled Session 12 product reader.
 * It provisions one uniquely named, loopback-only, no-volume Postgres container,
 * applies migrations, seeds only the Session 12 synthetic fixture corpus, and
 * always stops only the container it created. No AWS, live source, or provider calls.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
const durationSeconds =
  durationIndex >= 0 ? Number(process.argv[durationIndex + 1]) : manifest.durationSecondsDefault;
const requestedOutputPath =
  outputIndex >= 0 ? path.resolve(repoRoot, process.argv[outputIndex + 1]) : null;
if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 1800) {
  throw new Error('--duration-seconds must be an integer from 1 through 1800.');
}

function execute(command, args, options = {}) {
  let executable = command;
  let executableArgs = args;
  if (process.platform === 'win32' && command === 'pnpm') {
    if (!process.env.npm_execpath)
      throw new Error('npm_execpath is required to invoke pnpm safely on Windows.');
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
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
}

function docker(args) {
  return execFileSync('docker', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function urlFor(hostPort, username, password) {
  const url = new URL(
    `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostPort}/capiro`,
  );
  url.searchParams.set('schema', 'public');
  return url.toString();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(
    ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)].toFixed(3),
  );
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
    const result = spawnSync(
      'docker',
      ['exec', containerId, 'pg_isready', '-U', 'capiro', '-d', 'capiro'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status === 0) return;
    await sleep(1000);
  }
  throw new Error('Disposable PostgreSQL did not become ready within 90 seconds.');
}
function nearestRows(arr, key) {
  return [...arr].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

function fileDigest(file) {
  return digest(readFileSync(file));
}
function hashFiles(files) {
  return Object.fromEntries(
    files.map((file) => [path.relative(repoRoot, file).replaceAll('\\', '/'), fileDigest(file)]),
  );
}
function migrationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return migrationFiles(entryPath);
      return entry.isFile() && entry.name === 'migration.sql' ? [entryPath] : [];
    })
    .sort();
}
function assertCleanExceptTmp(ownedTemporaryPaths = []) {
  const allowed = ownedTemporaryPaths.map((item) =>
    path.relative(repoRoot, item).replaceAll('\\', '/'),
  );
  const entries = execute('git', ['status', '--porcelain', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter(Boolean);
  const unexpected = entries.filter((entry) => {
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/');
    const ownedTemporaryPath = allowed.some(
      (prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`),
    );
    return (
      status !== '??' ||
      (!(filePath === 'tmp' || filePath.startsWith('tmp/')) && !ownedTemporaryPath)
    );
  });
  if (unexpected.length)
    throw new Error(
      `Commit tracked changes; only untracked tmp/ scratch is permitted:\n${unexpected.join('\n')}`,
    );
}
function preserveForBuild(target, runId) {
  const backup = `${target}.${runId}.backup`;
  if (existsSync(target)) renameSync(target, backup);
  return { target, backup, hadOriginal: existsSync(backup) };
}
function restoreAfterBuild(saved) {
  if (!saved) return;
  rmSync(saved.target, { recursive: true, force: true });
  if (saved.hadOriginal) renameSync(saved.backup, saved.target);
}
function containerExists(containerId) {
  const result = spawnSync('docker', ['inspect', containerId], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return JSON.parse(result.stdout)[0] ?? null;
  if (result.stderr?.includes('No such object') || result.stderr?.includes('No such container'))
    return null;
  throw new Error(
    `Could not inspect benchmark container ${containerId}: ${result.stderr ?? result.error ?? 'unknown Docker error'}`,
  );
}

async function main() {
  assertCleanExceptTmp();
  const revision = execute('git', ['rev-parse', 'HEAD']);
  const runId = `p9q-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(4).toString('hex')}`;
  const outputPath = requestedOutputPath ?? path.join(evidenceDir, `product-query-${runId}.json`);
  const relativeOutput = path.relative(repoRoot, outputPath).replaceAll('\\', '/');
  if (!(
    relativeOutput.startsWith('tmp/') ||
    relativeOutput.startsWith('docs/defense-budget/package-9/evidence/')
  ))
    throw new Error('Output must be a new file under tmp/ or the Package 9 evidence directory.');
  if (existsSync(outputPath))
    throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
  const containerName = `${runId}-pg`;
  const password = randomBytes(24).toString('base64url');
  let containerId;
  let admin;
  let reader;
  let runError;
  let savedDist;
  let savedBuildInfo;
  const defenseApiRoot = path.join(repoRoot, 'apps/defense-api');
  const runtimeTempRoot = path.resolve(process.env.CAPIRO_P9Q_TEMP_ROOT ?? '');
  const systemTempRoot = path.resolve(tmpdir());
  if (
    process.env.CAPIRO_P9Q_CHILD !== '1' ||
    !runtimeTempRoot.startsWith(`${systemTempRoot}${path.sep}`)
  ) {
    throw new Error('The benchmark child requires its parent-owned isolated OS temp directory.');
  }
  const isolatedSchemaPath = path.join(
    defenseApiRoot,
    'prisma',
    `.package9-${runId}-schema.prisma`,
  );
  const isolatedPrismaClientRoot = path.join(runtimeTempRoot, 'prisma-client');
  const inputFiles = [
    fileURLToPath(import.meta.url),
    manifestPath,
    path.join(repoRoot, 'scripts/seed-phase8-session12-corpus.mjs'),
    path.join(repoRoot, 'apps/defense-api/prisma/schema.prisma'),
    path.join(
      repoRoot,
      'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-query.service.ts',
    ),
    path.join(
      repoRoot,
      'apps/defense-api/src/budget-lifecycle-product/prisma-budget-lifecycle-read.store.ts',
    ),
    path.join(repoRoot, 'apps/defense-api/src/budget-lifecycle/cycle-health.service.ts'),
  ];
  const migrationInputFiles = migrationFiles(path.join(repoRoot, 'apps/api/prisma/migrations'));
  const samples = [];
  const report = {
    schemaVersion: 1,
    package: 9,
    qualification: 'local-synthetic-product-query-sustained-load',
    classification: manifest.classification,
    runId,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    environment: {
      kind: 'disposable-local-postgresql',
      revision,
      image,
      containerName,
      loopbackOnly: true,
      mountedVolumes: false,
      sourceOrProviderCalls: 0,
      awsCalls: 0,
      customerData: false,
    },
    durationSecondsRequested: durationSeconds,
    workload: manifest,
    provenance: {
      inputFileSha256: hashFiles([...inputFiles, ...migrationInputFiles]),
      migrationFileCount: migrationInputFiles.length,
      migrationLedgerSha256: null,
      runtimeArtifactSha256: null,
    },
    manifestSha256: fileDigest(manifestPath),
    corpus: null,
    samples: null,
    metrics: null,
    updateLatency: {
      status: 'NOT_MEASURED',
      reason: 'The corpus has no source-change-to-verified-buyer-visible update event path.',
    },
  };
  try {
    containerId = docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--label',
      `capiro.package9.query-run=${runId}`,
      '--env',
      'POSTGRES_USER=capiro',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=capiro',
      '--publish',
      '127.0.0.1::5432',
      image,
    ]);
    await waitForPostgres(containerId);
    const hostPort = docker(['port', containerId, '5432/tcp']).replace(
      /^127\.0\.0\.1:/,
      '127.0.0.1:',
    );
    const adminUrl = urlFor(hostPort, 'capiro', password);
    const readerPassword = randomBytes(24).toString('base64url');
    const readerUrl = urlFor(hostPort, 'p9q_reader', readerPassword);
    const dbEnv = { ...process.env, DATABASE_URL: adminUrl };
    execute(
      'pnpm',
      [
        '--filter',
        '@capiro/api',
        'exec',
        'prisma',
        'migrate',
        'deploy',
        '--schema',
        'prisma/schema.prisma',
      ],
      { env: dbEnv },
    );
    docker([
      'exec',
      containerId,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-U',
      'capiro',
      '-d',
      'capiro',
      '-c',
      `CREATE ROLE p9q_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${readerPassword}'; GRANT USAGE ON SCHEMA public TO p9q_reader; GRANT SELECT ON TABLE defense_budget_cycle, defense_budget_expected_source, defense_budget_source_observation, defense_budget_source_bundle_member, defense_budget_watcher_adapter, defense_budget_watcher_run, defense_budget_ingestion_outbox, defense_budget_schedule_tick, defense_budget_lifecycle_signal TO p9q_reader;`,
    ]);
    const privilegeCheck = docker([
      'exec',
      containerId,
      'psql',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'capiro',
      '-d',
      'capiro',
      '-c',
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND (has_table_privilege('p9q_reader', c.oid, 'INSERT') OR has_table_privilege('p9q_reader', c.oid, 'UPDATE') OR has_table_privilege('p9q_reader', c.oid, 'DELETE') OR has_table_privilege('p9q_reader', c.oid, 'TRUNCATE') OR has_table_privilege('p9q_reader', c.oid, 'REFERENCES') OR has_table_privilege('p9q_reader', c.oid, 'TRIGGER'));`,
    ]);
    if (privilegeCheck !== '0')
      throw new Error(
        `Benchmark role has effective table write privileges on ${privilegeCheck} public tables.`,
      );
    savedDist = preserveForBuild(path.join(defenseApiRoot, 'dist'), runId);
    savedBuildInfo = preserveForBuild(path.join(defenseApiRoot, 'tsconfig.tsbuildinfo'), runId);
    execute('pnpm', ['turbo', 'run', 'build', '--filter=@capiro/defense-api^...'], {
      timeout: 15 * 60 * 1000,
    });
    const sourceSchema = readFileSync(
      path.join(repoRoot, 'apps/defense-api/prisma/schema.prisma'),
      'utf8',
    );
    const isolatedSchema = sourceSchema.replace(
      /output\s*=\s*"\.\.\/generated\/prisma-client"/,
      `output          = "${isolatedPrismaClientRoot.replaceAll('\\', '/')}"`,
    );
    if (isolatedSchema === sourceSchema)
      throw new Error('Could not redirect the Prisma client generator to isolated OS temp.');
    mkdirSync(path.dirname(isolatedSchemaPath), { recursive: true });
    writeFileSync(isolatedSchemaPath, isolatedSchema, { encoding: 'utf8', flag: 'wx' });
    execute('pnpm', [
      '--filter',
      '@capiro/defense-api',
      'exec',
      'prisma',
      'generate',
      '--schema',
      isolatedSchemaPath,
    ]);
    rmSync(isolatedSchemaPath, { force: true });
    execute('pnpm', ['--filter', '@capiro/defense-api', 'exec', 'nest', 'build']);
    if (
      !existsSync(
        path.join(defenseApiRoot, 'dist/budget-lifecycle/annual-cycle-controller.service.js'),
      )
    )
      throw new Error(
        'Defense API build reported success but did not emit the Session 12 reader/runtime artifact.',
      );
    execute(process.execPath, [path.join(repoRoot, 'scripts/seed-phase8-session12-corpus.mjs')], {
      env: dbEnv,
    });

    const require = createRequire(import.meta.url);
    const { PrismaClient } = require(path.join(isolatedPrismaClientRoot, 'index.js'));
    const { PrismaBudgetLifecycleReadStore } = require(
      path.join(
        repoRoot,
        'apps/defense-api/dist/budget-lifecycle-product/prisma-budget-lifecycle-read.store.js',
      ),
    );
    const { BudgetLifecycleQueryService } = require(
      path.join(
        repoRoot,
        'apps/defense-api/dist/budget-lifecycle-product/budget-lifecycle-query.service.js',
      ),
    );
    const { CycleHealthService } = require(
      path.join(repoRoot, 'apps/defense-api/dist/budget-lifecycle/cycle-health.service.js'),
    );
    report.provenance.runtimeArtifactSha256 = hashFiles([
      path.join(
        repoRoot,
        'apps/defense-api/dist/budget-lifecycle-product/budget-lifecycle-query.service.js',
      ),
      path.join(
        repoRoot,
        'apps/defense-api/dist/budget-lifecycle-product/prisma-budget-lifecycle-read.store.js',
      ),
      path.join(repoRoot, 'apps/defense-api/dist/budget-lifecycle/cycle-health.service.js'),
      path.join(isolatedPrismaClientRoot, 'index.js'),
    ]);
    const generatedClientKey = path
      .relative(repoRoot, path.join(isolatedPrismaClientRoot, 'index.js'))
      .replaceAll('\\', '/');
    report.provenance.runtimeArtifactSha256['isolated-prisma-client/index.js'] =
      report.provenance.runtimeArtifactSha256[generatedClientKey];
    delete report.provenance.runtimeArtifactSha256[generatedClientKey];
    report.environment.isolatedPrismaClient = 'parent-owned-os-temp';
    admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    reader = new PrismaClient({ datasources: { db: { url: readerUrl } } });
    const service = new BudgetLifecycleQueryService(
      new PrismaBudgetLifecycleReadStore(reader),
      new CycleHealthService(),
    );
    const sources = await service.listExpectedSources(2029, { authorityTrack: 'appropriations' });
    if (!sources.length)
      throw new Error('Session 12 corpus did not seed a FY2029 appropriations source detail row.');
    const detailId = sources[0].id;

    const corpusTables = [
      'defense_budget_cycle',
      'defense_budget_expected_source',
      'defense_budget_source_observation',
      'defense_budget_watcher_adapter',
      'defense_budget_watcher_run',
      'defense_budget_ingestion_outbox',
      'defense_budget_schedule_tick',
    ];
    const corpusRows = [];
    for (const table of corpusTables) {
      const rows = await admin.$queryRawUnsafe(`SELECT * FROM ${table} ORDER BY id`);
      corpusRows.push({ table, rows: nearestRows(rows, 'id') });
    }
    const appliedMigrations = await admin.$queryRawUnsafe(
      'SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name',
    );
    report.provenance.migrationLedgerSha256 = digest(JSON.stringify(appliedMigrations));
    const memberships = await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'p9q_reader')`,
    );
    if (memberships[0].count !== 0)
      throw new Error('Benchmark reader unexpectedly has role memberships.');
    report.readerPrivilegeCheck = {
      roleAttributes: 'LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
      directMemberships: memberships[0].count,
      publicTablesChecked: Number(
        await admin
          .$queryRawUnsafe(
            `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
          )
          .then((rows) => rows[0].count),
      ),
      effectiveTableWritePrivileges: 0,
      verified: true,
    };
    report.corpus = {
      seedScript: 'scripts/seed-phase8-session12-corpus.mjs',
      seedScriptSha256: fileDigest(path.join(repoRoot, 'scripts/seed-phase8-session12-corpus.mjs')),
      contentSha256: digest(JSON.stringify(corpusRows)),
      rowCounts: Object.fromEntries(corpusRows.map(({ table, rows }) => [table, rows.length])),
      inspectedBy: 'local admin read',
      servedBy: 'dedicated NOINHERIT p9q_reader with explicit SELECT grants',
      detailId,
    };

    const dispatch = {
      'cycle-health-fy2029': () => service.getCycleHealth(2029),
      'cycle-health-fy2030': () => service.getCycleHealth(2030),
      'expected-sources-fy2029-authorization': () =>
        service.listExpectedSources(2029, { authorityTrack: 'authorization' }),
      'coverage-inventory-fy2029': () => service.getCoverageInventory(2029),
      'review-required-detail-fy2029': () => service.getExpectedSourceDetail(detailId),
      'review-queue-fy2029': () => service.listReviewQueue(2029),
      'lifecycle-signals-fy2029': () => service.listSignals(2029),
      'schedule-tick-health': () => service.getScheduleTickHealth(),
    };
    const cycle = manifest.operationCycle.flatMap(({ operation, weight }) =>
      Array(weight).fill(operation),
    );
    const clientCount = manifest.concurrentClients;
    const schedulingStartedAt = performance.now();
    const endAt = schedulingStartedAt + durationSeconds * 1000;
    const interval = manifest.clientIntervalMilliseconds;
    let nextProgressAt = performance.now() + 60_000;
    const callers = Array.from({ length: clientCount }, (_, clientIndex) =>
      (async () => {
        let sequence = 0;
        while (performance.now() < endAt) {
          const operation =
            cycle[(sequence + clientIndex * Math.ceil(cycle.length / clientCount)) % cycle.length];
          const started = performance.now();
          const requestStartOffsetMs = Number((started - schedulingStartedAt).toFixed(3));
          const wallStarted = new Date().toISOString();
          try {
            const value = await dispatch[operation]();
            const body = JSON.stringify(value);
            samples.push({
              client: clientIndex + 1,
              sequence,
              operation,
              method: 'service-read',
              requestStartOffsetMs,
              wallStartedAt: wallStarted,
              durationMs: Number((performance.now() - started).toFixed(3)),
              outcome: 'success',
              responseBytes: Buffer.byteLength(body),
              resultCount: countRows(value),
            });
          } catch (error) {
            samples.push({
              client: clientIndex + 1,
              sequence,
              operation,
              method: 'service-read',
              requestStartOffsetMs,
              wallStartedAt: wallStarted,
              durationMs: Number((performance.now() - started).toFixed(3)),
              outcome: 'error',
              errorName: error instanceof Error ? error.name : 'UnknownError',
              errorCode: error?.code ?? error?.meta?.code ?? null,
              errorMessage:
                error instanceof Error ? error.message.slice(0, 400) : 'Unknown failure',
              responseBytes: null,
              resultCount: null,
            });
          }
          sequence++;
          const now = performance.now();
          if (now >= nextProgressAt) {
            process.stdout.write(
              `progress ${Math.min(100, Math.floor((100 * (now - (endAt - durationSeconds * 1000))) / (durationSeconds * 1000)))}% samples=${samples.length}\n`,
            );
            nextProgressAt = now + 60_000;
          }
          const remaining = interval - (performance.now() - started);
          if (remaining > 0)
            await sleep(Math.min(remaining, Math.max(0, endAt - performance.now())));
        }
      })(),
    );
    await Promise.all(callers);
    const durations = samples.map((sample) => sample.durationMs);
    const tailCompletionSeconds = Number(((performance.now() - endAt) / 1000).toFixed(3));
    const errors = samples.filter((sample) => sample.outcome !== 'success');
    const observedClients = new Set(samples.map((sample) => sample.client));
    const observedOperations = new Set(samples.map((sample) => sample.operation));
    const declaredOperations = [
      ...new Set(manifest.operationCycle.map(({ operation }) => operation)),
    ].sort();
    const observedOffsets = samples.map((sample) => sample.requestStartOffsetMs);
    const firstRequestStartOffsetMs = observedOffsets.length ? Math.min(...observedOffsets) : null;
    const finalRequestStartOffsetMs = observedOffsets.length ? Math.max(...observedOffsets) : null;
    const observedRequestStartSpanMs =
      firstRequestStartOffsetMs === null || finalRequestStartOffsetMs === null
        ? null
        : Number((finalRequestStartOffsetMs - firstRequestStartOffsetMs).toFixed(3));
    const finalRequestStartTailMs =
      finalRequestStartOffsetMs === null
        ? null
        : Number((durationSeconds * 1000 - finalRequestStartOffsetMs).toFixed(3));
    const allClientsObserved = observedClients.size === clientCount;
    const missingOperations = declaredOperations.filter(
      (operation) => !observedOperations.has(operation),
    );
    const completeClientIntervalCoverage =
      finalRequestStartTailMs !== null &&
      finalRequestStartTailMs >= 0 &&
      finalRequestStartTailMs <= interval;
    const counts = Object.fromEntries(
      [...new Set(samples.map((sample) => sample.operation))]
        .sort()
        .map((operation) => [
          operation,
          samples.filter((sample) => sample.operation === operation).length,
        ]),
    );
    report.finishedAt = new Date().toISOString();
    report.status =
      errors.length === 0 &&
      allClientsObserved &&
      missingOperations.length === 0 &&
      completeClientIntervalCoverage
        ? 'PASS_LOCAL_SYNTHETIC_SCOPE'
        : 'FAIL';
    report.metrics = {
      requestedRequestStartSchedulingWindowSeconds: durationSeconds,
      observedRequestStartSpanSeconds:
        observedRequestStartSpanMs === null
          ? null
          : Number((observedRequestStartSpanMs / 1000).toFixed(3)),
      requestStartWindowCoveragePercent:
        observedRequestStartSpanMs === null
          ? null
          : Number(((observedRequestStartSpanMs / (durationSeconds * 1000)) * 100).toFixed(2)),
      firstRequestStartOffsetMs,
      finalRequestStartOffsetMs,
      finalRequestStartTailMs,
      configuredClientIntervalMilliseconds: interval,
      allClientsObserved,
      observedClientCount: observedClients.size,
      declaredOperationCount: declaredOperations.length,
      observedOperationCount: observedOperations.size,
      missingOperations,
      requestStartWindowCoveredToDeadline: completeClientIntervalCoverage,
      tailCompletionSeconds,
      requestedDurationSeconds: durationSeconds,
      concurrentClients: clientCount,
      configuredMaximumAggregateRequestStartsPerSecond: (clientCount * 1000) / interval,
      sampleCount: samples.length,
      errorCount: errors.length,
      operationCounts: counts,
      latencyMs: {
        min: Number(Math.min(...durations).toFixed(3)),
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: Number(Math.max(...durations).toFixed(3)),
      },
      rawSamplesSha256: digest(JSON.stringify(samples)),
    };
    report.samples = samples;
    mkdirSync(path.dirname(outputPath), { recursive: true });
    assertCleanExceptTmp([savedDist?.backup, savedBuildInfo?.backup].filter(Boolean));
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    process.stdout.write(
      `${JSON.stringify({
        status: report.status,
        output: outputPath,
        samples: samples.length,
        p95Ms: report.metrics.latencyMs.p95,
        errors: errors.length,
        observedSpanSeconds: report.metrics.observedRequestStartSpanSeconds,
        finalStartTailMs: finalRequestStartTailMs,
        observedClients: observedClients.size,
        observedOperations: observedOperations.size,
      })}\n`,
    );
    if (report.status !== 'PASS_LOCAL_SYNTHETIC_SCOPE') process.exitCode = 1;
  } catch (error) {
    runError = error;
  } finally {
    try {
      if (reader) await reader.$disconnect();
      if (admin) await admin.$disconnect();
      if (containerId) {
        const info = containerExists(containerId);
        if (info) {
          const labels = info.Config?.Labels ?? {};
          if (labels['capiro.package9.query-run'] !== runId)
            throw new Error('Refusing cleanup: generated container label mismatch.');
          if (info.State?.Running) docker(['stop', containerId]);
        }
      }
    } catch (cleanupError) {
      if (runError)
        runError = new Error(`${runError.message}\nCleanup also failed: ${cleanupError.message}`, {
          cause: runError,
        });
      else runError = cleanupError;
    } finally {
      rmSync(isolatedSchemaPath, { force: true });
      restoreAfterBuild(savedBuildInfo);
      restoreAfterBuild(savedDist);
    }
  }
  if (runError) throw runError;
}

async function entrypoint() {
  if (process.env.CAPIRO_P9Q_CHILD === '1') {
    await main();
    return;
  }
  const runtimeTempRoot = mkdtempSync(path.join(tmpdir(), 'capiro-p9q-'));
  let child;
  let cleanupError;
  try {
    child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CAPIRO_P9Q_CHILD: '1',
          CAPIRO_P9Q_TEMP_ROOT: runtimeTempRoot,
        },
        stdio: 'inherit',
        windowsHide: true,
      },
    );
  } finally {
    try {
      rmSync(runtimeTempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (child?.error) throw child.error;
  if (cleanupError) throw cleanupError;
  if (child?.status !== 0)
    throw new Error(
      `Benchmark child failed with ${child?.signal ? `signal ${child.signal}` : `exit ${child?.status ?? 'unknown'}`}.`,
    );
}

entrypoint().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
