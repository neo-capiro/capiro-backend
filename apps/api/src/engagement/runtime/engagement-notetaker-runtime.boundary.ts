import type { MeetingBotProvider } from '../notetaker/meeting-bot.provider.js';
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
  receiveWebhook: { action: 'notetaker_dispatch', requiresCallbacks: true },
  handleBotEvent: { action: 'notetaker_dispatch', requiresCallbacks: true },
};

export const MEETING_BOT_EXTERNAL_METHODS: Readonly<Record<string, EngagementExternalAction>> = {
  dispatchBot: 'notetaker_dispatch',
  createAsyncTranscript: 'notetaker_dispatch',
  getTranscript: 'notetaker_dispatch',
  getTranscriptStatus: 'notetaker_dispatch',
  getBotCompletion: 'notetaker_dispatch',
  getRecordingId: 'notetaker_dispatch',
  leaveCall: 'notetaker_remove',
  deleteMedia: 'notetaker_remove',
};

export const NOTETAKER_BACKGROUND_METHODS: ReadonlySet<string> = new Set([
  'runReconcileSweep',
  'reconcileStaleTranscripts',
  'reconcileStrandedDrafting',
  'reconcileExpiredTranscripts',
  'reconcileStuckRecordings',
]);

/** Guard the raw Recall adapter independently of NotetakerService. */
export function guardMeetingBotProvider(
  provider: MeetingBotProvider,
  policy: EngagementRuntimePolicyService,
): MeetingBotProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const action = MEETING_BOT_EXTERNAL_METHODS[property];
      if (!action) return value.bind(target);
      return (...args: unknown[]) => {
        policy.assertExternalAction(action);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/**
 * Single-instance proxy for NotetakerService. Lifecycle registration is disabled
 * here so the request/core provider owns zero timers. EngagementWorkersModule
 * invokes the guarded runReconcileSweep method from its explicit worker shell.
 */
export function guardNotetakerService(
  service: NotetakerService,
  policy: EngagementRuntimePolicyService,
): NotetakerService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      if (property === 'onModuleInit' || property === 'onModuleDestroy') {
        return () => undefined;
      }
      const external = NOTETAKER_EXTERNAL_METHODS[property];
      if (external) {
        return (...args: unknown[]) => {
          policy.assertExternalAction(external.action);
          if (external.requiresCallbacks) policy.assertCallbacksEnabled(external.action);
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
