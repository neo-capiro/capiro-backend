import { Module } from '@nestjs/common';
import { LearningSignalCaptureService } from './learning-signal-capture.service.js';
import { LearningSignalQueryService } from './learning-signal-query.service.js';

/**
 * Phase 27A — Institutional Learning & Quality, signal-capture foundation.
 * Imported by any module whose service captures LearningSignals (MeriModule,
 * ClientsModule today). PrismaModule is `@Global()`, so no import is needed
 * here for LearningSignalQueryService's PrismaService dependency.
 */
@Module({
  providers: [LearningSignalCaptureService, LearningSignalQueryService],
  exports: [LearningSignalCaptureService, LearningSignalQueryService],
})
export class LearningModule {}
