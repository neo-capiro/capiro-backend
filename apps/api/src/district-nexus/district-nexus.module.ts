import { Module } from '@nestjs/common';
import { DistrictNexusController } from './district-nexus.controller.js';
import { DistrictNexusService } from './district-nexus.service.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';

/**
 * District Nexus v2 (Rev 2 plan, Workstream E).
 *
 * Ships dark: every route is behind DistrictNexusFlagGuard, which 404s unless
 * the tenant has an enabled `district_nexus_v2` row (or is the internal
 * canary). Registering the module unconditionally is the house pattern —
 * routes exist, the flag decides whether they answer.
 *
 * The guard is provided here rather than globally so it stays scoped to this
 * feature; PrismaService and ConfigService reach it from the global modules.
 */
@Module({
  controllers: [DistrictNexusController],
  providers: [DistrictNexusService, DistrictNexusFlagGuard],
  exports: [DistrictNexusService],
})
export class DistrictNexusModule {}
