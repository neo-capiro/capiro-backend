#!/usr/bin/env node
/**
 * Phase 8 Session 8 — governed live-discovery command.
 *
 * Dark by default in two independent senses:
 *
 *  1. **No network unless authorised.** Live crawling issues real requests to
 *     real government publishers, so it requires
 *     `PHASE8_SESSION8_CRAWL_AUTHORIZED=true`. Without it the command reports
 *     what it *would* request and exits.
 *
 *  2. **No persistence unless authorised.** Even an authorised crawl only writes
 *     audit rows with `PHASE8_SESSION8_COMMIT_AUTHORIZED=true`, mirroring the
 *     Session 7 watcher command.
 *
 * The command takes no schedule (production schedule ownership is Session 10's
 * work), registers no route, promotes nothing, and requires no GPU.
 *
 * Usage:
 *   node scripts/run-live-discovery.mjs --list-adapters
 *   node scripts/run-live-discovery.mjs --adapter govinfo-committee-reports --plan
 *   PHASE8_SESSION8_CRAWL_AUTHORIZED=true \
 *     node scripts/run-live-discovery.mjs --adapter govinfo-committee-reports
 */

import process from 'node:process';

import {
  assertWatcherRunnableWithoutGpu,
  createRequestBudget,
  emptyDiscoveryCursor,
  effectiveRequestIntervalMs,
  resolveWatcherGpuEnvironment,
  rollingCycleHorizon,
  serialiseDiscoveryCursor,
} from '@capiro/defense-domain';

import { SourceAdapterRegistry } from '../dist/budget-lifecycle/source-adapter.registry.js';
import { GovInfoSitemapCrawler } from '../dist/budget-lifecycle/discovery/govinfo-sitemap.crawler.js';
import { IndexPageCrawler } from '../dist/budget-lifecycle/discovery/index-page.crawler.js';
import { HttpsPublisherHttpAdapter } from '../dist/budget-lifecycle/discovery/https-publisher-http.adapter.js';
import { LiveSourceDiscoveryAdapter } from '../dist/budget-lifecycle/discovery/live-source-discovery.adapter.js';
import { InMemoryDiscoveryAuditStore } from '../dist/budget-lifecycle/discovery/testing/discovery-test-doubles.js';
import {
  DEFAULT_DISCOVERY_REQUEST_BUDGET,
  entryPointsFor,
} from '../dist/budget-lifecycle/discovery/publisher-crawler.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
};

const registry = new SourceAdapterRegistry();

if (flag('--list-adapters')) {
  const nowIso = new Date().toISOString();
  const horizon = rollingCycleHorizon(nowIso);
  for (const adapter of registry.list()) {
    const entryPoints = entryPointsFor(adapter.adapterId, horizon);
    console.log(
      [
        adapter.adapterId.padEnd(32),
        adapter.discoveryMode.padEnd(16),
        `${adapter.minRequestIntervalMs}ms`.padEnd(8),
        `gpu=${adapter.requiresGpu}`.padEnd(10),
        `hosts=${adapter.officialHosts.join(',')}`,
        entryPoints.length === 0 ? '(sitemap channel)' : `entryPoints=${entryPoints.length}`,
      ].join(' '),
    );
  }
  process.exit(0);
}

const adapterId = value('--adapter');
if (!adapterId) {
  console.error('usage: --adapter <adapterId> | --list-adapters');
  process.exit(2);
}

// Fail-closed GPU independence, before anything else, exactly as the Session 7
// watcher does. Discovery is CPU and network work.
const providerEnv = resolveWatcherGpuEnvironment(process.env);
const gpu = assertWatcherRunnableWithoutGpu({
  providerRouting: providerEnv.providerRouting,
  activeGpuCapacity: providerEnv.activeGpuCapacity,
  requiresGpu: registry.get(adapterId).requiresGpu,
});

const nowIso = new Date().toISOString();
const horizon = rollingCycleHorizon(nowIso);
const adapter = registry.get(adapterId);
const budgetLimit = Number(value('--budget') ?? DEFAULT_DISCOVERY_REQUEST_BUDGET);

console.log(`[phase8-session8] adapter=${adapterId} mode=${adapter.discoveryMode}`);
console.log(`[phase8-session8] horizon=FY${horizon.join('/FY')}`);
console.log(`[phase8-session8] gpu requiresGpu=${gpu.requiresGpu} capacity=${gpu.activeGpuCapacity}`);
console.log(
  `[phase8-session8] pacing host-keyed, registry=${adapter.minRequestIntervalMs}ms; ` +
    'the publisher crawl-delay wins when stricter',
);

