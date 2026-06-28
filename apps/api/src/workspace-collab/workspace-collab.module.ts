import { Module } from '@nestjs/common';
import { WorkspaceCollabController } from './workspace-collab.controller.js';
import { WorkspaceCollabEmailService } from './workspace-collab-email.service.js';

/** Workspace collaborator-invite email delivery (E-19). */
@Module({
  controllers: [WorkspaceCollabController],
  providers: [WorkspaceCollabEmailService],
})
export class WorkspaceCollabModule {}
