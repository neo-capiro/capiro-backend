import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { EngagementRuntimeModule } from '../engagement/runtime/engagement-runtime.module.js';
import { ClientDocumentWriterService } from './client-document-writer.service.js';

/** Narrow governed compatibility boundary over the authoritative document implementation. */
@Module({
  imports: [EngagementModule, EngagementRuntimeModule],
  providers: [ClientDocumentWriterService],
  exports: [ClientDocumentWriterService],
})
export class ClientDocumentsModule {}
