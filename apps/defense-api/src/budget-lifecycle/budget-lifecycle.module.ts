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
      provide: SOURCE_DISCOVERY_PORT,
      useFactory: (registry: SourceAdapterRegistry) =>
        new ManifestSourceDiscoveryAdapter(registry),
      inject: [SourceAdapterRegistry],
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
