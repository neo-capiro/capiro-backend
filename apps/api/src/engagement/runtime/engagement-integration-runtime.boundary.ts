import type { GmailSendService } from '../google/gmail-send.service.js';
import type { GoogleOAuthService } from '../google/google-oauth.service.js';
import type { GoogleSyncService } from '../google/google-sync.service.js';
import type { GoogleTokenService } from '../google/google-token.service.js';
import type { MicrosoftGraphSyncService } from '../microsoft/microsoft-graph-sync.service.js';
import type { MicrosoftOAuthService } from '../microsoft/microsoft-oauth.service.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import type { EngagementExternalAction } from './engagement-runtime.types.js';

export const RAW_MICROSOFT_GRAPH_SYNC_SERVICE = Symbol('RAW_MICROSOFT_GRAPH_SYNC_SERVICE');
export const RAW_MICROSOFT_OAUTH_SERVICE = Symbol('RAW_MICROSOFT_OAUTH_SERVICE');
export const RAW_GOOGLE_TOKEN_SERVICE = Symbol('RAW_GOOGLE_TOKEN_SERVICE');
export const RAW_GOOGLE_SYNC_SERVICE = Symbol('RAW_GOOGLE_SYNC_SERVICE');
export const RAW_GOOGLE_OAUTH_SERVICE = Symbol('RAW_GOOGLE_OAUTH_SERVICE');
export const RAW_GMAIL_SEND_SERVICE = Symbol('RAW_GMAIL_SEND_SERVICE');

interface BoundaryMetadata {
  action: EngagementExternalAction;
  testMode?: boolean;
}

export const MICROSOFT_GRAPH_RUNTIME_METHODS = {
  syncConnection: { action: 'integration_sync' },
  syncConnectionByTenant: { action: 'integration_sync' },
  syncCalendarWindow: { action: 'integration_sync' },
  configureSubscriptions: { action: 'integration_subscription' },
  configureSubscriptionsByTenant: { action: 'integration_subscription' },
  handleNotifications: { action: 'integration_notification' },
  deleteSubscriptionsByTenant: { action: 'integration_disconnect' },
  sendMail: { action: 'outreach_send' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const MICROSOFT_OAUTH_RUNTIME_METHODS = {
  start: { action: 'integration_oauth_start' },
  handleCallback: { action: 'integration_oauth_callback' },
  disconnect: { action: 'integration_disconnect' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GOOGLE_TOKEN_RUNTIME_METHODS = {
  loadConnection: { action: 'integration_sync' },
  getValidAccessToken: { action: 'integration_sync' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GOOGLE_SYNC_RUNTIME_METHODS = {
  syncConnection: { action: 'integration_sync' },
  syncConnectionByTenant: { action: 'integration_sync' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GOOGLE_OAUTH_RUNTIME_METHODS = {
  start: { action: 'integration_oauth_start' },
  handleCallback: { action: 'integration_oauth_callback' },
  disconnect: { action: 'integration_disconnect' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

export const GMAIL_SEND_RUNTIME_METHODS = {
  sendMail: { action: 'outreach_send' },
} as const satisfies Readonly<Record<string, BoundaryMetadata>>;

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
        policy.assertExternalAction(metadata.action, { testMode: metadata.testMode });
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
