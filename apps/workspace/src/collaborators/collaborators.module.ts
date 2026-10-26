import { Module } from '@nestjs/common';
import { CollaboratorsController, CollaboratorInvitationEmailController } from './collaborators.controller.js';
import { CollaboratorsService } from './collaborators.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

/**
 * Collaborators + the central role-resolution/enforcement service. Exported so
 * the other feature modules (drafts, documents, comments, edit-lock) can inject
 * CollaboratorsService.assertCan to enforce the role matrix on their mutations.
 * Imports NotificationsModule so invite/accept/decline emit in-app notifications.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [CollaboratorsController, CollaboratorInvitationEmailController],
  providers: [CollaboratorsService],
  exports: [CollaboratorsService],
})
export class CollaboratorsModule {}
