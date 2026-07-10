import { Module } from '@nestjs/common';
import { SourceDataRepository } from './source-data.repository.js';
import { StateSourceDataRepository } from './state-source-data.repository.js';

/**
 * Provides the read-only cross-DB SourceDataRepository (congress rail) and
 * StateSourceDataRepository (state rail, State Legislation Platform Phase 0
 * S4.2). PrismaModule is @Global, so PrismaService injects without an
 * explicit import here.
 *
 * NOT imported by AppModule in Phase 1 (serve stays untouched — no new routes,
 * no new serve-side DB connections). Later phases (match engine, detection)
 * import this module where they consume the repositories.
 */
@Module({
  providers: [SourceDataRepository, StateSourceDataRepository],
  exports: [SourceDataRepository, StateSourceDataRepository],
})
export class SourceDataModule {}
