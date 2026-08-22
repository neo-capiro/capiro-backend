import { Module } from '@nestjs/common';
import { RepresentationModule } from '../clients/representation.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { DistrictNexusController } from './district-nexus.controller.js';
import { DistrictNexusRelationshipsController } from './district-nexus-relationships.controller.js';
import { DistrictNexusService } from './district-nexus.service.js';
import { DistrictNexusRelationshipsService } from './district-nexus-relationships.service.js';
import { DistrictNexusStrategicService } from './district-nexus-strategic.service.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import { DistrictNexusStrategicFlagGuard } from './district-nexus-strategic-flag.guard.js';

/**
 * District Nexus v2 (Rev 2 plan, Workstream E) + Release 2 Strategic Relevance.
 *
 * Ships dark: every route is behind DistrictNexusFlagGuard, which 404s unless
 * the tenant has an enabled `district_nexus_v2` row (or is the internal
 * canary). Strategic routes add DistrictNexusStrategicFlagGuard
 * (`district_nexus_strategic_relevance`) — fail-closed, internal-first.
 *
 * The guard is provided here rather than globally so it stays scoped to this
 * feature; PrismaService and ConfigService reach it from the global modules.
 */
/*
 * RepresentationModule, NOT DirectoryModule.
 *
 * WS-E3 embeds representation in the client payload so the widget drops from
 * two queries to one. The obvious-looking route — importing DirectoryModule,
 * which itself imports RepresentationModule — does not work: DirectoryModule
 * exports only DirectoryService, so RepresentationResolverService is not
 * visible through it. That failure is a Nest bootstrap error, not a type error,
 * so it compiles, passes the only gate CI has (turbo typecheck), and then kills
 * the container on first start. Importing the owning module directly is both
 * correct and what RepresentationModule's own docblock asks callers to do.
 *
 * IntelligenceModule is imported so Release 2 can reuse ClientPeRelevanceService
 * rather than inventing another PE matcher. IntelligenceModule does not import
 * DistrictNexusModule, so this is a one-way edge.
 */
@Module({
  imports: [RepresentationModule, IntelligenceModule],
  controllers: [DistrictNexusController, DistrictNexusRelationshipsController],
  providers: [
    DistrictNexusService,
    DistrictNexusRelationshipsService,
    DistrictNexusStrategicService,
    DistrictNexusFlagGuard,
    DistrictNexusStrategicFlagGuard,
  ],
  exports: [
    DistrictNexusService,
    DistrictNexusRelationshipsService,
    DistrictNexusStrategicService,
  ],
})
export class DistrictNexusModule {}
