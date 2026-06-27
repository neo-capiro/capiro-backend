import { Module } from '@nestjs/common';
import { DraftsController } from './drafts.controller.js';
import { DraftsService } from './drafts.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [DraftsController],
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
