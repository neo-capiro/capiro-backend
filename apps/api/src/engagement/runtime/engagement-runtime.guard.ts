import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ENGAGEMENT_RUNTIME_ACTION_KEY,
  type EngagementRuntimeActionMetadata,
} from './engagement-runtime-action.decorator.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

/**
 * Global guard for the EngagementApiAppModule.
 *
 * Reads @EngagementRuntimeAction metadata from the handler and calls
 * EngagementRuntimePolicyService before the controller body executes.
 *
 * - Routes without action metadata are allowed (ordinary DB-local reads/writes).
 * - Routes with requiresCallbacks also get assertCallbacksEnabled.
 * - The guard does not depend on tenant context and is safe on OAuth
 *   callbacks that have no Clerk token.
 *
 * Registered as a global guard ONLY in EngagementApiAppModule, never in AppModule.
 */
@Injectable()
export class EngagementRuntimeGuard implements CanActivate {
  private readonly logger = new Logger(EngagementRuntimeGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly policy: EngagementRuntimePolicyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const metadata = Reflect.getMetadata(
      ENGAGEMENT_RUNTIME_ACTION_KEY,
      handler.constructor,
      handler.name,
    ) as EngagementRuntimeActionMetadata | undefined;

    // No action metadata — this is a DB-local route, allow through.
    if (!metadata) return true;

    // Callback routes (OAuth callbacks, Microsoft notifications) require
    // callbacks to be enabled in addition to the external-action check.
    if (metadata.requiresCallbacks) {
      this.policy.assertCallbacksEnabled(metadata.action);
    }

    // Assert the external action is allowed. Throws 503 if not.
    this.policy.assertExternalAction(metadata.action, {
      testMode: metadata.testMode,
    });

    return true;
  }
}
