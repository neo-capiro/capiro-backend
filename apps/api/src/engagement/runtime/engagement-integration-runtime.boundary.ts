import type { GmailSendService } from '../google/gmail-send.service.js';
import type { GoogleOAuthService } from '../google/google-oauth.service.js';
import type { GoogleSyncService } from '../google/google-sync.service.js';
import type { GoogleTokenService } from '../google/google-token.service.js';
import type { MicrosoftGraphSyncService } from '../microsoft/microsoft-graph-sync.service.js';
import type { MicrosoftOAuthService } from '../microsoft/microsoft-oauth.service.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import type {
  EngagementExternalAction,
  EngagementMailHandoffBoundary,
} from './engagement-runtime.types.js';

export const RAW_MICROSOFT_GRAPH_SYNC_SERVICE = Symbol('RAW_MICROSOFT_GRAPH_SYNC_SERVICE');
export const RAW_MICROSOFT_OAUTH_SERVICE = Symbol('RAW_MICROSOFT_OAUTH_SERVICE');
export const RAW_GOOGLE_TOKEN_SERVICE = Symbol('RAW_GOOGLE_TOKEN_SERVICE');
export const RAW_GOOGLE_SYNC_SERVICE = Symbol('RAW_GOOGLE_SYNC_SERVICE');
export const RAW_GOOGLE_OAUTH_SERVICE = Symbol('RAW_GOOGLE_OAUTH_SERVICE');
export const RAW_GMAIL_SEND_SERVICE = Symbol('RAW_GMAIL_SEND_SERVICE');

interface BoundaryMetadata {
  action: EngagementExternalAction;
  testMode?: boolean;
  requiresCallbacks?: boolean;
  /**
   * Mail-handoff admission performed by this method, gated at the service proxy.
   * `initiation` opens a real admission and owns the whole returned promise;
   * `continuation` requires an ALREADY live record (admitted callback, queue drain,
   * scheduler tick, admitted disconnect) and never opens one.
   */
  handoff?: {
    boundary: EngagementMailHandoffBoundary;
    mode: 'initiation' | 'continuation';
  };
}

