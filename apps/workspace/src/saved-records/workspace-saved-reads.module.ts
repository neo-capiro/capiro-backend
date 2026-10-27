import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { VersionsModule } from '../versions/versions.module.js';
import { CommentsModule } from '../comments/comments.module.js';
import { HillDayModule } from '../hillday/hillday.module.js';
import { NewsletterModule } from '../newsletters/newsletter.module.js';
import { WorkspaceSavedReadsController } from './workspace-saved-reads.controller.js';

@Module({
  imports: [DocumentsModule, VersionsModule, CommentsModule, HillDayModule, NewsletterModule],
  controllers: [WorkspaceSavedReadsController],
})
export class WorkspaceSavedReadsModule {}
