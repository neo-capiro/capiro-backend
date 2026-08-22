import { Module } from '@nestjs/common';
import { QualityTelemetryCaptureService } from './quality-telemetry-capture.service.js';
import { QualityTelemetryQueryService } from './quality-telemetry-query.service.js';
import { InternalQualityTelemetryController } from './internal-quality-telemetry.controller.js';

/**
 * Phase 27E — Quality Telemetry. Imported by any module whose service
 * records QualityTelemetryEvents (Meri, Clients/CRM Fill, Outreach,
 * Engagement/Meetings) and by AppModule directly for the cross-service
 * bridge (`InternalQualityTelemetryController`) that Workspace and
 * Strategies call into. PrismaModule is `@Global()`, so no import is needed
 * here for either service's PrismaService dependency.
 *
 * Never imports MemoryModule or LearningModule: this module cannot write
 * active memory or capture LearningSignals — see
 * check-quality-telemetry-new-bypasses.mjs.
 */
@Module({
  controllers: [InternalQualityTelemetryController],
  providers: [QualityTelemetryCaptureService, QualityTelemetryQueryService],
  exports: [QualityTelemetryCaptureService, QualityTelemetryQueryService],
})
export class QualityTelemetryModule {}
