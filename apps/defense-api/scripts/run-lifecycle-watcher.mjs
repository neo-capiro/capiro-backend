#!/usr/bin/env node
/**
 * Governed Defense Budget Lifecycle Watcher run command.
 *
 * Dry-run first, exactly like the Session 6 ingestion command: a real database
 * mutation requires BOTH `--commit` and an explicit authorisation environment
 * variable, so a mistyped invocation cannot write.
 *
 * This command deliberately does NOT install an EventBridge schedule, take
 * production schedule ownership, promote or activate a snapshot, or start any
 * GPU. It is a one-off operator/job entrypoint for the dark Session 7 control
 * plane; schedule ownership is Session 10's work.
 *
 * Usage:
 *   node scripts/run-lifecycle-watcher.mjs --bootstrap --fiscal-year 2028
 *   node scripts/run-lifecycle-watcher.mjs --adapter govinfo-committee-reports
 *   PHASE8_SESSION7_COMMIT_AUTHORIZED=true \
 *     node scripts/run-lifecycle-watcher.mjs --adapter govinfo-bills --commit
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');
const dist = (relative) => require(path.join(appRoot, 'dist/budget-lifecycle', relative));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')
    ? argv[index + 1]
    : fallback;
};

const commit = flag('commit');
if (commit && process.env.PHASE8_SESSION7_COMMIT_AUTHORIZED !== 'true') {
  throw new Error(
    'Refusing Session 7 database mutation without PHASE8_SESSION7_COMMIT_AUTHORIZED=true',
  );
}

const { AnnualDefenseBudgetCycleController } = dist('annual-cycle-controller.service.js');
const { DefenseBudgetLifecycleWatcher } = dist('lifecycle-watcher.service.js');
const { SourceAdapterRegistry } = dist('source-adapter.registry.js');
const { ManifestSourceDiscoveryAdapter } = dist('manifest-source-discovery.adapter.js');
const { HttpsSourceFetchAdapter, govinfoTextRenditionUrl } = dist('https-source-fetch.adapter.js');
const { PrismaLifecycleStore } = dist('prisma-lifecycle.store.js');
const { InMemoryLifecycleStore } = dist('testing/in-memory-lifecycle.store.js');
const { assertWatcherRunnableWithoutGpu, resolveWatcherGpuEnvironment } = require(
  path.join(repoRoot, 'packages/defense-domain/dist/index.js'),
);

// Fail-closed before anything else: this command must never need GPU capacity.
const providerEnv = resolveWatcherGpuEnvironment(process.env);
const gpu = assertWatcherRunnableWithoutGpu({
  providerRouting: providerEnv.providerRouting,
  activeGpuCapacity: providerEnv.activeGpuCapacity,
  requiresGpu: false,
});

const registry = new SourceAdapterRegistry();

if (flag('list-adapters')) {
  for (const adapter of registry.list()) {
    console.log(
      `${adapter.adapterId.padEnd(32)} ${adapter.publisher} ` +
        `[${adapter.discoveryMode}] hosts=${adapter.officialHosts.join(',')}`,
    );
  }
  process.exit(0);
}

let prisma = null;
let store;
if (commit) {
  const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
  prisma = new PrismaClient();
  store = new PrismaLifecycleStore(prisma);
} else {
  // Dry run touches no database at all, so an operator can inspect decisions
  // without credentials.
  store = new InMemoryLifecycleStore();
}

const nowIso = value('now', new Date().toISOString());
const controller = new AnnualDefenseBudgetCycleController(store);

try {
  if (flag('bootstrap')) {
    const fiscalYearArg = value('fiscal-year');
    if (fiscalYearArg) {
      const summary = await controller.ensureFiscalYear({ fiscalYear: Number(fiscalYearArg) });
      console.log(
        `[phase8-session7] bootstrap FY${summary.fiscalYear} tracks=${summary.cyclesEnsured} ` +
          `expectedSources=${summary.expectedSourcesEnsured} template=${summary.templateVersion}`,
      );
    } else {
      const summaries = await controller.ensureRollingHorizon({ nowIso });
      for (const summary of summaries) {
        console.log(
          `[phase8-session7] bootstrap FY${summary.fiscalYear} tracks=${summary.cyclesEnsured} ` +
            `expectedSources=${summary.expectedSourcesEnsured}`,
        );
      }
    }
  }

  const adapterId = value('adapter');
  if (adapterId) {
    if (!registry.has(adapterId)) {
      throw new Error(
        `Unknown adapter "${adapterId}". Run with --list-adapters to see the registry.`,
      );
    }

    const discovery = new ManifestSourceDiscoveryAdapter(registry);
    const manifestPath = value('manifest');
    if (manifestPath) {
      discovery.load(JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8')));
    } else {
      console.log(
        '[phase8-session7] no --manifest supplied; discovery will return no candidates. ' +
          'Live per-publisher crawling is dark-deployment work (Session 8), not control-plane logic.',
      );
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
      leaseOwner: value('lease-owner', `cli-${process.pid}`),
      runKey: value('run-key', randomUUID()),
      commit,
    });

    console.log(
      `[phase8-session7] ${commit ? 'RUN' : 'DRY_RUN'} adapter=${result.adapterId} ` +
        `status=${result.status} discovered=${result.discovered} unchanged=${result.unchanged} ` +
        `changed=${result.changed} review=${result.review} queued=${result.queued} ` +
        `blocked=${result.blocked} nextCheckAt=${result.nextCheckAt}`,
    );
    for (const outcome of result.outcomes) {
      console.log(
        `  ${outcome.outcome.padEnd(20)} ${outcome.classifiedAuthorityTrack ?? '-'}/` +
          `${outcome.classifiedStage ?? '-'} sha=${(outcome.contentSha256 ?? '-').slice(0, 12)} ` +
          `queued=${outcome.queued} ${outcome.url}`,
      );
      for (const reason of outcome.reasons) console.log(`      · ${reason}`);
    }
  }

  console.log(
    `[phase8-session7] gpu requiresGpu=${gpu.requiresGpu} activeGpuCapacity=${gpu.activeGpuCapacity} ` +
      `providerRouting=${gpu.providerRouting} queuedProviderPages=${gpu.queuedProviderPages}`,
  );
  if (!commit) {
    console.log(
      '[phase8-session7] DRY_RUN_PASS — no database mutation attempted; rerun with --commit ' +
        'plus PHASE8_SESSION7_COMMIT_AUTHORIZED=true',
    );
  }
} finally {
  if (prisma) await prisma.$disconnect();
}
