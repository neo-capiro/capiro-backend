import { Module } from '@nestjs/common';

import { AnnualDefenseBudgetCycleController } from './annual-cycle-controller.service.js';
import { CycleHealthService } from './cycle-health.service.js';
import { DefenseBudgetLifecycleWatcher } from './lifecycle-watcher.service.js';
import {
  HttpsSourceFetchAdapter,
  govinfoTextRenditionUrl,
} from './https-source-fetch.adapter.js';
import { LIFECYCLE_STORE, SOURCE_DISCOVERY_PORT, SOURCE_FETCH_PORT } from './lifecycle.tokens.js';
import { ManifestSourceDiscoveryAdapter } from './manifest-source-discovery.adapter.js';
import { PrismaLifecycleStore } from './prisma-lifecycle.store.js';
import { SourceAdapterRegistry } from './source-adapter.registry.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DISCOVERY_AUDIT_STORE } from './discovery/discovery-audit.port.js';
import { GovInfoSitemapCrawler } from './discovery/govinfo-sitemap.crawler.js';
import { HttpsPublisherHttpAdapter } from './discovery/https-publisher-http.adapter.js';
import { IndexPageCrawler } from './discovery/index-page.crawler.js';
import { LiveSourceDiscoveryAdapter } from './discovery/live-source-discovery.adapter.js';
import { PrismaDiscoveryAuditStore } from './discovery/prisma-discovery-audit.store.js';
import { PUBLISHER_HTTP_PORT } from './discovery/publisher-http.port.js';
import type { DiscoveryAuditStore } from './discovery/discovery-audit.port.js';
import type { PublisherHttpPort } from './discovery/publisher-http.port.js';
import { SCHEDULE_AUDIT_STORE } from './schedule/schedule-audit.port.js';
import { PrismaScheduleAuditStore } from './schedule/prisma-schedule-audit.store.js';
import { ScheduleCoordinatorService } from './schedule/schedule-coordinator.service.js';

/**
 * Session 8 live discovery is OPT-IN.
 *
 * The manifest adapter stays the default because it reaches no network at all,
 * which is the right posture for a dark session and is what the Session 7
 * historical replay runs against. Live crawling issues real requests to real
 * publishers, so it is enabled only by explicit configuration — the same
 * philosophy as Session 7's commit authorisation gate.
 */
function liveDiscoveryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PHASE8_SESSION8_LIVE_DISCOVERY === 'true';
}

/**
 * Session 7/10 composition boundary — dark.
 *
 * Registers NO controller and NO route. The Session 3 public route surface
 * stays frozen at 49 routes and public browser/API routing is unchanged.
 *
 * Session 10 adds `ScheduleCoordinatorService`, which CAN decide which
 * registered adapters are due and run them — but nothing here installs a
 * `@Cron`, a `ScheduleModule`, or an EventBridge rule that calls it. The
 * service exists as a provider an explicit caller must construct or invoke;
 * by itself, registering it here schedules nothing. See
 * `scripts/run-schedule-controller.mjs` for the one governed way to invoke a
 * tick today, and its own doc comment for why that, too, is dark by default.
 *
 * There is also no promotion or snapshot-activation provider here, and nothing
 * in this module holds parser, GPU or promoter credentials.
 */
@Module({
  providers: [
    SourceAdapterRegistry,
    AnnualDefenseBudgetCycleController,
    DefenseBudgetLifecycleWatcher,
    CycleHealthService,
    ScheduleCoordinatorService,
    { provide: LIFECYCLE_STORE, useClass: PrismaLifecycleStore },
    {
      // Constructed from PrismaService's raw-SQL surface: the Session 8 tables are
      // deliberately outside the curated defense-api Prisma model subset.
      provide: DISCOVERY_AUDIT_STORE,
      useFactory: (prisma: PrismaService) => new PrismaDiscoveryAuditStore(prisma),
      inject: [PrismaService],
    },
    {
      provide: PUBLISHER_HTTP_PORT,
      useFactory: (registry: SourceAdapterRegistry, audit: DiscoveryAuditStore) =>
        new HttpsPublisherHttpAdapter({
          minRequestIntervalMs: (adapterId) => registry.get(adapterId).minRequestIntervalMs,
          // Per-HOST reservation, because adapters share hosts.
          reserveHostSlot: (input) => audit.reserveHostSlot(input),
        }),
      inject: [SourceAdapterRegistry, DISCOVERY_AUDIT_STORE],
    },
    {
      provide: GovInfoSitemapCrawler,
      useFactory: (http: PublisherHttpPort) => new GovInfoSitemapCrawler(http),
      inject: [PUBLISHER_HTTP_PORT],
    },
    {
      provide: IndexPageCrawler,
      useFactory: (http: PublisherHttpPort) => new IndexPageCrawler(http),
      inject: [PUBLISHER_HTTP_PORT],
    },
    {
      provide: SOURCE_DISCOVERY_PORT,
      useFactory: (
        registry: SourceAdapterRegistry,
        govinfo: GovInfoSitemapCrawler,
        indexPages: IndexPageCrawler,
        audit: DiscoveryAuditStore,
      ) =>
        liveDiscoveryEnabled(process.env)
          ? new LiveSourceDiscoveryAdapter(registry, govinfo, indexPages, audit)
          : new ManifestSourceDiscoveryAdapter(registry),
      inject: [
        SourceAdapterRegistry,
        GovInfoSitemapCrawler,
        IndexPageCrawler,
        DISCOVERY_AUDIT_STORE,
      ],
    },
    {
      provide: SOURCE_FETCH_PORT,
      useFactory: () =>
        new HttpsSourceFetchAdapter({ textRenditionUrl: govinfoTextRenditionUrl }),
    },
    {
      // Deliberately its own port rather than a widened LIFECYCLE_STORE: the
      // frozen Session 7 LifecycleStore interface and both its implementations
      // stay byte-for-byte untouched. Constructed from PrismaService's raw-SQL
      // surface, same precedent as DISCOVERY_AUDIT_STORE above.
      provide: SCHEDULE_AUDIT_STORE,
      useFactory: (prisma: PrismaService) => new PrismaScheduleAuditStore(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [
    SourceAdapterRegistry,
    AnnualDefenseBudgetCycleController,
    DefenseBudgetLifecycleWatcher,
    CycleHealthService,
    ScheduleCoordinatorService,
  ],
})
export class BudgetLifecycleModule {}
