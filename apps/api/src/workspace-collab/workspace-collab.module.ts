import { Module } from '@nestjs/common';
import { WorkspaceCollabController } from './workspace-collab.controller.js';
import { WorkspaceCollabEmailService } from './workspace-collab-email.service.js';
import { NewsletterReviewEmailWorker } from './newsletter-review-email.worker.js';
import { NewsletterInvitationEmailWorker } from './newsletter-invitation-email.worker.js';
import { TenantAdminModule } from '../tenant-admin/tenant-admin.module.js';
import { NewsletterAccountInvitationService } from './newsletter-account-invitation.service.js';
import { NewsletterAccountInvitationController } from './newsletter-account-invitation.controller.js';
import { NewsletterAccountProvider } from './newsletter-account-provider.js';

/** Workspace collaborator-invite email delivery (E-19). */
@Module({
  imports: [TenantAdminModule],
  controllers: [WorkspaceCollabController, NewsletterAccountInvitationController],
  providers: [
    WorkspaceCollabEmailService,
    NewsletterReviewEmailWorker,
    NewsletterInvitationEmailWorker,
    NewsletterAccountInvitationService,
    NewsletterAccountProvider,
  ],
})
export class WorkspaceCollabModule {}
