import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryFkLoader } from './memory-fk-loader.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { MemoryInterviewService } from './memory-interview.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { MeetingNotesCryptoService } from '../engagement/meeting-notes-crypto.service.js';
import { MemoryController } from './memory.controller.js';

/**
 * Institutional Memory module.
 *
 * Provides the canonical memory store, the FK loader + ingestion/backfill
 * services, the knowledge-graph surface (Intelligence "Knowledge Graph" tab),
 * and the retrieval/editing surface for the Settings "Memory" tab. The
 * interview service drafts section text from Q&A answers (graceful LLM
 * fallback). Exported so Meri and meeting-prep can read memory at runtime.
 *
 * Ingestion currently covers Phase A (structured entities), B (ClioMemory
 * unification), and C (meetings). Email (Graph) ingestion remains gated behind
 * the EMAIL guardrail and is not wired here.
 */
@Module({
  imports: [PrismaModule, TenantModule],
  controllers: [MemoryController],
  providers: [
    MemoryStoreService,
    MemoryFkLoader,
    MemoryIngestService,
    MemoryInterviewService,
    MemoryCandidateService,
    MeetingNotesCryptoService,
  ],
  exports: [MemoryStoreService, MemoryIngestService, MemoryCandidateService],
})
export class MemoryModule {}