export const MICROSOFT_GRAPH_RUNTIME_METHODS = {
  // Reads and sends stay unmapped: they perform no initiation and are gated by the
  // external-action check only.
  readIncomingFiles: { action: 'integration_sync' },
  readTeams: { action: 'integration_sync' },
  syncConnection: {
    action: 'integration_sync',
    handoff: { boundary: 'integration_sync', mode: 'initiation' },
  },
  runCalendarCommand: {
    action: 'integration_sync',
    handoff: { boundary: 'integration_calendar_commands', mode: 'initiation' },
  },
  syncConnectionByTenant: {
    action: 'integration_sync',
    handoff: { boundary: 'integration_sync', mode: 'continuation' },
  },
  syncCalendarWindow: {
    action: 'integration_sync',
    handoff: { boundary: 'integration_sync', mode: 'initiation' },
  },
  configureSubscriptions: {
    action: 'integration_subscription',
    handoff: { boundary: 'integration_subscription', mode: 'initiation' },
  },
  configureSubscriptionsByTenant: {
    action: 'integration_subscription',
    handoff: { boundary: 'integration_subscription', mode: 'continuation' },
  },
  handleNotifications: {
    action: 'integration_notification',
    requiresCallbacks: true,
    handoff: { boundary: 'callback_notification_admit', mode: 'initiation' },
  },
  // Reached from the admitted disconnect flow.
  deleteSubscriptionsByTenant: {
    action: 'integration_disconnect',
    handoff: { boundary: 'integration_disconnect', mode: 'continuation' },
  },
  sendMail: { action: 'outreach_send' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const MICROSOFT_OAUTH_RUNTIME_METHODS = {
  start: {
    action: 'integration_oauth_start',
    handoff: { boundary: 'oauth_state_issue', mode: 'initiation' },
  },
  handleCallback: {
    action: 'integration_oauth_callback',
    requiresCallbacks: true,
    handoff: { boundary: 'callback_notification_admit', mode: 'initiation' },
  },
  disconnect: {
    action: 'integration_disconnect',
    handoff: { boundary: 'integration_disconnect', mode: 'initiation' },
  },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GOOGLE_TOKEN_RUNTIME_METHODS = {
  loadConnection: { action: 'integration_sync' },
  // Deliberately unmapped: the cached-token return is a plain read and the raw
  // refresh/reconnect path owns its own admission at its real owner.
  getValidAccessToken: { action: 'integration_sync' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GOOGLE_SYNC_RUNTIME_METHODS = {
  syncConnection: {
    action: 'integration_sync',
    handoff: { boundary: 'integration_sync', mode: 'initiation' },
  },
  runCalendarCommand: {
    action: 'integration_sync',
    handoff: { boundary: 'integration_calendar_commands', mode: 'initiation' },
  },
  syncConnectionByTenant: {
    action: 'integration_sync',
    handoff: { boundary: 'integration_sync', mode: 'continuation' },
  },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GOOGLE_OAUTH_RUNTIME_METHODS = {
  start: {
    action: 'integration_oauth_start',
    handoff: { boundary: 'oauth_state_issue', mode: 'initiation' },
  },
  handleCallback: {
    action: 'integration_oauth_callback',
    requiresCallbacks: true,
    handoff: { boundary: 'callback_notification_admit', mode: 'initiation' },
  },
  disconnect: {
    action: 'integration_disconnect',
    handoff: { boundary: 'integration_disconnect', mode: 'initiation' },
  },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GMAIL_SEND_RUNTIME_METHODS = {
  readIncomingFiles: { action: 'integration_sync' },
  sendMail: { action: 'outreach_send' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

function resolveBoundaryAction(
  property: string,
  fallback: EngagementExternalAction,
  args: unknown[],
): EngagementExternalAction {
  if (property !== 'sendMail') return fallback;
  const input = args[2];
  if (!input || typeof input !== 'object') return fallback;
  const action = (input as { runtimeAction?: unknown }).runtimeAction;
  return action === 'outreach_v3_send' || action === 'outreach_v3_test_send' ? action : fallback;
}

function guardService<T extends object>(
  service: T,
  policy: EngagementRuntimePolicyService,
  methods: Readonly<Record<string, BoundaryMetadata>>,
): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const metadata = methods[property];
      if (!metadata) return value.bind(target);
      return (...args: unknown[]) => {
        const action = resolveBoundaryAction(property, metadata.action, args);
        policy.assertExternalAction(action, {
          testMode:
            metadata.testMode === true ||
            action === 'outreach_test_send' ||
            action === 'outreach_v3_test_send',
        });
        if (metadata.requiresCallbacks) {
          policy.assertCallbacksEnabled(metadata.action);
        }
        // Mail-handoff admission at the real service boundary.
        if (metadata.handoff?.mode === 'initiation') {
          // Synchronous NEW-work gate first (callers and existing tests see the
          // refusal at the call), then the admission owns the whole returned promise.
          policy.assertMailHandoffBoundary(metadata.handoff.boundary);
          return policy.runAdmittedMailHandoffWork(metadata.handoff.boundary, () =>
            Reflect.apply(value, target, args),
          );
        }
        if (metadata.handoff?.mode === 'continuation') {
          // Requires an already-live record; with none this falls back to the
          // NEW-work gate for the same boundary, so a direct call is still refused.
          policy.assertMailHandoffContinuation(metadata.handoff.boundary);
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function guardMicrosoftGraphSyncService(
  service: MicrosoftGraphSyncService,
  policy: EngagementRuntimePolicyService,
): MicrosoftGraphSyncService {
  return guardService(service, policy, MICROSOFT_GRAPH_RUNTIME_METHODS);
}

export function guardMicrosoftOAuthService(
  service: MicrosoftOAuthService,
  policy: EngagementRuntimePolicyService,
): MicrosoftOAuthService {
  return guardService(service, policy, MICROSOFT_OAUTH_RUNTIME_METHODS);
}

export function guardGoogleTokenService(
  service: GoogleTokenService,
  policy: EngagementRuntimePolicyService,
): GoogleTokenService {
  return guardService(service, policy, GOOGLE_TOKEN_RUNTIME_METHODS);
}

export function guardGoogleSyncService(
  service: GoogleSyncService,
  policy: EngagementRuntimePolicyService,
): GoogleSyncService {
  return guardService(service, policy, GOOGLE_SYNC_RUNTIME_METHODS);
}

export function guardGoogleOAuthService(
  service: GoogleOAuthService,
  policy: EngagementRuntimePolicyService,
): GoogleOAuthService {
  return guardService(service, policy, GOOGLE_OAUTH_RUNTIME_METHODS);
}

export function guardGmailSendService(
  service: GmailSendService,
  policy: EngagementRuntimePolicyService,
): GmailSendService {
  return guardService(service, policy, GMAIL_SEND_RUNTIME_METHODS);
}
