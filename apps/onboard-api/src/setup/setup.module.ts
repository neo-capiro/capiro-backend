import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { CapiroAdminGuard } from '../auth/capiro-admin.guard.js';
import { SetupAdminController, SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

/**
 * Flow-2A external setup dashboard: org-level task state (CAS transitions),
 * IT-admin invites, setup completion (the trial-clock anchor), and the
 * capiro_admin managed-import completion action.
 */
@Module({
  imports: [EmailModule],
  controllers: [SetupController, SetupAdminController],
  providers: [SetupService, CapiroAdminGuard],
  exports: [SetupService],
})
export class SetupModule {}
