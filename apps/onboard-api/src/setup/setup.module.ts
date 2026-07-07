import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

/**
 * Flow-2A external setup dashboard: org-level task state (CAS transitions),
 * IT-admin invites, and setup completion (the trial-clock anchor).
 */
@Module({
  imports: [EmailModule],
  controllers: [SetupController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
