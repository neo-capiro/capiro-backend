import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { ClientBriefCopyController } from './client-brief-copy.controller.js';

@Module({
  imports: [CollaboratorsModule, DraftsModule],
  controllers: [DocumentsController, ClientBriefCopyController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
