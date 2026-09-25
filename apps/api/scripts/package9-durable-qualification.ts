import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import {
  drainIngestionOutboxBatchV1,
  drainIngestionOutboxRowV1,
  type IngestionOutboxDrainWorkerPortsV1,
} from '../../defense-api/runtime-source/defense-budget/ingestion-outbox-drain-worker-v1.js';
import { createIngestionOutboxDrainRepositoryPrismaV1 } from '../../defense-api/runtime-source/defense-budget/ingestion-outbox-drain-repository-prisma-v1.js';
import type { ObservationIngestionBridgeResult } from '../../defense-api/runtime-source/defense-budget/observation-ingestion-bridge.service.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const QUALIFICATION_DIR = resolve(REPO_ROOT, 'docs/defense-budget/package-9');
const EVIDENCE_DIR = resolve(QUALIFICATION_DIR, 'evidence');
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const LEASE_MS = 250;
const MAX_QUEUE_ROWS = 100;
const FAMILY = ['pb_r1', 'pb_p1', 'pb_o1', 'pb_milcon_c1'] as const;
const FIXED_NOW = new Date('2026-09-25T00:00:00.000Z');
const SCENARIO_ROWS = {
  crash: 0,
  lease: 1,
  retry: 2,
  source: 3,
  provider_timeout: 4,
  provider_429: 5,
  provider_malformed: 6,
  provider_5xx: 7,
} as const;
const ORDINAL_BY_OBSERVATION = new Map(
  Array.from(
    { length: MAX_QUEUE_ROWS },
    (_, ordinal) => [observationId(ordinal), ordinal] as const,
  ),
);
type FaultName = keyof typeof SCENARIO_ROWS;

