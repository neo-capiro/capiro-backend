import { Module } from '@nestjs/common';
import { LearningSignalCaptureService } from './learning-signal-capture.service.js';
import { LearningSignalQueryService } from './learning-signal-query.service.js';
import { LearningSignalCandidateService } from './learning-signal-candidate.service.js';
import { LearningSignalMemoryConflictService } from './learning-signal-memory-conflict.service.js';
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
 *
 * Phase 27C adds LearningSignalMemoryConflictService — read-only active-
 * memory search, no MemoryModule dependency of its own (it queries
 * memory_items/context_embeddings directly via PrismaService).
 */
@Module({
  imports: [MemoryModule],
  providers: [
    LearningSignalCaptureService,
    LearningSignalQueryService,
    LearningSignalCandidateService,
    LearningSignalMemoryConflictService,
  ],
  exports: [
    LearningSignalCaptureService,
    LearningSignalQueryService,
    LearningSignalCandidateService,
    LearningSignalMemoryConflictService,
  ],
})
export class LearningModule {}
