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

/**
 * Every external action that the runtime policy can gate.
 *
 * Extend only when the accepted Phase 0 side-effect registry identifies
 * a new external action.
 */
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
  | 'attachment_external_write';

/**
 * Shape of the policy snapshot returned by `EngagementRuntimePolicyService.snapshot()`.
 *
 * Must never include secrets, tokens, credentials, or tenant data.
 */
export interface EngagementRuntimeSnapshot {
  serviceName: CapiroServiceName;
  processMode: EngagementProcessMode;
  backgroundOwner: EngagementBackgroundOwner;
  externalActions: EngagementExternalActionMode;
  callbacksEnabled: boolean;
  recallWebhookEnabled: boolean;
}

/**
 * Options passed to `assertExternalAction` / `externalActionAllowed`.
 */
export interface AssertExternalActionOptions {
  testMode?: boolean;
}
