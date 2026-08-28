#!/usr/bin/env node
/**
 * Phase 9 — governed one-shot defense-budget job runtime.
 *
 * This is the production job interface. It is deliberately a CLOSED set of
 * named modes, not arbitrary shell execution: the container entrypoint dispatches
 * only these verbs, so a task-definition command override cannot turn the job
 * runtime into a general-purpose shell inside the VPC.
 *
 *   inventory        read-only. Enumerate what the system EXPECTS for an explicit
 *                    FY set from the frozen cycle template + adapter registry.
 *                    Touches no database and no network.
 *   backfill-plan    read-only. Explicit-FY plan: what would be bootstrapped and
 *                    which adapters would be crawled. Reads real due-state when a
 *                    database is configured.
 *   backfill-run     MUTATING when --commit. Bootstraps an explicit FY set via the
 *                    existing cycle-template machinery, then runs the real watcher
 *                    per adapter.
 *   lifecycle-watch  MUTATING when --commit. Single-adapter watcher run.
 *   schedule-tick    MUTATING when --commit. One schedule-coordinator tick.
 *   db-check         read-only. Connectivity + lifecycle-table visibility + role
 *                    identity proof. Used by the Phase 9 dark smoke.
 *   egress-check     read-only. HEAD/GET reachability of approved official hosts.
 *                    Issues no crawl and persists nothing.
 *
 * Safety contract for every mutating mode:
 *   - fails closed unless BOTH --commit and the mode's authorisation env var;
 *   - dry-run is the default and composes in-memory stores, so it cannot write;
 *   - refuses missing production credentials/config before doing anything;
 *   - prints the target database identity BEFORE mutating;
 *   - supports bounded execution (--max-adapters / --budget);
 *   - exits non-zero on partial/fatal failure;
 *   - never prints a COMMITTED marker unless persistence actually occurred.
 *
 * It installs no schedule, registers no route, activates no provider, and needs
 * no GPU.
 */

import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  JobPreflightError,
  assertCommitAuthorised,
  CAPABILITY_PROOF_SQL,
  assertLiveJobCapability,
  buildLiveDiscoveryOptions,
  evaluateCapabilityProof,
  resolveCapabilityRole,
  parseBound,
  parseFiscalYears,
  printTargetIdentity,
  resolveDatabaseIdentity,
} from './job-preflight.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');

const dist = (relative) => require(path.join(appRoot, 'dist/budget-lifecycle', relative));
function loadDomain() {
  // In the built image the workspace link farm resolves @capiro/defense-domain;
  // in a local worktree fall back to the package dist path.
  try {
    return require('@capiro/defense-domain');
  } catch {
    return require(path.join(repoRoot, 'packages/defense-domain/dist/index.js'));
  }
}
const domain = loadDomain();

const argv = process.argv.slice(2);
const mode = argv[0] ?? '';
const rest = argv.slice(1);
const flag = (name) => rest.includes(`--${name}`);
const value = (name, fallback = null) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 && rest[index + 1] && !rest[index + 1].startsWith('--')
    ? rest[index + 1]
    : fallback;
};

const MODES = Object.freeze([
  'inventory',
  'backfill-plan',
  'backfill-run',
  'lifecycle-watch',
  'schedule-tick',
  'db-check',
  'egress-check',
]);

function usage() {
  console.error(`usage: job.mjs <mode> [options]

modes:
  inventory        --fiscal-years 2024,2025,...   read-only, no DB, no network
  backfill-plan    --fiscal-years 2024,...        read-only
  backfill-run     --fiscal-years 2024,... [--commit] [--max-adapters N] [--adapters a,b]
  lifecycle-watch  --adapter <id> [--commit] [--manifest <path>]
                   [--source-discovery manifest|catalog] [--catalog-fiscal-years 2024]
                     manifest (default): network-free, requires --manifest or discovers nothing.
                     catalog: Phase 10B-5 bounded one-shot activation of
                       CatalogSourceDiscoveryAdapter for THIS invocation only -- reads the real
                       expected-source table (request track only, scoped to --catalog-fiscal-years),
                       requires --commit. Does NOT change the module-level SOURCE_DISCOVERY_PORT
                       default used by any other process/mode.
  schedule-tick    [--commit]
  db-check                                        read-only
  egress-check     [--hosts a,b]                  read-only

global:
  --now <iso>            override the clock (deterministic runs)
  --list-adapters        print the adapter registry and exit
`);
}

// ---------------------------------------------------------------------------
// Registry + fail-closed GPU independence (shared by all modes).
// ---------------------------------------------------------------------------
const { SourceAdapterRegistry } = dist('source-adapter.registry.js');
const registry = new SourceAdapterRegistry();

if (!MODES.includes(mode)) {
  if (mode === '--list-adapters' || flag('list-adapters')) {
    for (const adapter of registry.list()) {
      console.log(
        `${adapter.adapterId.padEnd(32)} ${adapter.discoveryMode.padEnd(16)} ` +
          `authoritative=${adapter.authoritative} hosts=${adapter.officialHosts.join(',')}`,
      );
    }
    process.exit(0);
  }
  console.error(`unknown or missing mode: "${mode}"`);
  usage();
  process.exit(64);
}

