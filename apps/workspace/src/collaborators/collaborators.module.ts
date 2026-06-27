import { Module } from '@nestjs/common';
import { CollaboratorsController } from './collaborators.controller.js';
import { CollaboratorsService } from './collaborators.service.js';

/**
 * Collaborators + the central role-resolution/enforcement service. Exported so
 * the other feature modules (drafts, documents, comments, edit-lock) can inject
 * CollaboratorsService.assertCan to enforce the role matrix on their mutations.
 */
@Module({
  controllers: [CollaboratorsController],
  providers: [CollaboratorsService],
  exports: [CollaboratorsService],
})
export class CollaboratorsModule {}
