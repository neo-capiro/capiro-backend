import { Module } from '@nestjs/common';
import { EvaluationCaptureService } from './evaluation-capture.service.js';
import { EvaluationQueryService } from './evaluation-query.service.js';

/**
 * Phase 27F — institutional-context effectiveness evaluation. Imported by
 * any module whose service triggers a shadow evaluation (Outreach,
 * Clients/CRM Fill, Meri). PrismaModule is `@Global()`, so no import is
 * needed here for `EvaluationCaptureService`'s PrismaService dependency.
 *
 * Never imports MemoryModule, LearningModule, or QualityTelemetryModule's
 * write surface: this module can only READ a QualityTelemetryEvent id for
 * linkage (a plain string passed in by the caller) and can never write
 * active memory, capture a LearningSignal, or create a MemoryCandidate —
 * see check-evaluation-new-bypasses.mjs.
 */
@Module({
  providers: [EvaluationCaptureService, EvaluationQueryService],
  exports: [EvaluationCaptureService, EvaluationQueryService],
})
export class EvaluationModule {}
