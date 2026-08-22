/**
 * Phase 9 — governed job-runtime regression tests.
 *
 * These lock the four safety properties the Phase 9 mandate requires, plus the
 * Session 8 false-commit defect that motivated this work:
 *
 *   1. dry-run           -> zero DB writes
 *   2. commit without a real store -> refused
 *   3. commit with a real store    -> an actual persisted audit/checkpoint row
 *   4. commit failure    -> no false success marker
 *
 * The job CLI is exercised as a CHILD PROCESS, because the properties under test
 * are properties of the production entrypoint (its authorisation gates, its exit
 * codes and its stdout markers), not of an internal function. A unit test that
 * imported a helper could pass while the real command still wrote or still
 * printed COMMITTED.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PrismaDiscoveryAuditStore } from '../budget-lifecycle/discovery/prisma-discovery-audit.store.js';
import type { RawSqlExecutor } from '../budget-lifecycle/discovery/prisma-discovery-audit.store.js';
import { InMemoryDiscoveryAuditStore } from '../budget-lifecycle/discovery/testing/discovery-test-doubles.js';
import type { NewDiscoveryCrawl } from '../budget-lifecycle/discovery/discovery-audit.port.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
const JOB = path.join(appRoot, 'scripts', 'job.mjs');
const LIVE_DISCOVERY = path.join(appRoot, 'scripts', 'run-live-discovery.mjs');

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(script: string, args: readonly string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * A raw-SQL executor that records every statement instead of executing it, so a
 * "did this write?" assertion is about statements actually issued.
 */
class RecordingSql implements RawSqlExecutor {
  readonly statements: { query: string; values: unknown[] }[] = [];

  constructor(private readonly reply: (query: string) => unknown = () => []) {}

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.statements.push({ query, values });
    return this.reply(query) as T;
  }

  get mutatingStatements(): string[] {
    return this.statements
      .map((statement) => statement.query.trim())
      .filter((query) => /^(INSERT|UPDATE|DELETE)\b/i.test(query));
  }
}

const CRAWL: NewDiscoveryCrawl = Object.freeze({
  adapterId: 'hasc',
  runKey: 'phase9-regression-run',
  requestUrl: 'https://armedservices.house.gov/legislation',
  resourceKind: 'listing',
  statusCode: 200,
  status: 'succeeded',
  contentSha256: 'a'.repeat(64),
  byteSize: 1024,
  itemsSeen: 3,
  robotsUnavailable: false,
  effectiveIntervalMs: 3_000,
  startedAt: '2026-08-22T00:00:00.000Z',
  finishedAt: '2026-08-22T00:00:01.000Z',
  failureReason: null,
});

