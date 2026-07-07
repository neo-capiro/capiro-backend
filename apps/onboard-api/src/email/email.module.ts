import { Module } from '@nestjs/common';
import { EmailService } from './email.service.js';

/**
 * SES onboarding email delivery (idempotent via onboard_email_log). Consumed
 * by the funnel (confirmation/receipt/IT-invite/CS notifications) and, in
 * Phase 6, the trial lifecycle crons.
 */
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
