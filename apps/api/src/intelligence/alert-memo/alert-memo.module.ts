import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { MemoryModule } from '../../memory/memory.module.js';
import { MeriDocgenService } from '../../meri/meri-docgen.service.js';
import { AlertMemoController } from './alert-memo.controller.js';
import { AlertMemoService } from './alert-memo.service.js';

/**
 * Alert → client-memo generation. Standalone module so it can pull exactly what
 * the memo needs without widening the intelligence module's dependency graph:
 *   - EngagementModule → EngagementService (Documents auto-file) + AiCredentialResolverService (per-tenant key)
 *   - MemoryModule → MemoryStoreService (client Memory files as steering)
 * MeriDocgenService is dependency-free (docx rendering), so we provide it directly
 * rather than widen MeriModule's exports.
 */
@Module({
  imports: [EngagementModule, MemoryModule],
  controllers: [AlertMemoController],
  providers: [AlertMemoService, MeriDocgenService],
})
export class AlertMemoModule {}
