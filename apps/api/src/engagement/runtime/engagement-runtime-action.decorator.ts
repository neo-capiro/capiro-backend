import type { EngagementExternalAction } from './engagement-runtime.types.js';

export const ENGAGEMENT_RUNTIME_ACTION_KEY = '__engagement_runtime_action__';

export interface EngagementRuntimeActionMetadata {
  action: EngagementExternalAction;
  requiresCallbacks?: boolean;
  testMode?: boolean;
}

/**
 * Colocated route metadata. Metadata is written to the actual handler function,
 * which is the target Nest's Reflector receives from ExecutionContext.
 */
export function EngagementRuntimeAction(
  action: EngagementExternalAction,
  options?: { requiresCallbacks?: boolean; testMode?: boolean },
): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const handler = descriptor?.value;
    if (typeof handler !== 'function') {
      throw new TypeError('EngagementRuntimeAction can only decorate methods');
    }
    const metadata: EngagementRuntimeActionMetadata = {
      action,
      requiresCallbacks: options?.requiresCallbacks ?? false,
      testMode: options?.testMode ?? false,
    };
    Reflect.defineMetadata(ENGAGEMENT_RUNTIME_ACTION_KEY, metadata, handler);
  };
}
