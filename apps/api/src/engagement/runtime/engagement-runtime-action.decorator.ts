import type { EngagementExternalAction } from './engagement-runtime.types.js';

/**
 * Metadata key for the EngagementRuntimeAction decorator.
 */
export const ENGAGEMENT_RUNTIME_ACTION_KEY = '__engagement_runtime_action__';

export interface EngagementRuntimeActionMetadata {
  action: EngagementExternalAction;
  requiresCallbacks?: boolean;
  testMode?: boolean;
}

/**
 * Decorator that marks a controller route as requiring an external-action
 * policy check. The EngagementRuntimeGuard reads this metadata and calls
 * EngagementRuntimePolicyService.assertExternalAction / assertCallbacksEnabled
 * before the controller body executes.
 *
 * Usage:
 *   @EngagementRuntimeAction('integration_sync')
 *   @EngagementRuntimeAction('integration_oauth_callback', { requiresCallbacks: true })
 *   @EngagementRuntimeAction('outreach_test_send', { testMode: true })
 */
export function EngagementRuntimeAction(
  action: EngagementExternalAction,
  options?: { requiresCallbacks?: boolean; testMode?: boolean },
): MethodDecorator {
  return <T>(
    _target: object,
    _propertyKey: string | symbol,
    _descriptor: TypedPropertyDescriptor<T>,
  ) => {
    const metadata: EngagementRuntimeActionMetadata = {
      action,
      requiresCallbacks: options?.requiresCallbacks ?? false,
      testMode: options?.testMode ?? false,
    };
    Reflect.defineMetadata(ENGAGEMENT_RUNTIME_ACTION_KEY, metadata, _target, _propertyKey);
  };
}