interface QuerySample {
  elapsedMs: number;
  operation: string;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableUuid(value: string): string {
  const bytes = Buffer.from(sha(value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function execute(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32' && command !== 'docker',
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function docker(args: string[]) {
  return execute('docker', args);
}

function connectionString(hostPort: string, password: string): string {
  const url = new URL(
    `postgresql://p9qual:${encodeURIComponent(password)}@${hostPort}/p9qualification`,
  );
  url.searchParams.set('schema', 'public');
  return url.toString();
}

function createDatabaseAdapter(pool: Pool, samples: QuerySample[]) {
  async function timedQuery<T extends QueryResult = QueryResult>(
    query: string,
    values: unknown[] = [],
    operation = query.trim().split(/\s+/).slice(0, 3).join(' '),
  ): Promise<T> {
    const started = performance.now();
    try {
      return (await pool.query(query, values)) as T;
    } finally {
      samples.push({ elapsedMs: performance.now() - started, operation });
    }
  }
  return {
    timedQuery,
    prismaLike: {
      async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
        return (await timedQuery(query, values, 'outbox repository')).rows as T;
      },
    },
  };
}

async function queryRows<T = Record<string, unknown>>(
  pool: Pool,
  samples: QuerySample[],
  query: string,
  values: unknown[] = [],
  operation = 'fixture query',
): Promise<T[]> {
  const started = performance.now();
  try {
    return (await pool.query(query, values)).rows as T[];
  } finally {
    samples.push({ elapsedMs: performance.now() - started, operation });
  }
}

async function withTransaction<T>(
  pool: Pool,
  samples: QuerySample[],
  operation: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    samples.push({ elapsedMs: performance.now() - started, operation: `${operation}:transaction` });
    client.release();
  }
}

function observationId(ordinal: number): string {
  return stableUuid(`package9-observation-${ordinal.toString().padStart(3, '0')}`);
}

function outboxId(ordinal: number): string {
  return stableUuid(`package9-outbox-${ordinal.toString().padStart(3, '0')}`);
}

function expectedSourceId(familyIndex: number): string {
  return stableUuid(`package9-expected-source-${familyIndex}`);
}

const CYCLE_ID = stableUuid('package9-qualification-cycle');

async function seedWorkload(pool: Pool, samples: QuerySample[]) {
  const adapter = createDatabaseAdapter(pool, samples);
  await adapter.timedQuery(
    `CREATE TABLE "p9_qual_evidence" (
       "run_id" TEXT NOT NULL,
       "source_fact_id" TEXT NOT NULL,
       "evidence_sha256" CHAR(64) NOT NULL,
       "committed_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
       PRIMARY KEY ("run_id", "source_fact_id")
     )`,
    [],
    'create evidence ledger',
  );
  await adapter.timedQuery(
    `CREATE TABLE "p9_qual_notifications" (
       "run_id" TEXT NOT NULL,
       "logical_notification_key" TEXT NOT NULL,
       "payload_sha256" CHAR(64) NOT NULL,
       "committed_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
       PRIMARY KEY ("run_id", "logical_notification_key")
     )`,
    [],
    'create notification ledger',
  );
  await adapter.timedQuery(
    `CREATE TABLE "p9_qual_attempts" (
       "run_id" TEXT NOT NULL,
       "source_fact_id" TEXT NOT NULL,
       "attempt_kind" TEXT NOT NULL,
       "detail" TEXT NOT NULL,
       "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
     )`,
    [],
    'create attempt ledger',
  );
  await adapter.timedQuery(
    `CREATE FUNCTION "p9_qual_refuse_ledger_mutation"() RETURNS trigger AS $$
     BEGIN RAISE EXCEPTION 'Package 9 qualification ledgers are append-only'; END;
     $$ LANGUAGE plpgsql`,
    [],
    'create immutable-ledger guard',
  );
  await adapter.timedQuery(
    `CREATE TRIGGER "p9_qual_evidence_append_only"
       BEFORE UPDATE OR DELETE ON "p9_qual_evidence"
       FOR EACH ROW EXECUTE FUNCTION "p9_qual_refuse_ledger_mutation"()`,
    [],
    'protect evidence ledger',
  );
  await adapter.timedQuery(
    `CREATE TRIGGER "p9_qual_notifications_append_only"
       BEFORE UPDATE OR DELETE ON "p9_qual_notifications"
       FOR EACH ROW EXECUTE FUNCTION "p9_qual_refuse_ledger_mutation"()`,
    [],
    'protect notification ledger',
  );
  await adapter.timedQuery(
    `INSERT INTO "defense_budget_cycle"
       ("id", "fiscal_year", "authority_track", "template_version", "bootstrap_origin", "dedup_key")
     VALUES ($1::uuid, 2027, 'request', 'package9-qualification-v1', 'operator', $2)`,
    [CYCLE_ID, sha('package9-cycle-dedup')],
    'seed cycle',
  );
  for (let familyIndex = 0; familyIndex < FAMILY.length; familyIndex++) {
    const family = FAMILY[familyIndex]!;
    await adapter.timedQuery(
      `INSERT INTO "defense_budget_expected_source"
         ("id", "cycle_id", "fiscal_year", "authority_track", "stage", "source_family",
          "adapter_id", "label", "template_version", "expected_from", "expected_to", "dedup_key")
       VALUES ($1::uuid, $2::uuid, 2027, 'request', 'request', $3, $4, $3,
               'package9-qualification-v1', $5::timestamptz, $5::timestamptz, $6)`,
      [
        expectedSourceId(familyIndex),
        CYCLE_ID,
        family,
        `p9-local-${family}`,
        FIXED_NOW,
        sha(`p9-es-${family}`),
      ],
      `seed expected source ${family}`,
    );
  }
  for (let ordinal = 0; ordinal < MAX_QUEUE_ROWS; ordinal++) {
    const familyIndex = ordinal % FAMILY.length;
    const family = FAMILY[familyIndex]!;
    const observation = observationId(ordinal);
    const outbox = outboxId(ordinal);
    const contentSha = sha(`package9-synthetic-source-bytes-${ordinal}`);
    await adapter.timedQuery(
      `INSERT INTO "defense_budget_source_observation"
         ("id", "expected_source_id", "cycle_id", "adapter_id", "discovered_url",
          "content_sha256", "observation_state", "revision_kind", "classified_fiscal_year",
          "classified_authority_track", "classified_stage", "classified_source_family",
          "classification_confidence", "dedup_key", "first_seen_at", "last_seen_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'queued', 'first_discovery', 2027,
               'request', 'request', $7, 1, $8, $9::timestamptz, $9::timestamptz)`,
      [
        observation,
        expectedSourceId(familyIndex),
        CYCLE_ID,
        `p9-local-${family}`,
        `fixture://package9/${family}/${ordinal}`,
        contentSha,
        family,
        sha(`p9-observation-dedup-${ordinal}`),
        FIXED_NOW,
      ],
      `seed source observation ${ordinal}`,
    );
    await adapter.timedQuery(
      `INSERT INTO "defense_budget_ingestion_outbox"
         ("id", "observation_id", "observation_state", "cycle_id", "job_kind", "state",
          "attempts", "available_at", "dedup_key", "created_at", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'queued', $3::uuid, 'governed_source_ingestion',
               'pending', 0, $4::timestamptz, $5, $4::timestamptz, $4::timestamptz)`,
      [outbox, observation, CYCLE_ID, FIXED_NOW, sha(`p9-outbox-dedup-${ordinal}`)],
      `seed outbox row ${ordinal}`,
    );
  }
}

function bridgeResult(observation: string): ObservationIngestionBridgeResult {
  return {
    status: 'ingested',
    ingestionSucceeded: true,
    observationId: observation,
    sourceDocumentId: `p9-synthetic-document-${observation}`,
    reason: 'package9-local-durable-qualification',
    sourceDocumentBound: true,
    parserVerificationSucceeded: true,
    durableEvidencePersisted: true,
    parserHandoffInvoked: true,
    parserHandoffError: null,
    verifierDecision: 'PASS',
  };
}

function makePorts(input: {
  pool: Pool;
  samples: QuerySample[];
  repository: ReturnType<typeof createIngestionOutboxDrainRepositoryPrismaV1>;
  runId: string;
  faults?: Map<string, FaultName>;
  crashAfterCommitObservationId?: string;
  onEvidenceCommitted?: (observation: string) => Promise<void>;
}): IngestionOutboxDrainWorkerPortsV1 {
  const seenFaults = new Set<string>();
  return {
    repository: input.repository,
    async loadObservationScope(observation) {
      const ordinal = ORDINAL_BY_OBSERVATION.get(observation);
      if (ordinal === undefined) throw new Error(`Unknown synthetic observation ${observation}`);
      return {
        classifiedSourceFamily: FAMILY[ordinal % FAMILY.length]!,
        authorityTrack: 'request',
        fiscalYear: 2027,
      };
    },
    async invokeReadiness() {
      return { outcome: 'awaiting_authorization' };
    },
    bridge: {
      async bridge(observation) {
        const fault = input.faults?.get(observation);
        if (fault && !seenFaults.has(observation)) {
          seenFaults.add(observation);
          await queryRows(
            input.pool,
            input.samples,
            `INSERT INTO "p9_qual_attempts" ("run_id", "source_fact_id", "attempt_kind", "detail")
             VALUES ($1, $2, $3, $4)`,
            [input.runId, observation, fault, `injected local ${fault}`],
            `record ${fault}`,
          );
          throw new Error(`injected local ${fault}`);
        }
        await persistAcceptedFact(input.pool, input.samples, input.runId, observation);
        if (observation === input.crashAfterCommitObservationId) {
          if (input.onEvidenceCommitted) await input.onEvidenceCommitted(observation);
          process.exit(73);
        }
        return bridgeResult(observation);
      },
    },
  };
}

async function persistAcceptedFact(
  pool: Pool,
  samples: QuerySample[],
  runId: string,
  observation: string,
) {
  await withTransaction(
    pool,
    samples,
    'commit synthetic evidence and notification',
    async (client) => {
      const factId = `fact:${observation}`;
      const logicalKey = `verified:${observation}`;
      await client.query(
        `INSERT INTO "p9_qual_evidence" ("run_id", "source_fact_id", "evidence_sha256")
       VALUES ($1, $2, $3) ON CONFLICT ("run_id", "source_fact_id") DO NOTHING`,
        [runId, factId, sha(`evidence:${observation}`)],
      );
      await client.query(
        `INSERT INTO "p9_qual_notifications" ("run_id", "logical_notification_key", "payload_sha256")
       VALUES ($1, $2, $3) ON CONFLICT ("run_id", "logical_notification_key") DO NOTHING`,
        [runId, logicalKey, sha(`notification:${observation}`)],
      );
    },
  );
}

async function queueSnapshot(pool: Pool, samples: QuerySample[], label: string) {
  const rows = await queryRows<{ state: string; count: string; oldest: Date | null }>(
    pool,
    samples,
    `SELECT "state", count(*)::text AS "count", min("created_at") AS "oldest"
       FROM "defense_budget_ingestion_outbox" GROUP BY "state"`,
    [],
    `queue snapshot ${label}`,
  );
  const counts = Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
  const oldestTimestamp = rows
    .map((row) => row.oldest)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    label,
    capturedAt: new Date().toISOString(),
    pending: counts.pending ?? 0,
    leased: counts.leased ?? 0,
    succeeded: counts.succeeded ?? 0,
    deadLetter: counts.dead_letter ?? 0,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    oldestRowAgeMs: oldestTimestamp ? Math.max(0, Date.now() - oldestTimestamp.getTime()) : null,
  };
}

async function waitForPostgres(containerId: string) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = spawnSync(
      'docker',
      [
        'exec',
        containerId,
        'psql',
        '-X',
        '-qAt',
        '-U',
        'p9qual',
        '-d',
        'p9qualification',
        '-c',
        'SELECT 1',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    if (result.status === 0 && result.stdout.trim() === '1') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error('Disposable PostgreSQL did not become ready within 90 seconds.');
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!.toFixed(3));
}

async function crashChild() {
  const runId = process.env.P9_QUAL_RUN_ID!;
  const crashObservationId = process.env.P9_QUAL_CRASH_OBSERVATION_ID!;
  const now = new Date(process.env.P9_QUAL_FIXED_NOW!);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const samples: QuerySample[] = [];
  const { prismaLike } = createDatabaseAdapter(pool, samples);
  const repository = createIngestionOutboxDrainRepositoryPrismaV1(prismaLike, {
    leaseMs: LEASE_MS,
  });
  const ports = makePorts({
    pool,
    samples,
    repository,
    runId,
    crashAfterCommitObservationId: crashObservationId,
  });
  await drainIngestionOutboxRowV1(
    {
      leaseOwner: 'p9-crashing-worker',
      now,
      rowId: outboxId(SCENARIO_ROWS.crash),
    },
    ports,
  );
  await pool.end();
  throw new Error('Crash injection was not reached.');
}

async function removeContainer(containerId: string | undefined, runId: string) {
  if (!containerId) return;
  const label = 'capiro.package9.run';
  const inspection = JSON.parse(docker(['inspect', containerId])) as Array<{
    Config?: { Labels?: Record<string, string> };
  }>;
  const actual = inspection[0]?.Config?.Labels?.[label];
  if (actual !== runId)
    throw new Error(`Refusing to remove container without matching ${label} label.`);
  docker(['stop', containerId]);
}

async function runQualification() {
  const runId = `p9-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomBytes(3).toString('hex')}`;
  const containerName = `${runId}-pg`;
  const password = randomBytes(24).toString('base64url');
  const containerId = docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--label',
    `capiro.package9.run=${runId}`,
    '--env',
    'POSTGRES_USER=p9qual',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=p9qualification',
    '--publish',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);
  let pool: Pool | undefined;
  const samples: QuerySample[] = [];
  const rawEvidence: Record<string, unknown> = {
    schemaVersion: 1,
    package: 9,
    qualification: 'durable-outbox-failure-recovery-local',
    runId,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    environment: {
      kind: 'disposable-local-postgresql',
      image: POSTGRES_IMAGE,
      containerId,
      containerName,
      publishedHost: '127.0.0.1 only, ephemeral host port',
      mountedVolumes: false,
      externalServices: false,
      paidProviderCalls: 0,
      productionData: false,
    },
    limits: { peakQueueRows: 100, workers: 4, deadLetterMax: 10, leaseMsForHarness: LEASE_MS },
    workload: {
      seed: 'package9-durable-qualification-v1',
      acceptedFactTarget: 100,
      sourceFamilies: FAMILY,
      faultRows: SCENARIO_ROWS,
      providerFaultFixtures: ['timeout', '429', 'malformed', '5xx'],
    },
    queueSamples: [],
    scenarioResults: [],
    rawTimingSamplesMs: samples,
    unqualifiedGates: {
      alarmDelivery: 'NOT_RUN',
      rollback: 'NOT_RUN',
      sustainedLatency: 'NOT_RUN',
      commonQueryP95: 'NOT_RUN',
      awsCost: 'NOT_RUN',
      paidProviderEconomics: 'NOT_RUN',
      buyerBenchmark: 'NOT_RUN',
      independentAccuracy: 'NOT_RUN',
    },
  };
  try {
    const address = docker(['port', containerId, '5432/tcp']);
    const hostPort = address.replace(/^127\.0\.0\.1:/, '127.0.0.1:');
    const databaseUrl = connectionString(hostPort, password);
    const env = { ...process.env, DATABASE_URL: databaseUrl };
    await waitForPostgres(containerId);
    // One historical identity migration grants capiro_app CONNECT ON DATABASE
    // capiro. Create that empty compatibility database only inside this
    // disposable server; the qualification rows live in p9qualification.
    docker(['exec', containerId, 'createdb', '-U', 'p9qual', 'capiro']);
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
      { env },
    );
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const { prismaLike } = createDatabaseAdapter(pool, samples);
    const repository = createIngestionOutboxDrainRepositoryPrismaV1(prismaLike, {
      leaseMs: LEASE_MS,
    });
    await seedWorkload(pool, samples);
    const queueSamples = rawEvidence.queueSamples as unknown[];
    queueSamples.push(await queueSnapshot(pool, samples, 'seeded-peak'));

    const crashStarted = performance.now();
    const crashObservation = observationId(SCENARIO_ROWS.crash);
    const childEnv = {
      ...env,
      P9_QUAL_CHILD_MODE: 'crash',
      P9_QUAL_RUN_ID: runId,
      P9_QUAL_CRASH_OBSERVATION_ID: crashObservation,
      P9_QUAL_FIXED_NOW: FIXED_NOW.toISOString(),
    };
    const child = spawnSync(
      process.execPath,
      [
        resolve(REPO_ROOT, 'apps/api/node_modules/tsx/dist/cli.mjs'),
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: REPO_ROOT,
        env: childEnv,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
      },
    );
    if (child.error) throw child.error;
    const afterCrash = await queryRows<{ state: string; count: string }>(
      pool,
      samples,
      `SELECT "state", count(*)::text AS "count" FROM "defense_budget_ingestion_outbox"
       WHERE "id"=$1::uuid GROUP BY "state"`,
      [outboxId(SCENARIO_ROWS.crash)],
      'verify crash boundary',
    );
    const crashEvidence = await queryRows<{ count: string }>(
      pool,
      samples,
      `SELECT count(*)::text AS "count" FROM "p9_qual_evidence" WHERE "run_id"=$1 AND "source_fact_id"=$2`,
      [runId, `fact:${crashObservation}`],
      'verify durable crash evidence',
    );
    if (
      child.status !== 73 ||
      afterCrash[0]?.state !== 'leased' ||
      crashEvidence[0]?.count !== '1'
    ) {
      throw new Error(
        `Crash boundary failed: status=${child.status}; outbox=${JSON.stringify(afterCrash)}; evidence=${JSON.stringify(crashEvidence)}; stderr=${child.stderr}`,
      );
    }
    const recoveryTime = new Date(FIXED_NOW.getTime() + LEASE_MS + 1);
    const recoveredCrash = await drainIngestionOutboxRowV1(
      {
        leaseOwner: 'p9-crash-recovery',
        now: recoveryTime,
        rowId: outboxId(SCENARIO_ROWS.crash),
      },
      makePorts({ pool, samples, repository, runId }),
    );
    (rawEvidence.scenarioResults as unknown[]).push({
      id: 'crash-after-evidence-before-ack',
      status: recoveredCrash.succeeded === 1 ? 'PASS' : 'FAIL',
      childExitCode: child.status,
      preRecoveryState: afterCrash[0]?.state,
      committedEvidenceBeforeRecovery: Number(crashEvidence[0]?.count ?? 0),
      recovery: recoveredCrash,
      elapsedMs: performance.now() - crashStarted,
    });

    const leaseObservation = observationId(SCENARIO_ROWS.lease);
    let signalCommitted!: () => void;
    const committed = new Promise<void>((resolvePromise) => {
      signalCommitted = resolvePromise;
    });
    let releaseStale!: () => void;
    const hold = new Promise<void>((resolvePromise) => {
      releaseStale = resolvePromise;
    });
    let firstLeaseCall = true;
    const leasePorts = makePorts({
      pool,
      samples,
      repository,
      runId,
      onEvidenceCommitted: async (observation) => {
        if (observation === leaseObservation && firstLeaseCall) {
          firstLeaseCall = false;
          signalCommitted();
          await hold;
        }
      },
    });
    const leaseStarted = performance.now();
    const staleWorker = drainIngestionOutboxRowV1(
      {
        leaseOwner: 'p9-stale-worker',
        now: FIXED_NOW,
        rowId: outboxId(SCENARIO_ROWS.lease),
      },
      leasePorts,
    );
    await committed;
    const replacementWorker = await drainIngestionOutboxRowV1(
      {
        leaseOwner: 'p9-replacement-worker',
        now: new Date(FIXED_NOW.getTime() + LEASE_MS + 1),
        rowId: outboxId(SCENARIO_ROWS.lease),
      },
      makePorts({ pool, samples, repository, runId }),
    );
    releaseStale();
    const staleResult = await staleWorker;
    (rawEvidence.scenarioResults as unknown[]).push({
      id: 'lease-expiry-stale-fencing',
      status: replacementWorker.succeeded === 1 && staleResult.leaseLost === 1 ? 'PASS' : 'FAIL',
      staleOwner: staleResult,
      replacementOwner: replacementWorker,
      elapsedMs: performance.now() - leaseStarted,
    });

    const faultByObservation = new Map<string, FaultName>(
      [
        ['retry', SCENARIO_ROWS.retry],
        ['source', SCENARIO_ROWS.source],
        ['provider_timeout', SCENARIO_ROWS.provider_timeout],
        ['provider_429', SCENARIO_ROWS.provider_429],
        ['provider_malformed', SCENARIO_ROWS.provider_malformed],
        ['provider_5xx', SCENARIO_ROWS.provider_5xx],
      ].map(([name, ordinal]) => [observationId(ordinal), name as FaultName]),
    );
    for (const [observation, fault] of faultByObservation) {
      const ordinal = Object.values(SCENARIO_ROWS).find(
        (row) => observationId(row) === observation,
      )!;
      const faultStarted = performance.now();
      const first = await drainIngestionOutboxRowV1(
        {
          leaseOwner: `p9-${fault}-first`,
          now: recoveryTime,
          rowId: outboxId(ordinal),
        },
        makePorts({ pool, samples, repository, runId, faults: new Map([[observation, fault]]) }),
      );
      const second = await drainIngestionOutboxRowV1(
        {
          leaseOwner: `p9-${fault}-retry`,
          now: new Date(recoveryTime.getTime() + 2_000),
          rowId: outboxId(ordinal),
        },
        makePorts({ pool, samples, repository, runId }),
      );
      (rawEvidence.scenarioResults as unknown[]).push({
        id: fault,
        status: first.retried === 1 && second.succeeded === 1 ? 'PASS' : 'FAIL',
        firstAttempt: first,
        recoveryAttempt: second,
        elapsedMs: performance.now() - faultStarted,
      });
    }
    queueSamples.push(await queueSnapshot(pool, samples, 'fault-scenarios-recovered'));

    let activeWorkers = 0;
    let maxConcurrentWorkers = 0;
    const workerStarted = performance.now();
    const workerResults = await Promise.all(
      Array.from({ length: 4 }, async (_, worker) => {
        activeWorkers++;
        maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers);
        try {
          return await drainIngestionOutboxBatchV1(
            {
              leaseOwner: `p9-load-worker-${worker}`,
              now: new Date(recoveryTime.getTime() + 10_000),
              batchSize: 25,
            },
            makePorts({ pool, samples, repository, runId }),
          );
        } finally {
          activeWorkers--;
        }
      }),
    );
    const loadElapsedMs = performance.now() - workerStarted;
    queueSamples.push(await queueSnapshot(pool, samples, 'drained'));
    const ledgers = await queryRows<{
      evidence: string;
      notifications: string;
      duplicateKeys: string;
      missingEvidence: string;
      missingNotifications: string;
    }>(
      pool,
      samples,
      `SELECT
         (SELECT count(*) FROM "p9_qual_evidence" WHERE "run_id"=$1)::text AS evidence,
         (SELECT count(*) FROM "p9_qual_notifications" WHERE "run_id"=$1)::text AS notifications,
         (SELECT count(*) FROM (SELECT "logical_notification_key" FROM "p9_qual_notifications" WHERE "run_id"=$1 GROUP BY 1 HAVING count(*) > 1) d)::text AS "duplicateKeys",
         (SELECT count(*) FROM "defense_budget_ingestion_outbox" o
            JOIN "defense_budget_source_observation" s ON s."id"=o."observation_id"
            LEFT JOIN "p9_qual_evidence" e ON e."run_id"=$1 AND e."source_fact_id"=('fact:' || s."id"::text)
           WHERE e."source_fact_id" IS NULL)::text AS "missingEvidence",
         (SELECT count(*) FROM "defense_budget_ingestion_outbox" o
            JOIN "defense_budget_source_observation" s ON s."id"=o."observation_id"
            LEFT JOIN "p9_qual_notifications" n ON n."run_id"=$1 AND n."logical_notification_key"=('verified:' || s."id"::text)
           WHERE n."logical_notification_key" IS NULL)::text AS "missingNotifications"`,
      [runId],
      'reconcile durable fact and notification ledgers',
    );
    const familyCounts = await queryRows<{ family: string; count: string }>(
      pool,
      samples,
      `SELECT "classified_source_family" AS family, count(*)::text AS count
         FROM "defense_budget_source_observation" GROUP BY "classified_source_family" ORDER BY family`,
      [],
      'reconcile source-family distribution',
    );
    const finalLedger = ledgers[0]!;
    const scenarioResults = rawEvidence.scenarioResults as Array<{ status: string }>;
    const workloadPass =
      Number(finalLedger.evidence) === MAX_QUEUE_ROWS &&
      Number(finalLedger.notifications) === MAX_QUEUE_ROWS &&
      Number(finalLedger.duplicateKeys) === 0 &&
      Number(finalLedger.missingEvidence) === 0 &&
      Number(finalLedger.missingNotifications) === 0 &&
      (queueSamples[2] as { pending: number; leased: number; deadLetter: number }).pending === 0 &&
      workerResults.reduce((sum, result) => sum + result.succeeded, 0) === MAX_QUEUE_ROWS - 8 &&
      maxConcurrentWorkers === 4;
    const measuredChecks = [
      {
        id: 'peak-queue-cap',
        status: (queueSamples[0] as { total: number }).total <= MAX_QUEUE_ROWS ? 'PASS' : 'FAIL',
        measuredRows: (queueSamples[0] as { total: number }).total,
        limit: MAX_QUEUE_ROWS,
      },
      {
        id: 'four-worker-synthetic-load',
        status: workloadPass ? 'PASS' : 'FAIL',
        workerResults,
        maxConcurrentWorkers,
        elapsedMs: loadElapsedMs,
      },
      {
        id: 'zero-lost-facts-zero-duplicate-logical-notifications',
        status: workloadPass ? 'PASS' : 'FAIL',
        ledgerCounts: finalLedger,
      },
      {
        id: 'family-mix',
        status:
          familyCounts.length === FAMILY.length &&
          familyCounts.every((row) => Number(row.count) === 25)
            ? 'PASS'
            : 'FAIL',
        familyCounts,
      },
    ];
    rawEvidence.status = [...scenarioResults, ...measuredChecks].every(
      (result) => result.status === 'PASS',
    )
      ? 'PASS_LIMITED_SCOPE'
      : 'FAIL';
    rawEvidence.finishedAt = new Date().toISOString();
    rawEvidence.queueSamples = queueSamples;
    rawEvidence.metrics = {
      measuredAcceptedFacts: Number(finalLedger.evidence),
      measuredDurableLogicalNotifications: Number(finalLedger.notifications),
      measuredDuplicateLogicalNotificationKeys: Number(finalLedger.duplicateKeys),
      missingFactEvidence: Number(finalLedger.missingEvidence),
      missingLogicalNotifications: Number(finalLedger.missingNotifications),
      maxQueueRows: Math.max(...queueSamples.map((sample) => (sample as { total: number }).total)),
      maxConcurrentWorkers,
      workerDrainElapsedMs: Number(loadElapsedMs.toFixed(3)),
      databaseQueryLatencyMs: {
        sampleCount: samples.length,
        min: percentile(
          samples.map((sample) => sample.elapsedMs),
          0.01,
        ),
        p50: percentile(
          samples.map((sample) => sample.elapsedMs),
          0.5,
        ),
        p95: percentile(
          samples.map((sample) => sample.elapsedMs),
          0.95,
        ),
        max: percentile(
          samples.map((sample) => sample.elapsedMs),
          1,
        ),
      },
      rawDatabaseQuerySamples: samples,
    };
    rawEvidence.measuredChecks = measuredChecks;
    const output = resolve(EVIDENCE_DIR, `durable-run-${runId}.json`);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(rawEvidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: rawEvidence.status, output })}\n`);
    if (rawEvidence.status !== 'PASS_LIMITED_SCOPE') process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
    await removeContainer(containerId, runId);
  }
}

if (process.env.P9_QUAL_CHILD_MODE === 'crash') {
  void crashChild().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  void runQualification().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
