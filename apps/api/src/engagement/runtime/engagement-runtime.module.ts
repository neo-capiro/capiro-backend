import { Module } from '@nestjs/common';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import { resolveEngagementRuntimeEnvironment } from './engagement-runtime-env.js';

/**
 * Neutral composition boundary for Engagement runtime ownership.
 *
 * Request modules, worker modules, callbacks, Recall, and shared capability
 * modules all consume the same policy instance. Keeping the provider factory
 * here prevents each runtime from silently inventing a second owner policy.
 */
@Module({
  providers: [
    {
      provide: EngagementRuntimePolicyService,
      useFactory: () =>
        new EngagementRuntimePolicyService(
          resolveEngagementRuntimeEnvironment(process.env as Record<string, unknown>),
        ),
    },
  ],
  exports: [EngagementRuntimePolicyService],
})
export class EngagementRuntimeModule {}
