import type { NotetakerService } from '../notetaker/notetaker.service.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import type { EngagementExternalAction } from './engagement-runtime.types.js';

interface ExternalMethodMetadata {
  action: EngagementExternalAction;
  requiresCallbacks?: boolean;
}

export const NOTETAKER_EXTERNAL_METHODS: Readonly<
  Record<string, ExternalMethodMetadata>
> = {
  dispatch: { action: 'notetaker_dispatch' },
  remove: { action: 'notetaker_remove' },
  handleBotEvent: { action: 'notetaker_dispatch', requiresCallbacks: true },
};

export const NOTETAKER_BACKGROUND_METHODS: ReadonlySet<string> = new Set([
  'runReconcileSweep',
  'reconcileStaleTranscripts',
  'reconcileStrandedDrafting',
  'reconcileExpiredTranscripts',
  'reconcileStuckRecordings',
]);

/**
 * Single-instance proxy for NotetakerService.
 *
 * The service owns an onModuleInit timer, so it must not be registered under a
 * second raw Nest token. The module constructs it once and returns this proxy;
 * lifecycle hooks pass through to the same instance, while every externally
 * acting or background-owned public entry point is independently fail-closed.
 */
export function guardNotetakerService(
  service: NotetakerService,
  policy: EngagementRuntimePolicyService,
): NotetakerService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const external = NOTETAKER_EXTERNAL_METHODS[property];
      if (external) {
        return (...args: unknown[]) => {
          policy.assertExternalAction(external.action);
          if (external.requiresCallbacks) {
            policy.assertCallbacksEnabled(external.action);
          }
          return Reflect.apply(value, target, args);
        };
      }
      if (NOTETAKER_BACKGROUND_METHODS.has(property)) {
        return (...args: unknown[]) => {
          policy.assertBackgroundOwner('notetaker-reconcile');
          return Reflect.apply(value, target, args);
        };
      }
      return value.bind(target);
    },
  });
}
