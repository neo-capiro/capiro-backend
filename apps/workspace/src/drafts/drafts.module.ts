import { EditorialDraftSourceController } from './editorial-source.controller.js';
import { Module } from '@nestjs/common';
import { DraftsController } from './drafts.controller.js';
import { DraftsService } from './drafts.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { PreparationSourceController } from './preparation-source.controller.js';
import { PreparationSourceGuard } from './preparation-source.guard.js';
import { ResearchDraftSourceController } from './research-source.controller.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [
    EditorialDraftSourceController,
    DraftsController,
    PreparationSourceController,
    ResearchDraftSourceController,
  ],
  providers: [DraftsService, PreparationSourceGuard],
  exports: [DraftsService],
})
export class DraftsModule {}