const plannedEntryPoints = entryPointsFor(adapterId, horizon);
if (plannedEntryPoints.length > 0) {
  for (const entryPoint of plannedEntryPoints) {
    console.log(`[phase8-session8] would request ${entryPoint}`);
  }
} else {
  console.log('[phase8-session8] would request the GovInfo sitemap channel for this adapter');
}

if (flag('--plan')) {
  console.log('SESSION8_PLAN_ONLY');
  process.exit(0);
}

if (process.env.PHASE8_SESSION8_CRAWL_AUTHORIZED !== 'true') {
  // A dark session does not reach out to a government publisher by accident.
  console.log(
    '[phase8-session8] PHASE8_SESSION8_CRAWL_AUTHORIZED is not true; no request was issued.',
  );
  console.log('SESSION8_DRY_RUN_PASS');
  process.exit(0);
}

// Phase 9 correctness fix.
//
// This command composes `InMemoryDiscoveryAuditStore` — a test double — so it
// structurally CANNOT persist a discovery audit row. Previously it accepted
// `PHASE8_SESSION8_COMMIT_AUTHORIZED=true` and then printed
// `SESSION8_LIVE_DISCOVERY_COMMITTED` anyway, reporting success for persistence
// it never performed.
//
// Rather than quietly widen a reporting-only tool into a production writer, the
// commit mode is REFUSED here and production persistence is routed exclusively
// through the governed controller (`backfill-run` / `schedule-tick`), which
// composes the real `PrismaDiscoveryAuditStore`. This keeps exactly one
// persistence path under exactly one authorisation gate.
if (process.env.PHASE8_SESSION8_COMMIT_AUTHORIZED === 'true') {
  console.error(
    '[phase8-session8] REFUSED: run-live-discovery is a reporting-only command and cannot ' +
      'persist discovery audit rows (it composes an in-memory audit store). ' +
      'Use the governed job runtime for production persistence: ' +
      '`backfill-run --fiscal-years <FYs> --commit` or `schedule-tick --commit`, ' +
      'which compose PrismaDiscoveryAuditStore.',
  );
  console.error('SESSION8_LIVE_DISCOVERY_COMMIT_REFUSED');
  process.exit(65);
}

console.log(
  '[phase8-session8] reporting-only command: crawling and reporting, persisting nothing. ' +
    'No audit/lifecycle row is written by this command under any environment.',
);

// Without a registered expected source nothing can resolve, so a standalone run
// is told which keys to consider. A real run loads them from the control plane.
const registeredKeys = new Set(
  (value('--expected-source-keys') ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length === 64),
);

const audit = new InMemoryDiscoveryAuditStore(registeredKeys);
const http = new HttpsPublisherHttpAdapter({
  minRequestIntervalMs: (id) => registry.get(id).minRequestIntervalMs,
  reserveHostSlot: (input) => audit.reserveHostSlot(input),
});

const discovery = new LiveSourceDiscoveryAdapter(
  registry,
  new GovInfoSitemapCrawler(http),
  new IndexPageCrawler(http),
  audit,
  { requestBudget: createRequestBudget(budgetLimit).limit },
);

const result = await discovery.discover({
  adapterId,
  cursor: serialiseDiscoveryCursor(emptyDiscoveryCursor()),
  nowIso,
});

console.log(`[phase8-session8] crawls recorded: ${audit.crawls.length}`);
for (const crawl of audit.crawls) {
  console.log(
    `  ${crawl.status.padEnd(22)} ${String(crawl.statusCode ?? '---').padEnd(4)} ` +
      `${crawl.resourceKind.padEnd(14)} ${crawl.requestUrl}`,
  );
}
console.log(`[phase8-session8] candidates examined: ${audit.candidates.length}`);
const byResolution = new Map();
for (const candidate of audit.candidates) {
  byResolution.set(candidate.resolution, (byResolution.get(candidate.resolution) ?? 0) + 1);
}
for (const [resolution, count] of [...byResolution.entries()].sort()) {
  console.log(`  ${resolution.padEnd(42)} ${count}`);
}
console.log(`[phase8-session8] candidates emitted: ${result.candidates.length}`);
for (const candidate of result.candidates) {
  console.log(`  ${candidate.expectedSourceDedupKey.slice(0, 12)} ${candidate.url}`);
}
console.log(
  `[phase8-session8] effective interval sample: ` +
    `${effectiveRequestIntervalMs({
      registryMinRequestIntervalMs: adapter.minRequestIntervalMs,
      robotsCrawlDelaySeconds: null,
    })}ms`,
);

// Never `..._COMMITTED`: this command persists nothing, by construction.
console.log('SESSION8_LIVE_DISCOVERY_REPORTED');
