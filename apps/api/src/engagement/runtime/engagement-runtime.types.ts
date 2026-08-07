/**
 * Engagement Runtime Policy — shared types.
 *
 * These types govern the fail-closed shadow-mode behavior of the
 * engagement-api process. The policy service reads validated config
 * and provides a single source of truth for whether background workers,
 * external actions, callbacks, and Recall webhooks are allowed.
 */

export type CapiroServiceName = 'api' | 'engagement-api';

export type EngagementProcessMode = 'shadow' | 'active';

export type EngagementBackgroundOwner = 'api' | 'engagement-api' | 'disabled';

export type EngagementExternalActionMode = 'disabled' | 'test_only' | 'enabled';

/** Every external or sensitive boundary gated by the runtime policy. */
export type EngagementExternalAction =
  | 'outreach_generate'
  | 'outreach_send'
  | 'outreach_test_send'
  | 'meeting_prep_generate'
  | 'meeting_debrief_generate'
  | 'integration_oauth_start'
  | 'integration_oauth_callback'
  | 'integration_disconnect'
  | 'integration_sync'
  | 'integration_subscription'
  | 'integration_notification'
  | 'notetaker_dispatch'
  | 'notetaker_remove'
  | 'attachment_external_read'
  | 'attachment_external_write'
  | 'internal_ai_credential_resolve';

export interface EngagementRuntimeSnapshot {
  serviceName: CapiroServiceName;
  processMode: EngagementProcessMode;
  backgroundOwner: EngagementBackgroundOwner;
  externalActions: EngagementExternalActionMode;
  callbacksEnabled: boolean;
  recallWebhookEnabled: boolean;
}

export interface AssertExternalActionOptions {
  testMode?: boolean;
}
