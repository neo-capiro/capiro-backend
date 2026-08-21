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
 * Session 7 composition boundary — dark.
 *
 * Registers NO controller, NO route and NO schedule. The Session 3 public route
 * surface stays frozen at 49 routes, public browser/API routing is unchanged,
 * and no EventBridge watcher is enabled: production schedule ownership is
 * Session 10's work.
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
  ],
  exports: [
    SourceAdapterRegistry,
    AnnualDefenseBudgetCycleController,
    DefenseBudgetLifecycleWatcher,
    CycleHealthService,
  ],
})
export class BudgetLifecycleModule {}
