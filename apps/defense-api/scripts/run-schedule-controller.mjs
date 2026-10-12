#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Governed Phase 8 Session 10 schedule-control-plane command.
 *
 * Three independent safety layers, same philosophy as the Session 7 and 8
 * commands:
 *
 *  1. `--plan` reads real due-state (read-only) and reports it. No
 *     `runAdapter` call, no network, no write, no authorisation needed.
 *  2. `--tick` without `--commit` is a full dry run: it reads real due-state
 *     but runs every due adapter against the harmless in-memory store AND the
 *     manifest discovery adapter, exactly like Session 7's own command,
 *     regardless of `PHASE8_SESSION8_LIVE_DISCOVERY` — a dry run must never
 *     depend on what happens to be set in the environment to stay network-free.
 *  3. `--tick --commit` is the only path that touches a real database, and it
 *     additionally requires `PHASE8_SESSION10_TICK_AUTHORIZED=true`. Only then
 *     does discovery mode follow `PHASE8_SESSION8_LIVE_DISCOVERY`, exactly as
 *     the NestJS module would resolve it if this were deployed.
 *
 * This command does not install a schedule. It performs one tick when
 * invoked; deciding how often to invoke it (an EventBridge rule, a cron
 * entry) is deployment work, deliberately outside this session.
 *
 * Usage:
 *   node scripts/run-schedule-controller.mjs --list-adapters
 *   node scripts/run-schedule-controller.mjs --plan
 *   node scripts/run-schedule-controller.mjs --tick
 *   PHASE8_SESSION10_TICK_AUTHORIZED=true \
 *     node scripts/run-schedule-controller.mjs --tick --commit
 */
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const usage = 'Usage: node scripts/run-schedule-controller.mjs --list-adapters | --plan | --tick [--commit] [--now ISO] [--worker-id ID] [--tick-key KEY]';
if (argv.length === 1 && argv[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (argv.length === 0) {
  console.error(usage);
  process.exit(2);
}
const valueOptions = new Set(['--now', '--worker-id', '--tick-key']);
const flagOptions = new Set(['--list-adapters', '--plan', '--tick', '--commit']);
for (let index = 0; index < argv.length; index += 1) {
  const option = argv[index];
  if (flagOptions.has(option)) continue;
  if (valueOptions.has(option)) {
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) index += 1;
    continue;
  }
  console.error(`Unsupported argument: ${option}`);
  console.error(usage);
  process.exit(2);
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');
const dist = (relative) => require(path.join(appRoot, 'dist/budget-lifecycle', relative));
const domain = require(path.join(repoRoot, 'packages/defense-domain/dist/index.js'));

const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')
    ? argv[index + 1]
    : fallback;
};

const commit = flag('commit');
if (commit && process.env.PHASE8_SESSION10_TICK_AUTHORIZED !== 'true') {
  throw new Error(
    'Refusing Session 10 database mutation without PHASE8_SESSION10_TICK_AUTHORIZED=true',
  );
}

const { AnnualDefenseBudgetCycleController } = dist('annual-cycle-controller.service.js');
const { DefenseBudgetLifecycleWatcher } = dist('lifecycle-watcher.service.js');
const { SourceAdapterRegistry } = dist('source-adapter.registry.js');
const { ManifestSourceDiscoveryAdapter } = dist('manifest-source-discovery.adapter.js');
const { LiveSourceDiscoveryAdapter } = dist('discovery/live-source-discovery.adapter.js');
const { GovInfoSitemapCrawler } = dist('discovery/govinfo-sitemap.crawler.js');
const { IndexPageCrawler } = dist('discovery/index-page.crawler.js');
const { HttpsPublisherHttpAdapter } = dist('discovery/https-publisher-http.adapter.js');
const { PrismaDiscoveryAuditStore } = dist('discovery/prisma-discovery-audit.store.js');
const { InMemoryDiscoveryAuditStore } = dist('discovery/testing/discovery-test-doubles.js');
const { HttpsSourceFetchAdapter, govinfoTextRenditionUrl } = dist('https-source-fetch.adapter.js');
const { PrismaLifecycleStore } = dist('prisma-lifecycle.store.js');
const { InMemoryLifecycleStore } = dist('testing/in-memory-lifecycle.store.js');
const { PrismaScheduleAuditStore } = dist('schedule/prisma-schedule-audit.store.js');
const { InMemoryScheduleAuditStore } = dist('schedule/testing/schedule-test-doubles.js');
const { ScheduleCoordinatorService } = dist('schedule/schedule-coordinator.service.js');

// Fail-closed before anything else: this command must never need GPU capacity.
const providerEnv = domain.resolveWatcherGpuEnvironment(process.env);
const gpu = domain.assertWatcherRunnableWithoutGpu({
  providerRouting: providerEnv.providerRouting,
  activeGpuCapacity: providerEnv.activeGpuCapacity,
  requiresGpu: false,
});

const registry = new SourceAdapterRegistry();

if (flag('list-adapters')) {
  for (const adapter of registry.list()) {
    console.log(
      `${adapter.adapterId.padEnd(32)} ${adapter.publisher} ` +
        `cadence(in/shoulder/off)=${adapter.cadence.inSeasonMinutes}/` +
        `${adapter.cadence.shoulderMinutes}/${adapter.cadence.offSeasonMinutes}min`,
    );
  }
  process.exit(0);
}

/** True only on the one path that is allowed to depend on it: an authorised commit. */
function liveDiscoveryEnabled(env) {
  return env.PHASE8_SESSION8_LIVE_DISCOVERY === 'true';
}

let prisma = null;
let lifecycleStore;
let scheduleAuditStore;
let discovery;

if (commit) {
  const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
  prisma = new PrismaClient();
  lifecycleStore = new PrismaLifecycleStore(prisma);
  scheduleAuditStore = new PrismaScheduleAuditStore(prisma);

  if (liveDiscoveryEnabled(process.env)) {
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
} else if (flag('plan')) {
  // Read-only: a real connection to see real due-state, nothing else.
  const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
  prisma = new PrismaClient();
  scheduleAuditStore = new PrismaScheduleAuditStore(prisma);
} else {
  // Dry-run `--tick`: harmless in-memory store and the network-free manifest
  // adapter, regardless of PHASE8_SESSION8_LIVE_DISCOVERY. A dry run must
  // never depend on ambient environment to stay side-effect-free.
  lifecycleStore = new InMemoryLifecycleStore();
  scheduleAuditStore = new InMemoryScheduleAuditStore();
  discovery = new ManifestSourceDiscoveryAdapter(registry);
}

const nowIso = value('now', new Date().toISOString());
const workerId = value('worker-id', `schedule-cli-${process.pid}`);
const tickKey = value('tick-key', `${nowIso}:${workerId}`);

try {
  if (flag('plan')) {
    const adapterIds = registry.list().map((adapter) => adapter.adapterId);
    const snapshots = await scheduleAuditStore.loadAdapterScheduleStates(adapterIds);
    for (const adapterId of adapterIds) {
      const decision = domain.evaluateAdapterDue({
        adapterId,
        state: snapshots.get(adapterId) ?? null,
        nowIso,
      });
      console.log(
        `[phase8-session10] ${decision.due ? 'DUE    ' : 'not due'} ${adapterId.padEnd(32)} ${decision.reason}`,
      );
    }
    console.log('SESSION10_PLAN_ONLY');
    process.exit(0);
  }

  if (flag('tick')) {
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

    const result = await coordinator.tick({
      nowIso,
      workerId,
      tickKey,
      commit,
    });

    console.log(
      `[phase8-session10] ${commit ? 'TICK' : 'DRY_RUN'} worker=${workerId} tickKey=${tickKey} ` +
        `outcome=${result.summary.outcome} horizonBootstrapped=${result.summary.horizonBootstrapped} ` +
        `considered=${result.summary.adaptersConsidered} due=${result.summary.adaptersDue} ` +
        `succeeded=${result.summary.adaptersSucceeded} failed=${result.summary.adaptersFailed} ` +
        `skippedLease=${result.summary.adaptersSkippedLease}`,
    );
    for (const attempt of result.attempts) {
      console.log(`  ${attempt.outcome.padEnd(20)} ${attempt.adapterId.padEnd(32)} ${attempt.detail}`);
    }
    if (result.summary.failureReason) {
      console.log(`[phase8-session10] tick failure reason: ${result.summary.failureReason}`);
    }

    console.log(
      `[phase8-session10] gpu requiresGpu=${gpu.requiresGpu} activeGpuCapacity=${gpu.activeGpuCapacity} ` +
        `providerRouting=${gpu.providerRouting}`,
    );
    console.log(commit ? 'SESSION10_TICK_COMMITTED' : 'SESSION10_DRY_RUN_PASS');
    process.exit(0);
  }

  console.error('usage: --list-adapters | --plan | --tick [--commit]');
  process.exit(2);
} finally {
  if (prisma) await prisma.$disconnect();
}
