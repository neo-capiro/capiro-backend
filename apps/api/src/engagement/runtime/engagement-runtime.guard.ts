import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ENGAGEMENT_RUNTIME_ACTION_KEY,
  type EngagementRuntimeActionMetadata,
} from './engagement-runtime-action.decorator.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import {
  runtimePolicyForHandler,
  sameRuntimeMetadata,
} from './engagement-runtime-route-policy.js';

/** Global only in EngagementApiAppModule; AppModule behavior is unchanged. */
@Injectable()
export class EngagementRuntimeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: EngagementRuntimePolicyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controllerName = context.getClass().name;
    const handlerName = handler.name;

    const decorated = this.reflector.get<EngagementRuntimeActionMetadata>(
      ENGAGEMENT_RUNTIME_ACTION_KEY,
      handler,
    );
    const registered = runtimePolicyForHandler(controllerName, handlerName);

    if (decorated && registered && !sameRuntimeMetadata(decorated, registered)) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_RUNTIME_POLICY_MISMATCH',
        action: registered.action,
        message: 'The engagement-api route policy is inconsistent and has been disabled.',
      });
    }

    const metadata = registered ?? decorated;
    if (!metadata) return true;

    // Preserve the stable shadow error contract. When both controls are off,
    // external-action denial wins; callback denial remains effective in a
    // future active runtime with callbacks independently disabled.
    this.policy.assertExternalAction(metadata.action, {
      testMode: metadata.testMode,
    });
    if (metadata.requiresCallbacks) {
      this.policy.assertCallbacksEnabled(metadata.action);
    }

    return true;
  }
}