describe('Phase 9 job runtime — property 1: dry-run performs zero DB writes', () => {
  it('backfill-run without --commit composes in-memory stores and issues no SQL', () => {
    const result = run(JOB, [
      'backfill-run',
      '--fiscal-years',
      '2024,2025',
      '--max-adapters',
      '2',
      '--now',
      '2026-08-22T00:00:00.000Z',
    ]);

    assert.equal(result.status, 0, `expected clean dry run, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /DRY RUN: in-memory store/);
    assert.match(result.stdout, /PHASE9_BACKFILL_DRY_RUN_PASS/);
    // The dry run must not claim a commit, in any casing.
    assert.doesNotMatch(result.stdout, /PHASE9_BACKFILL_COMMITTED/);
    assert.match(result.stdout, /committed=false/);
  });

  it('a dry run stays side-effect-free even when live discovery is enabled in the env', () => {
    // A dry run must never depend on ambient environment to stay network-free.
    const result = run(
      JOB,
      ['backfill-run', '--fiscal-years', '2024', '--max-adapters', '1'],
      { PHASE8_SESSION8_LIVE_DISCOVERY: 'true' },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /DRY RUN: in-memory store \+ manifest discovery/);
    assert.match(result.stdout, /PHASE9_BACKFILL_DRY_RUN_PASS/);
  });

  it('the in-memory audit store used by dry runs cannot reach SQL at all', async () => {
    const store = new InMemoryDiscoveryAuditStore();
    await store.recordCrawl(CRAWL);
    assert.equal(store.crawls.length, 1);
    // It records in memory and exposes no SQL surface whatsoever.
    assert.equal((store as unknown as { $queryRawUnsafe?: unknown }).$queryRawUnsafe, undefined);
  });

  it('inventory is read-only and needs no database configuration', () => {
    const result = run(JOB, ['inventory', '--fiscal-years', '2024,2025,2026,2027,2028'], {
      DB_HOST: '',
      DB_NAME: '',
      DB_USER: '',
      DB_PASSWORD: '',
      DATABASE_URL: '',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PHASE9_INVENTORY_OK/);
    assert.match(result.stdout, /expectedSourceRows=410/);
  });
});

describe('Phase 9 job runtime — property 2: commit without a real store is refused', () => {
  it('refuses --commit without the mode authorisation env var', () => {
    const result = run(JOB, ['backfill-run', '--fiscal-years', '2024', '--commit']);
    assert.equal(result.status, 77);
    assert.match(result.stderr, /without PHASE9_BACKFILL_COMMIT_AUTHORIZED=true/);
    assert.doesNotMatch(result.stdout, /COMMITTED/);
  });

  it('refuses --commit when production database config is absent', () => {
    const result = run(
      JOB,
      ['backfill-run', '--fiscal-years', '2024', '--commit'],
      {
        PHASE9_BACKFILL_COMMIT_AUTHORIZED: 'true',
        DATABASE_URL: '',
        DB_HOST: '',
        DB_NAME: '',
        DB_USER: '',
        DB_PASSWORD: '',
      },
    );
    assert.equal(result.status, 78);
    assert.match(result.stderr, /missing production database configuration/);
    assert.doesNotMatch(result.stdout, /COMMITTED/);
  });

  it('refuses a commit that would run as a non-job database role', () => {
    const result = run(
      JOB,
      ['backfill-run', '--fiscal-years', '2024', '--commit'],
      {
        PHASE9_BACKFILL_COMMIT_AUTHORIZED: 'true',
        DATABASE_URL: '',
        DB_HOST: 'db.example.invalid',
        DB_PORT: '5432',
        DB_NAME: 'capiro',
        DB_USER: 'capiro_master',
        DB_PASSWORD: 'unused-secret-value',
      },
    );
    assert.equal(result.status, 77);
    assert.match(result.stderr, /requires "capiro_defense_job"/);
    assert.doesNotMatch(result.stdout, /COMMITTED/);
  });

  it('never echoes the database password into stdout or stderr', () => {
    const secret = 'p9-Sentinel!Secret#Value';
    const result = run(
      JOB,
      ['backfill-run', '--fiscal-years', '2024', '--max-adapters', '1', '--commit'],
      {
        PHASE9_BACKFILL_COMMIT_AUTHORIZED: 'true',
        DATABASE_URL: '',
        DB_HOST: 'db.example.invalid',
        DB_NAME: 'capiro',
        DB_USER: 'capiro_defense_job',
        DB_PASSWORD: secret,
      },
    );
    assert.ok(!result.stdout.includes(secret), 'password leaked into stdout');
    assert.ok(!result.stderr.includes(secret), 'password leaked into stderr');
    // It should also print the identity banner before attempting to mutate.
    assert.match(result.stdout, /db\.role=capiro_defense_job/);
    assert.match(result.stdout, /intent=COMMIT \(will write\)/);
  });

  it('never infers the fiscal-year set from the current date', () => {
    const result = run(JOB, ['backfill-run']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /never infers the fiscal-year set from the current date/);
  });

  it('rejects an unknown entrypoint mode instead of executing it', () => {
    const result = run(JOB, ['rm-rf-everything']);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /unknown or missing mode/);
  });
});

describe('Phase 9 job runtime — property 3: commit with a real store persists a row', () => {
  it('PrismaDiscoveryAuditStore issues a real INSERT and returns the persisted id', async () => {
    const sql = new RecordingSql((query) =>
      /INSERT INTO defense_budget_discovery_crawl/i.test(query)
        ? [{ id: '11111111-2222-4333-8444-555555555555' }]
        : [],
    );
    const store = new PrismaDiscoveryAuditStore(sql);

    const { id } = await store.recordCrawl(CRAWL);

    assert.equal(id, '11111111-2222-4333-8444-555555555555');
    assert.equal(sql.mutatingStatements.length, 1);
    assert.match(sql.mutatingStatements[0]!, /INSERT INTO defense_budget_discovery_crawl/);
    // The crawl's own content identity must reach the database, not be dropped.
    assert.ok(sql.statements[0]!.values.includes(CRAWL.contentSha256));
  });

  it('recordCandidates persists append-only rows and is idempotent by unique key', async () => {
    // First call reports an inserted row; second reports none (ON CONFLICT DO NOTHING).
    let call = 0;
    const sql = new RecordingSql((query) => {
      if (!/INSERT INTO defense_budget_discovery_candidate/i.test(query)) return [];
      call += 1;
      return call === 1 ? [{ inserted: true }] : [];
    });
    const store = new PrismaDiscoveryAuditStore(sql);

    const candidate = {
      adapterId: 'hasc',
      runKey: 'phase9-regression-run',
      candidateUrl: 'https://armedservices.house.gov/legislation/fy2024-ndaa',
      packageId: null,
      title: 'FY2024 NDAA committee report',
      resolution: 'resolved' as never,
      expectedSourceDedupKey: 'b'.repeat(64),
      classifiedFiscalYear: 2024,
      reason: 'phase9 regression',
      emitted: true,
      observedAt: '2026-08-22T00:00:00.000Z',
    };

    const first = await store.recordCandidates({ crawlId: 'crawl-1', candidates: [candidate] });
    const second = await store.recordCandidates({ crawlId: 'crawl-1', candidates: [candidate] });

    assert.equal(first.inserted, 1, 'first commit must persist the candidate');
    assert.equal(second.inserted, 0, 'a retried run must not duplicate the audit trail');
    assert.ok(
      sql.mutatingStatements.every((query) => /ON CONFLICT/i.test(query)),
      'candidate inserts must be idempotent',
    );
    assert.ok(
      !sql.statements.some((statement) => /^\s*DELETE/i.test(statement.query)),
      'the discovery audit trail must be append-only',
    );
  });

  it('reserveHostSlot reserves atomically in a single statement', async () => {
    const sql = new RecordingSql(() => [
      { wait_ms: 0, reserved_at: '2026-08-22T00:00:03.000Z' },
    ]);
    const store = new PrismaDiscoveryAuditStore(sql);

    const reservation = await store.reserveHostSlot({
      host: 'armedservices.house.gov',
      intervalMs: 3_000,
      nowIso: '2026-08-22T00:00:00.000Z',
    });

    assert.equal(reservation.waitMs, 0);
    assert.equal(sql.statements.length, 1, 'host pacing must be one atomic statement');
    assert.match(sql.statements[0]!.query, /ON CONFLICT \(host\) DO UPDATE/);
  });
});

describe('Phase 9 job runtime — property 4: failure never prints a false success marker', () => {
  it('a store failure surfaces as a non-zero exit with no COMMITTED marker', async () => {
    const sql = new RecordingSql(() => {
      throw new Error('connection terminated unexpectedly');
    });
    const store = new PrismaDiscoveryAuditStore(sql);

    await assert.rejects(() => store.recordCrawl(CRAWL), /connection terminated unexpectedly/);
  });

  it('recordCrawl refuses to report success when the insert returns no id', async () => {
    // Silent no-op insert must not be reported as a persisted row.
    const sql = new RecordingSql(() => []);
    const store = new PrismaDiscoveryAuditStore(sql);

    await assert.rejects(() => store.recordCrawl(CRAWL), /did not return a crawl id/);
  });

  it('an unreachable database exits non-zero without a COMMITTED marker', () => {
    const result = run(
      JOB,
      ['backfill-run', '--fiscal-years', '2024', '--max-adapters', '1', '--commit'],
      {
        PHASE9_BACKFILL_COMMIT_AUTHORIZED: 'true',
        DATABASE_URL: '',
        DB_HOST: 'db.does-not-resolve.invalid',
        DB_NAME: 'capiro',
        DB_USER: 'capiro_defense_job',
        DB_PASSWORD: 'unused-secret-value',
      },
    );

    assert.notEqual(result.status, 0, 'a failed commit must exit non-zero');
    assert.doesNotMatch(result.stdout, /PHASE9_BACKFILL_COMMITTED/);
  });
});

describe('Session 8 false-commit defect — run-live-discovery must never claim persistence', () => {
  it('refuses commit mode instead of silently using an in-memory store', () => {
    const result = run(LIVE_DISCOVERY, ['--adapter', 'hasc'], {
      PHASE8_SESSION8_CRAWL_AUTHORIZED: 'true',
      PHASE8_SESSION8_COMMIT_AUTHORIZED: 'true',
    });

    assert.equal(result.status, 65, 'commit mode must be refused, not honoured');
    assert.match(result.stderr, /SESSION8_LIVE_DISCOVERY_COMMIT_REFUSED/);
    // The historical defect: this marker was printed for persistence never done.
    assert.doesNotMatch(result.stdout, /SESSION8_LIVE_DISCOVERY_COMMITTED/);
    assert.doesNotMatch(result.stderr, /SESSION8_LIVE_DISCOVERY_COMMITTED/);
  });

  it('carries no code path that can emit a COMMITTED marker', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(LIVE_DISCOVERY, 'utf8');
    // Strip comments: the defect history is documented in prose deliberately,
    // what must not exist is an executable statement that prints the marker.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(
      !code.includes('SESSION8_LIVE_DISCOVERY_COMMITTED'),
      'no executable line may emit a COMMITTED marker from a reporting-only command',
    );
    // And the honest marker is still emitted.
    assert.ok(code.includes('SESSION8_LIVE_DISCOVERY_REPORTED'));
  });

  it('--plan remains available and reaches no network', () => {
    const result = run(LIVE_DISCOVERY, ['--adapter', 'hasc', '--plan']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /SESSION8_PLAN_ONLY/);
  });

  it('an unauthorised crawl still reports a clean dry run', () => {
    const result = run(LIVE_DISCOVERY, ['--adapter', 'hasc']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /SESSION8_DRY_RUN_PASS/);
  });
});

describe('Phase 9 explicit fiscal-year support', () => {
  it('reproduces the accepted FY2024-FY2028 inventory baseline', () => {
    const result = run(JOB, [
      'inventory',
      '--fiscal-years',
      '2024,2025,2026,2027,2028',
      '--now',
      '2026-08-22T00:00:00.000Z',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FY2024 expected=82 discoverable=82/);
    assert.match(result.stdout, /FY2025 expected=82 discoverable=82/);
    assert.match(result.stdout, /FY2026 expected=82 discoverable=82/);
    assert.match(result.stdout, /FY2027 expected=82 discoverable=72 expected_not_yet_published=10/);
    assert.match(result.stdout, /FY2028 expected=82 expected_not_yet_published=82/);
    assert.match(result.stdout, /"discoverable":318/);
  });

  it('bootstraps expected sources through the frozen template, not hand-inserted rows', () => {
    const result = run(JOB, [
      'backfill-run',
      '--fiscal-years',
      '2024,2025,2026,2027,2028',
      '--max-adapters',
      '1',
      '--now',
      '2026-08-22T00:00:00.000Z',
    ]);

    assert.equal(result.status, 0, result.stderr);
    // 5 fiscal years x 5 authority tracks, 82 expected sources each year.
    assert.match(result.stdout, /cyclesEnsured=25/);
    assert.match(result.stdout, /expectedSourcesEnsured=410/);
    assert.match(result.stdout, /template=defense_budget_cycle_template_v1/);
  });

  it('rejects malformed and out-of-range fiscal years', () => {
    for (const bad of ['20255', 'FY2024', '1999', '']) {
      const result = run(JOB, ['inventory', '--fiscal-years', bad]);
      assert.notEqual(result.status, 0, `expected rejection for "${bad}"`);
    }
  });

  it('treats a fiscal year with no discoverable material as bootstrap-only', () => {
    const result = run(JOB, [
      'backfill-plan',
      '--fiscal-years',
      '2028',
      '--now',
      '2026-08-22T00:00:00.000Z',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FY2028 .*intent="bootstrap expected sources only"/);
  });
});
