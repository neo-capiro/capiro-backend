import { Module } from '@nestjs/common';
import { LearningSignalCaptureService } from './learning-signal-capture.service.js';
import { LearningSignalQueryService } from './learning-signal-query.service.js';
import { LearningSignalCandidateService } from './learning-signal-candidate.service.js';
import { MemoryModule } from '../memory/memory.module.js';

/**
 * Phase 27A — Institutional Learning & Quality, signal-capture foundation.
 * Imported by any module whose service captures LearningSignals (MeriModule,
 * ClientsModule today). PrismaModule is `@Global()`, so no import is needed
 * here for LearningSignalQueryService's PrismaService dependency.
 *
 * Phase 27B adds LearningSignalCandidateService, the one path from a
 * captured signal to a governed memory_candidate — hence the MemoryModule
 * import, for MemoryCandidateService.
 */
@Module({
  imports: [MemoryModule],
  providers: [
    LearningSignalCaptureService,
    LearningSignalQueryService,
    LearningSignalCandidateService,
  ],
  exports: [
    LearningSignalCaptureService,
    LearningSignalQueryService,
    LearningSignalCandidateService,
  ],
})
export class LearningModule {}