if (flag('list-adapters')) {
  for (const adapter of registry.list()) {
    console.log(
      `${adapter.adapterId.padEnd(32)} ${adapter.discoveryMode.padEnd(16)} ` +
        `authoritative=${adapter.authoritative} hosts=${adapter.officialHosts.join(',')}`,
    );
  }
  process.exit(0);
}

const providerEnv = domain.resolveWatcherGpuEnvironment(process.env);
const gpu = domain.assertWatcherRunnableWithoutGpu({
  providerRouting: providerEnv.providerRouting,
  activeGpuCapacity: providerEnv.activeGpuCapacity,
  requiresGpu: false,
});

const nowIso = value('now', new Date().toISOString());
const commit = flag('commit');

let prisma = null;

/** Open a real client only when a mode genuinely needs the database. */
function openPrisma(identity) {
  process.env.DATABASE_URL = identity.url;
  const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
  return new PrismaClient();
}

async function main() {
  switch (mode) {
    case 'inventory':
      return runInventory();
    case 'egress-check':
      return runEgressCheck();
    case 'db-check':
      return runDbCheck();
    case 'backfill-plan':
      return runBackfillPlan();
    case 'backfill-run':
      return runBackfillRun();
    case 'lifecycle-watch':
      return runLifecycleWatch();
    case 'schedule-tick':
      return runScheduleTick();
    default:
      usage();
      return 64;
  }
}

// ---------------------------------------------------------------------------
// inventory — read-only, no DB, no network.
// ---------------------------------------------------------------------------
function buildInventory(fiscalYears) {
  const crawler = dist('discovery/publisher-crawler.js');
  const templateVersion = domain.DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION;
  const nowMs = new Date(nowIso).getTime();

  const entryPointsByAdapter = Object.fromEntries(
    registry.list().map((a) => [a.adapterId, crawler.entryPointsFor(a.adapterId, fiscalYears)]),
  );

  const rows = [];
  for (const fiscalYear of fiscalYears) {
    // Use the SAME bootstrap machinery the mutating path uses, so the inventory
    // cannot drift from what backfill-run would actually create.
    const plan = domain.bootstrapFiscalYearCycle({
      fiscalYear,
      templateVersion,
      bootstrapOrigin: 'template',
    });
    for (const expected of plan.expectedSources) {
      const adapter = registry.has(expected.adapterId) ? registry.get(expected.adapterId) : null;
      let state;
      let reason;
      if (!adapter) {
        state = 'unsupported';
        reason = 'adapterId not present in the registry';
      } else if (!adapter.authoritative) {
        state = 'unsupported';
        reason = 'adapter is discovery-hint-only, cannot satisfy an expected source';
      } else if (nowMs < new Date(expected.expectedFrom).getTime()) {
        state = 'expected_not_yet_published';
        reason = `publication window opens ${expected.expectedFrom.slice(0, 10)}`;
      } else if (
        adapter.discoveryMode !== 'api' &&
        entryPointsByAdapter[expected.adapterId].length === 0
      ) {
        state = 'inaccessible';
        reason = `${adapter.discoveryMode} adapter has no wired entry point`;
      } else {
        state = 'discoverable';
        reason =
          nowMs > new Date(expected.expectedTo).getTime()
            ? `window closed ${expected.expectedTo.slice(0, 10)} (historical)`
            : 'window currently open';
      }
      rows.push({
        fiscalYear,
        authorityTrack: expected.authorityTrack,
        stage: expected.stage,
        sourceFamily: expected.sourceFamily,
        component: expected.component ?? null,
        chamber: expected.chamber ?? null,
        committee: expected.committee ?? null,
        adapterId: expected.adapterId,
        optional: expected.optional,
        expectedFrom: expected.expectedFrom,
        expectedTo: expected.expectedTo,
        dedupKey: expected.dedupKey,
        state,
        reason,
      });
    }
  }
  return { templateVersion, rows, entryPointsByAdapter };
}

