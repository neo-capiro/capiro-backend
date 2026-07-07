import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { EmailModule } from '../email/email.module.js';
import { LifecycleService } from './lifecycle.service.js';

/**
 * Trial/billing lifecycle engine (Phase 6) — consumed by the `lifecycle-daily`
 * task-runner verb (EventBridge → RunTask), never by an HTTP route.
 */
@Module({
  imports: [BillingModule, EmailModule],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
