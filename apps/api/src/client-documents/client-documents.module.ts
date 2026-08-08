import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ClientDocumentWriterService } from './client-document-writer.service.js';

/** Narrow compatibility boundary over the authoritative document implementation. */
@Module({
  imports: [EngagementModule],
  providers: [ClientDocumentWriterService],
  exports: [ClientDocumentWriterService],
})
export class ClientDocumentsModule {}