function tally(rows, key) {
  const map = new Map();
  for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + 1);
  return Object.fromEntries([...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function runInventory() {
  const fiscalYears = parseFiscalYears(value('fiscal-years'));
  const { templateVersion, rows } = buildInventory(fiscalYears);

  console.log(`[phase9-inventory] templateVersion=${templateVersion}`);
  console.log(`[phase9-inventory] evaluatedAt=${nowIso}`);
  console.log(`[phase9-inventory] fiscalYears=${fiscalYears.join(',')}`);
  console.log(`[phase9-inventory] adapters=${registry.list().length}`);
  console.log(
    `[phase9-inventory] authorityTracks=${domain.AUTHORITY_TRACKS.join(',')} ` +
      `(${domain.AUTHORITY_TRACKS.length})`,
  );
  console.log(`[phase9-inventory] expectedSourceRows=${rows.length}`);

  for (const fiscalYear of fiscalYears) {
    const sub = rows.filter((row) => row.fiscalYear === fiscalYear);
    const byState = tally(sub, 'state');
    console.log(
      `[phase9-inventory] FY${fiscalYear} expected=${sub.length} ` +
        Object.entries(byState)
          .map(([state, count]) => `${state}=${count}`)
          .join(' '),
    );
  }
  console.log(`[phase9-inventory] TOTAL byState=${JSON.stringify(tally(rows, 'state'))}`);
  console.log(`[phase9-inventory] TOTAL byTrack=${JSON.stringify(tally(rows, 'authorityTrack'))}`);

  if (flag('json')) {
    console.log('PHASE9_INVENTORY_JSON_START');
    console.log(
      JSON.stringify(
        {
          templateVersion,
          evaluatedAt: nowIso,
          fiscalYears,
          authorityTracks: domain.AUTHORITY_TRACKS,
          adapters: registry.list().map((a) => a.adapterId),
          totals: { rows: rows.length, byState: tally(rows, 'state'), byTrack: tally(rows, 'authorityTrack') },
          byFiscalYear: Object.fromEntries(
            fiscalYears.map((fy) => {
              const sub = rows.filter((r) => r.fiscalYear === fy);
              return [`FY${fy}`, { expected: sub.length, byState: tally(sub, 'state') }];
            }),
          ),
          rows,
        },
        null,
        2,
      ),
    );
    console.log('PHASE9_INVENTORY_JSON_END');
  }

  console.log('PHASE9_INVENTORY_OK');
  return 0;
}

// ---------------------------------------------------------------------------
// egress-check — read-only reachability of approved official hosts.
// ---------------------------------------------------------------------------
async function runEgressCheck() {
  const explicit = value('hosts');
  const hosts = explicit
    ? explicit.split(',').map((host) => host.trim()).filter(Boolean)
    : [...new Set(registry.list().flatMap((adapter) => adapter.officialHosts))].sort();

  const timeoutMs = parseBound(value('timeout-ms'), 15_000, '--timeout-ms');
  console.log(`[phase9-egress] probing ${hosts.length} approved official host(s)`);

  let failures = 0;
  const reachable = new Set();
  for (const host of hosts) {
    const url = `https://${host}/`;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // GET, not a crawl: we read status only and never parse or persist.
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'capiro-defense-api-phase9-egress-check' },
      });
      reachable.add(host);
      console.log(
        `  OK        ${String(response.status).padEnd(4)} ${String(Date.now() - started).padEnd(6)}ms ${host}`,
      );
    } catch (error) {
      failures += 1;
      console.log(
        `  FAIL      ---  ${String(Date.now() - started).padEnd(6)}ms ${host} :: ${
          error?.message ?? error
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  console.log(`[phase9-egress] reachable=${hosts.length - failures} unreachable=${failures}`);

  // ---- Adapter coverage proof -------------------------------------------
  // Host-level reachability is NOT the Phase 10 gate. What matters is whether
  // every registered adapter retains at least ONE reachable authoritative
  // channel. An adapter may legitimately list several hostnames (canonical +
  // bare-domain alternates); losing an unused alternate is not a coverage loss.
  // An adapter with ZERO reachable channels IS a Phase 10 coverage blocker.
  //
  // Only meaningful when the probe covered every adapter host: a narrowed
  // `--hosts` run would otherwise manufacture false blockers.
  if (explicit) {
    console.log(
      '[phase9-coverage] skipped: --hosts narrowed the probe, so adapter coverage cannot ' +
        'be concluded from this run. Run without --hosts for the coverage proof.',
    );
    console.log(failures > 0 ? 'PHASE9_EGRESS_PARTIAL' : 'PHASE9_EGRESS_OK');
    return failures > 0 ? 1 : 0;
  }

  console.log('[phase9-coverage] mapping each adapter to its reachable channels');
  const blockers = [];
  for (const adapter of registry.list()) {
    const usable = adapter.officialHosts.filter((host) => reachable.has(host));
    const dead = adapter.officialHosts.filter((host) => !reachable.has(host));
    const status = usable.length > 0 ? 'COVERED' : 'NO_CHANNEL';
    if (usable.length === 0) blockers.push(adapter.adapterId);
    console.log(
      `  ${status.padEnd(11)} ${adapter.adapterId.padEnd(32)} ` +
        `reachable=[${usable.join(',')}]` +
        (dead.length > 0 ? ` unreachable=[${dead.join(',')}]` : ''),
    );
  }
  console.log(
    `[phase9-coverage] adapters=${registry.list().length} ` +
      `covered=${registry.list().length - blockers.length} blockers=${blockers.length}`,
  );

  if (blockers.length > 0) {
    // A genuine coverage blocker must be disclosed before any backfill.
    console.log(`[phase9-coverage] PHASE10_COVERAGE_BLOCKERS=${blockers.join(',')}`);
    console.log('PHASE9_ADAPTER_COVERAGE_BLOCKED');
    return 1;
  }
  console.log('PHASE9_ADAPTER_COVERAGE_OK');

  if (failures > 0) {
    // Documented, accepted condition: unreachable ALTERNATE hostnames while
    // every adapter still holds a working authoritative channel.
    console.log(
      '[phase9-egress] unreachable hosts are alternates; every adapter retains a ' +
        'working authoritative channel, so this does not block Phase 10.',
    );
    console.log('PHASE9_EGRESS_PARTIAL_COVERAGE_OK');
    return 0;
  }
  console.log('PHASE9_EGRESS_OK');
  return 0;
}

// ---------------------------------------------------------------------------
// db-check — read-only connectivity + table visibility + role proof.
// ---------------------------------------------------------------------------
const LIFECYCLE_TABLES = Object.freeze([
  'defense_budget_cycle',
  'defense_budget_expected_source',
  'defense_budget_source_observation',
  'defense_budget_watcher_adapter',
  'defense_budget_watcher_run',
  'defense_budget_ingestion_outbox',
  'defense_budget_lifecycle_signal',
  'defense_budget_discovery_crawl',
  'defense_budget_discovery_candidate',
  'defense_budget_discovery_host_budget',
  'defense_budget_schedule_tick',
  'defense_budget_review_resolution',
]);

async function runDbCheck() {
  const identity = resolveDatabaseIdentity();
  printTargetIdentity({ mode, commit: false, identity });

  prisma = openPrisma(identity);

  const actual = await prisma.$queryRawUnsafe(
    'SELECT current_user::text AS current_user, session_user::text AS session_user, ' +
      'current_database()::text AS database, version() AS version',
  );
  const row = actual[0] ?? {};
  console.log(`[phase9-db] connected current_user=${row.current_user} session_user=${row.session_user}`);
  console.log(`[phase9-db] database=${row.database}`);
  console.log(`[phase9-db] server=${String(row.version ?? '').split(',')[0]}`);

  // Report the SAME authoritative capability proof a commit would enforce, but
  // read-only: this is how an operator confirms the Phase 10 identity is correct
  // BEFORE authorising any write. Non-fatal here — db-check never mutates.
  const capabilityRole = resolveCapabilityRole();
  const proof = await prisma.$queryRawUnsafe(CAPABILITY_PROOF_SQL, capabilityRole);
  try {
    for (const line of evaluateCapabilityProof({
      mode,
      row: proof?.[0],
      capabilityRole,
    })) {
      console.log(line);
    }
    console.log(`[phase9-identity] CAPABILITY_PROOF_OK via=${capabilityRole}`);
    console.log('PHASE9_COMMIT_IDENTITY_READY');
  } catch (error) {
    // Print the observed facts, then the reason, without failing the read-only check.
    const r = proof?.[0] ?? {};
    console.log(`[phase9-identity] current_user=${r.current_user}`);
    console.log(`[phase9-identity] session_user=${r.session_user}`);
    console.log(`[phase9-identity] capabilityRole=${capabilityRole}`);
    console.log(`[phase9-identity] pg_has_role(member)=${r.is_member}`);
    console.log(`[phase9-identity] pg_has_role(usage/inherited)=${r.inherits_capability}`);
    console.log(`[phase9-identity] CAPABILITY_PROOF_WOULD_REFUSE: ${error.message}`);
    console.log('PHASE9_COMMIT_IDENTITY_NOT_READY');
  }

  let missing = 0;
  for (const table of LIFECYCLE_TABLES) {
    const found = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public.${table}')::text AS reg`,
    );
    if (!found[0]?.reg) {
      missing += 1;
      console.log(`  ABSENT    ${table}`);
      continue;
    }
    // Read-only count: proves SELECT grant as well as presence.
    const counted = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`);
    console.log(`  visible   ${String(counted[0].n).padEnd(8)} ${table}`);
  }

  console.log(`[phase9-db] lifecycleTables=${LIFECYCLE_TABLES.length} absent=${missing}`);
  if (missing > 0) {
    console.log('PHASE9_DB_CHECK_INCOMPLETE');
    return 1;
  }
  console.log('PHASE9_DB_CHECK_OK');
  return 0;
}

// ---------------------------------------------------------------------------
// backfill-plan / backfill-run — explicit fiscal-year set, never date-inferred.
// ---------------------------------------------------------------------------
function selectAdapters() {
  const requested = value('adapters');
  const all = registry.list().map((adapter) => adapter.adapterId);
  if (!requested) return all;
  const chosen = requested.split(',').map((id) => id.trim()).filter(Boolean);
  for (const id of chosen) {
    if (!registry.has(id)) {
      throw new JobPreflightError(`--adapters contains unknown adapter "${id}"`, 64);
    }
  }
  return chosen;
}

async function runBackfillPlan() {
  const fiscalYears = parseFiscalYears(value('fiscal-years'));
  const adapterIds = selectAdapters();
  const { templateVersion, rows } = buildInventory(fiscalYears);

  console.log(`[phase9-backfill-plan] templateVersion=${templateVersion}`);
  console.log(`[phase9-backfill-plan] fiscalYears=${fiscalYears.join(',')} (explicit, not date-inferred)`);
  console.log(`[phase9-backfill-plan] adapters=${adapterIds.length}`);

  for (const fiscalYear of fiscalYears) {
    const sub = rows.filter((row) => row.fiscalYear === fiscalYear);
    const discoverable = sub.filter((row) => row.state === 'discoverable').length;
    const notYet = sub.filter((row) => row.state === 'expected_not_yet_published').length;
    // FY with zero discoverable material is a bootstrap-only year: expected
    // sources are created, nothing is claimed to exist.
    const intent = discoverable === 0 ? 'bootstrap expected sources only' : 'bootstrap + crawl';
    console.log(
      `[phase9-backfill-plan] FY${fiscalYear} expected=${sub.length} discoverable=${discoverable} ` +
        `notYetPublished=${notYet} intent="${intent}"`,
    );
  }

  // Read real due-state only if a database is configured; the plan stays useful
  // without one (e.g. a pre-deploy sanity check).
  try {
    const identity = resolveDatabaseIdentity();
    printTargetIdentity({ mode, commit: false, identity });
    prisma = openPrisma(identity);
    const { PrismaScheduleAuditStore } = dist('schedule/prisma-schedule-audit.store.js');
    const scheduleAudit = new PrismaScheduleAuditStore(prisma);
    const snapshots = await scheduleAudit.loadAdapterScheduleStates(adapterIds);
    for (const adapterId of adapterIds) {
      const decision = domain.evaluateAdapterDue({
        adapterId,
        state: snapshots.get(adapterId) ?? null,
        nowIso,
      });
      console.log(
        `  ${decision.due ? 'DUE    ' : 'not due'} ${adapterId.padEnd(32)} ${decision.reason}`,
      );
    }
  } catch (error) {
    if (error instanceof JobPreflightError) {
      console.log(`[phase9-backfill-plan] no database configured; skipping live due-state (${error.message})`);
    } else {
      throw error;
    }
  }

  console.log('PHASE9_BACKFILL_PLAN_ONLY');
  return 0;
}

async function runBackfillRun() {
  const fiscalYears = parseFiscalYears(value('fiscal-years'));
  const adapterIds = selectAdapters();
  const maxAdapters = parseBound(value('max-adapters'), adapterIds.length, '--max-adapters');
  const bounded = adapterIds.slice(0, maxAdapters);

  assertCommitAuthorised({ mode, commit });

  const { AnnualDefenseBudgetCycleController } = dist('annual-cycle-controller.service.js');
  const { DefenseBudgetLifecycleWatcher } = dist('lifecycle-watcher.service.js');
  const { ManifestSourceDiscoveryAdapter } = dist('manifest-source-discovery.adapter.js');
  const { LiveSourceDiscoveryAdapter } = dist('discovery/live-source-discovery.adapter.js');
  const { GovInfoSitemapCrawler } = dist('discovery/govinfo-sitemap.crawler.js');
  const { IndexPageCrawler } = dist('discovery/index-page.crawler.js');
  const { HttpsPublisherHttpAdapter } = dist('discovery/https-publisher-http.adapter.js');
  const { PrismaDiscoveryAuditStore } = dist('discovery/prisma-discovery-audit.store.js');
  const { HttpsSourceFetchAdapter, govinfoTextRenditionUrl } = dist('https-source-fetch.adapter.js');
  const { PrismaLifecycleStore } = dist('prisma-lifecycle.store.js');
  const { InMemoryLifecycleStore } = dist('testing/in-memory-lifecycle.store.js');

  let lifecycleStore;
  let discovery;

  if (commit) {
    const identity = resolveDatabaseIdentity();
    printTargetIdentity({
      mode,
      commit,
      identity,
      extra: {
        fiscalYears: fiscalYears.join(','),
        adapters: bounded.length,
        liveDiscovery: process.env.PHASE8_SESSION8_LIVE_DISCOVERY === 'true',
      },
    });
    prisma = openPrisma(identity);
    // Authorisation is decided by PostgreSQL AFTER connecting, never by a
    // configured env string. Throws (77) unless the authenticated role is a
    // genuinely INHERITing member of the capability role and holds no
    // dangerous role attributes.
    await assertLiveJobCapability({ mode, commit, sql: prisma });
    lifecycleStore = new PrismaLifecycleStore(prisma);

    if (process.env.PHASE8_SESSION8_LIVE_DISCOVERY === 'true') {
      const discoveryAudit = new PrismaDiscoveryAuditStore(prisma);
      const http = new HttpsPublisherHttpAdapter({
        minRequestIntervalMs: (id) => registry.get(id).minRequestIntervalMs,
        reserveHostSlot: (input) => discoveryAudit.reserveHostSlot(input),
      });
      discovery = new LiveSourceDiscoveryAdapter(
        registry,
        new GovInfoSitemapCrawler(http),
        new IndexPageCrawler(http),
        discoveryAudit,
        buildLiveDiscoveryOptions(fiscalYears),
      );
    } else {
      console.log(
        '[phase9-backfill] PHASE8_SESSION8_LIVE_DISCOVERY is not true; using the network-free ' +
          'manifest discovery adapter. Expected sources will be bootstrapped; no crawl will occur.',
      );
      discovery = new ManifestSourceDiscoveryAdapter(registry);
    }
  } else {
    // A dry run must be side-effect-free regardless of ambient environment.
    console.log('[phase9-backfill] DRY RUN: in-memory store + manifest discovery. No writes, no crawl.');
    lifecycleStore = new InMemoryLifecycleStore();
    discovery = new ManifestSourceDiscoveryAdapter(registry);
  }

  const controller = new AnnualDefenseBudgetCycleController(lifecycleStore);
  const watcher = new DefenseBudgetLifecycleWatcher(
    registry,
    controller,
    lifecycleStore,
    discovery,
    new HttpsSourceFetchAdapter({ textRenditionUrl: govinfoTextRenditionUrl }),
  );

  // 1) Bootstrap every requested FY through the EXISTING cycle-template
  //    machinery. No expected-source row is hand-inserted here.
  let cyclesEnsured = 0;
  let expectedEnsured = 0;
  for (const fiscalYear of fiscalYears) {
    const summary = await controller.ensureFiscalYear({ fiscalYear, bootstrapOrigin: 'template' });
    cyclesEnsured += summary.cyclesEnsured;
    expectedEnsured += summary.expectedSourcesEnsured;
    console.log(
      `[phase9-backfill] bootstrap FY${summary.fiscalYear} tracks=${summary.cyclesEnsured} ` +
        `expectedSources=${summary.expectedSourcesEnsured} template=${summary.templateVersion}`,
    );
  }

  // 2) Run the real watcher per adapter.
  let failed = 0;
  let partial = 0;
  const totals = { discovered: 0, unchanged: 0, changed: 0, review: 0, queued: 0, blocked: 0 };
  for (const adapterId of bounded) {
    try {
      const result = await watcher.runAdapter({
        adapterId,
        nowIso,
        leaseOwner: value('lease-owner', `phase9-job-${process.pid}`),
        runKey: `${value('run-key', nowIso)}:${adapterId}`,
        commit,
      });
      for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
      if (result.status === 'failed') failed += 1;
      if (result.status === 'partial') partial += 1;
      console.log(
        `  ${result.status.padEnd(20)} ${adapterId.padEnd(32)} committed=${result.committed} ` +
          `discovered=${result.discovered} unchanged=${result.unchanged} changed=${result.changed} ` +
          `review=${result.review} queued=${result.queued} blocked=${result.blocked}`,
      );
    } catch (error) {
      failed += 1;
      console.log(`  ${'threw'.padEnd(20)} ${adapterId.padEnd(32)} ${error?.message ?? error}`);
    }
  }

  console.log(
    `[phase9-backfill] fiscalYears=${fiscalYears.length} cyclesEnsured=${cyclesEnsured} ` +
      `expectedSourcesEnsured=${expectedEnsured} adaptersRun=${bounded.length} ` +
      `failed=${failed} partial=${partial}`,
  );
  console.log(`[phase9-backfill] totals=${JSON.stringify(totals)}`);
  console.log(
    `[phase9-backfill] gpu requiresGpu=${gpu.requiresGpu} activeGpuCapacity=${gpu.activeGpuCapacity}`,
  );

  // Exit non-zero on partial/fatal failure, and never claim COMMITTED for a dry run.
  if (failed > 0) {
    console.log('PHASE9_BACKFILL_FAILED');
    return 1;
  }
  if (partial > 0) {
    console.log('PHASE9_BACKFILL_PARTIAL');
    return 1;
  }
  console.log(commit ? 'PHASE9_BACKFILL_COMMITTED' : 'PHASE9_BACKFILL_DRY_RUN_PASS');
  return 0;
}

// ---------------------------------------------------------------------------
// lifecycle-watch — single adapter, delegates to the Session 7 command shape.
// ---------------------------------------------------------------------------
async function runLifecycleWatch() {
  const adapterId = value('adapter');
  if (!adapterId) throw new JobPreflightError('lifecycle-watch requires --adapter <id>', 64);
  if (!registry.has(adapterId)) {
    throw new JobPreflightError(`unknown adapter "${adapterId}"`, 64);
  }
  const sourceMode = value('source-discovery', 'manifest');
  if (!['manifest', 'catalog'].includes(sourceMode)) {
    throw new JobPreflightError(
      `--source-discovery must be "manifest" (default) or "catalog", got "${sourceMode}"`,
      64,
    );
  }
  const catalogFiscalYearsRaw = value('catalog-fiscal-years');
  if (sourceMode === 'catalog' && !catalogFiscalYearsRaw) {
    throw new JobPreflightError(
      '--source-discovery catalog requires --catalog-fiscal-years <comma-separated 4-digit years> ' +
        '(e.g. --catalog-fiscal-years 2024). This is a bounded, explicit, one-shot activation of ' +
        'CatalogSourceDiscoveryAdapter for THIS invocation only -- it never widens the module-level ' +
        'SOURCE_DISCOVERY_PORT default and never infers a fiscal-year set from the current date.',
      64,
    );
  }
  const catalogFiscalYears = catalogFiscalYearsRaw ? parseFiscalYears(catalogFiscalYearsRaw) : [];
  assertCommitAuthorised({ mode, commit });

  const { AnnualDefenseBudgetCycleController } = dist('annual-cycle-controller.service.js');
  const { DefenseBudgetLifecycleWatcher } = dist('lifecycle-watcher.service.js');
  const { ManifestSourceDiscoveryAdapter } = dist('manifest-source-discovery.adapter.js');
  const { HttpsSourceFetchAdapter, govinfoTextRenditionUrl } = dist('https-source-fetch.adapter.js');
  const { PrismaLifecycleStore } = dist('prisma-lifecycle.store.js');
  const { InMemoryLifecycleStore } = dist('testing/in-memory-lifecycle.store.js');

  let store;
  if (commit) {
    const identity = resolveDatabaseIdentity();
    printTargetIdentity({
      mode,
      commit,
      identity,
      extra: {
        adapter: adapterId,
        sourceDiscovery: sourceMode,
        ...(sourceMode === 'catalog' ? { catalogFiscalYears: catalogFiscalYears.join(',') } : {}),
      },
    });
    prisma = openPrisma(identity);
    await assertLiveJobCapability({ mode, commit, sql: prisma });
    store = new PrismaLifecycleStore(prisma);
  } else {
    console.log('[phase9-lifecycle-watch] DRY RUN: in-memory store, no writes.');
    store = new InMemoryLifecycleStore();
  }

  const controller = new AnnualDefenseBudgetCycleController(store);

  let discovery;
  if (sourceMode === 'catalog') {
    // Bounded, explicit, ONE-SHOT activation of CatalogSourceDiscoveryAdapter for
    // this single invocation only. This does NOT touch, import, or reference
    // budget-lifecycle.module.ts's SOURCE_DISCOVERY_PORT NestJS provider -- that
    // module-level default (Manifest, or Live when
    // PHASE8_SESSION8_LIVE_DISCOVERY=true) is completely untouched and remains
    // what every other composition root (the HTTP serve image, other job modes)
    // gets. This flag exists so the FIRST canary invocation can use the catalog
    // resolver without a global default switch. The adapter itself already
    // refuses every authorityTrack except 'request' and every fiscal year
    // outside --catalog-fiscal-years (see CatalogSourceDiscoveryAdapter /
    // resolveExpectedSourceDocument) -- this flag only decides which port THIS
    // one process instance is constructed with.
    if (!commit) {
      throw new JobPreflightError(
        'lifecycle-watch --source-discovery catalog is real-database read/resolve; run with ' +
          '--commit (plus the DB identity + PHASE8_SESSION7_COMMIT_AUTHORIZED=true it already ' +
          'requires) so the catalog is read from the real expected-source table, not an empty ' +
          'in-memory store that would trivially discover nothing',
        64,
      );
    }
    const { CatalogSourceDiscoveryAdapter } = dist('discovery/catalog-source-discovery.adapter.js');
    const { PrismaExpectedSourceCatalog } = dist('discovery/prisma-expected-source-catalog.js');
    const catalogPort = new PrismaExpectedSourceCatalog(prisma);
    discovery = new CatalogSourceDiscoveryAdapter(registry, catalogPort, {
      fiscalYears: catalogFiscalYears,
    });
    console.log(
      `[phase9-lifecycle-watch] source-discovery=catalog fiscalYears=${catalogFiscalYears.join(',')} ` +
        '(bounded one-shot; module-level SOURCE_DISCOVERY_PORT default untouched)',
    );
  } else {
    discovery = new ManifestSourceDiscoveryAdapter(registry);
    const manifestPath = value('manifest');
    if (manifestPath) {
      const fs = await import('node:fs/promises');
      discovery.load(JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8')));
    } else {
      console.log('[phase9-lifecycle-watch] no --manifest; discovery will return no candidates.');
    }
  }

  const watcher = new DefenseBudgetLifecycleWatcher(
    registry,
    controller,
    store,
    discovery,
    new HttpsSourceFetchAdapter({ textRenditionUrl: govinfoTextRenditionUrl }),
  );
  const result = await watcher.runAdapter({
    adapterId,
    nowIso,
    leaseOwner: value('lease-owner', `phase9-job-${process.pid}`),
    runKey: value('run-key', `${nowIso}:${adapterId}`),
    commit,
  });

  console.log(
    `[phase9-lifecycle-watch] ${adapterId} status=${result.status} committed=${result.committed} ` +
      `leaseAcquired=${result.leaseAcquired} discovered=${result.discovered} ` +
      `unchanged=${result.unchanged} changed=${result.changed} review=${result.review} ` +
      `queued=${result.queued} blocked=${result.blocked}`,
  );

  if (result.status === 'failed' || result.status === 'partial') {
    console.log('PHASE9_LIFECYCLE_WATCH_FAILED');
    return 1;
  }
  // Only claim COMMITTED when the watcher itself reports it persisted.
  console.log(
    result.committed ? 'PHASE9_LIFECYCLE_WATCH_COMMITTED' : 'PHASE9_LIFECYCLE_WATCH_DRY_RUN_PASS',
  );
  return 0;
}

// ---------------------------------------------------------------------------
// schedule-tick — one coordinator tick. Installs no schedule.
// ---------------------------------------------------------------------------
async function runScheduleTick() {
  assertCommitAuthorised({ mode, commit });

  const { AnnualDefenseBudgetCycleController } = dist('annual-cycle-controller.service.js');
  const { DefenseBudgetLifecycleWatcher } = dist('lifecycle-watcher.service.js');
  const { ManifestSourceDiscoveryAdapter } = dist('manifest-source-discovery.adapter.js');
  const { LiveSourceDiscoveryAdapter } = dist('discovery/live-source-discovery.adapter.js');
  const { GovInfoSitemapCrawler } = dist('discovery/govinfo-sitemap.crawler.js');
  const { IndexPageCrawler } = dist('discovery/index-page.crawler.js');
  const { HttpsPublisherHttpAdapter } = dist('discovery/https-publisher-http.adapter.js');
  const { PrismaDiscoveryAuditStore } = dist('discovery/prisma-discovery-audit.store.js');
  const { HttpsSourceFetchAdapter, govinfoTextRenditionUrl } = dist('https-source-fetch.adapter.js');
  const { PrismaLifecycleStore } = dist('prisma-lifecycle.store.js');
  const { InMemoryLifecycleStore } = dist('testing/in-memory-lifecycle.store.js');
  const { PrismaScheduleAuditStore } = dist('schedule/prisma-schedule-audit.store.js');
  const { InMemoryScheduleAuditStore } = dist('schedule/testing/schedule-test-doubles.js');
  const { ScheduleCoordinatorService } = dist('schedule/schedule-coordinator.service.js');

  let lifecycleStore;
  let scheduleAuditStore;
  let discovery;

  if (commit) {
    const identity = resolveDatabaseIdentity();
    printTargetIdentity({ mode, commit, identity });
    prisma = openPrisma(identity);
    await assertLiveJobCapability({ mode, commit, sql: prisma });
    lifecycleStore = new PrismaLifecycleStore(prisma);
    scheduleAuditStore = new PrismaScheduleAuditStore(prisma);
    if (process.env.PHASE8_SESSION8_LIVE_DISCOVERY === 'true') {
      const discoveryAudit = new PrismaDiscoveryAuditStore(prisma);
      const http = new HttpsPublisherHttpAdapter({
        minRequestIntervalMs: (id) => registry.get(id).minRequestIntervalMs,
        reserveHostSlot: (input) => discoveryAudit.reserveHostSlot(input),
      });
      discovery = new LiveSourceDiscoveryAdapter(
        registry,
        new GovInfoSitemapCrawler(http),
        new IndexPageCrawler(http),
        discoveryAudit,
      );
    } else {
      discovery = new ManifestSourceDiscoveryAdapter(registry);
    }
  } else {
    console.log('[phase9-schedule-tick] DRY RUN: in-memory stores + manifest discovery.');
    lifecycleStore = new InMemoryLifecycleStore();
    scheduleAuditStore = new InMemoryScheduleAuditStore();
    discovery = new ManifestSourceDiscoveryAdapter(registry);
  }

  const controller = new AnnualDefenseBudgetCycleController(lifecycleStore);
  const watcher = new DefenseBudgetLifecycleWatcher(
    registry,
    controller,
    lifecycleStore,
    discovery,
    new HttpsSourceFetchAdapter({ textRenditionUrl: govinfoTextRenditionUrl }),
  );
  const coordinator = new ScheduleCoordinatorService(
    registry,
    controller,
    watcher,
    scheduleAuditStore,
  );

  const workerId = value('worker-id', `phase9-job-${process.pid}`);
  const result = await coordinator.tick({
    nowIso,
    workerId,
    tickKey: value('tick-key', `${nowIso}:${workerId}`),
    commit,
  });

  console.log(
    `[phase9-schedule-tick] outcome=${result.summary.outcome} ` +
      `considered=${result.summary.adaptersConsidered} due=${result.summary.adaptersDue} ` +
      `succeeded=${result.summary.adaptersSucceeded} failed=${result.summary.adaptersFailed}`,
  );
  for (const attempt of result.attempts) {
    console.log(`  ${attempt.outcome.padEnd(20)} ${attempt.adapterId.padEnd(32)} ${attempt.detail}`);
  }

  if (result.summary.adaptersFailed > 0 || result.summary.outcome === 'failed') {
    console.log(`[phase9-schedule-tick] failureReason=${result.summary.failureReason ?? 'unknown'}`);
    console.log('PHASE9_SCHEDULE_TICK_FAILED');
    return 1;
  }
  console.log(commit ? 'PHASE9_SCHEDULE_TICK_COMMITTED' : 'PHASE9_SCHEDULE_TICK_DRY_RUN_PASS');
  return 0;
}

// ---------------------------------------------------------------------------
let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  if (error instanceof JobPreflightError) {
    console.error(`[phase9-job] ${error.message}`);
    exitCode = error.exitCode;
  } else {
    console.error(`[phase9-job] fatal: ${error?.stack ?? error}`);
    exitCode = 1;
  }
} finally {
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch {
      /* disconnect failure must not mask the real exit code */
    }
  }
}
process.exit(exitCode);
