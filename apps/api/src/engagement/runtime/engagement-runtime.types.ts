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

export type EngagementExternalActionMode =
  'disabled' | 'test_only' | 'enabled' | 'integrations_only' | 'integrations_and_notetaker';

/**
 * Opt-in restriction of the background-worker surface.
 *
 * Deliberately a single typed token, not a list of worker names: the only
 * accepted value admits the one existing integration sync scheduler
 * (`engagement-sync-scheduler`) and no other worker. Omitted keeps the legacy
 * generic ownership behavior. See
 * EngagementRuntimePolicyService.backgroundWorkersEnabled.
 */
export type EngagementBackgroundWorkerRestriction = 'integration_sync_scheduler';

/** Every external or sensitive boundary gated by the runtime policy. */
export type EngagementExternalAction =
  | 'outreach_generate'
  | 'outreach_send'
  | 'outreach_test_send'
  | 'outreach_reasoning'
  | 'outreach_v3_generate'
  | 'outreach_v3_send'
  | 'outreach_v3_test_send'
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
  backgroundWorkerRestriction?: EngagementBackgroundWorkerRestriction;
}

export interface AssertExternalActionOptions {
  testMode?: boolean;
}

/**
 * Operator-selected mail-handoff admission phase.
 *
 * 'off' is the default and preserves legacy behavior exactly. Each later phase
 * admits strictly less than the previous one; selection is explicit, and an
 * invalid selection fails closed at boot rather than silently disabling the
 * barrier.
 */
export type EngagementMailHandoffPhase =
  | 'off'
  | 'initiation_fenced'
  | 'callback_fenced'
  | 'writers_closed';

/**
 * The real effect boundaries the handoff fence covers. These are service and
 * provider boundaries, not HTTP routes: a route-only guard cannot stop a direct,
 * internal or provider-initiated caller.
 */
export type EngagementMailHandoffBoundary =
  | 'integration_create'
  | 'oauth_state_issue'
  | 'oauth_callback_continue'
  | 'integration_sync'
  | 'integration_calendar_commands'
  | 'integration_subscription'
  | 'integration_disconnect'
  | 'capture_initiation'
  | 'identity_delete_initiation'
  | 'grant_refresh'
  | 'grant_persist'
  | 'callback_notification_admit'
  | 'scheduler_tick';

/** Options derived from the validated environment; absent = legacy 'off'. */
export interface EngagementMailHandoffSelection {
  phase: EngagementMailHandoffPhase;
  generation: string | null;
  fenceUtc: string | null;
}

/** Terminal disposition of one admitted unit. `unknown` is retained, never resolved. */
export type EngagementMailHandoffOutcome = 'settled' | 'failed' | 'unknown';

/**
 * Call-local outcome box owned by ONE admission record.
 *
 * The effect owner reports into it (`begin` before an external effect, then the
 * definite `settle`, or `unknown` when the result is not established); the record's
 * own finalizer reads it exactly once. It is never shared between admissions, so
 * concurrent work cannot mix results, and a reported `unknown` is never overwritten
 * by a later success of the same admission.
 */
export interface EngagementMailHandoffDisposition {
  begin(): void;
  settle(outcome: 'settled' | 'failed'): void;
  unknown(): void;
  hasReport(): boolean;
  outcome(): EngagementMailHandoffOutcome;
}

/** Settles one already-admitted unit of work with its real terminal outcome. */
export interface EngagementMailHandoffHandle {
  settle(outcome?: EngagementMailHandoffOutcome): void;
  /** The record's call-local outcome box, read by the owning finalizer. */
  readonly disposition: EngagementMailHandoffDisposition;
  /**
   * Server-owned continuation record. Object identity is what a nested grant
   * write presents; a request value cannot produce it.
   */
  context: EngagementMailHandoffContext;
}

/** Opaque, server-issued continuation context for nested grant writes. */
export interface EngagementMailHandoffContext {
  readonly boundary: EngagementMailHandoffBoundary;
}

/**
 * Bounded per-process readback for the existing authenticated diagnostic surface.
 * Content-free by construction: no credentials, tokens, tenant or customer
 * identifiers and no business content.
 */
export interface EngagementMailHandoffObservation {
  processIdentity: string;
  taskIdentity: string;
  releaseIdentity: string;
  serviceName: CapiroServiceName;
  configuredPhase: EngagementMailHandoffPhase;
  generation: string | null;
  fenceUtc: string | null;
  configuredAtUtc: string | null;
  phaseSelectionMode: 'boot-static';
  admissionClosedLocally: boolean;
  liveAdmissionCount: number;
  initiationRefusals: Record<string, number>;
  admittedWork: Record<string, number>;
  activeWork: Record<string, number>;
  settledWork: Record<string, number>;
  failedWork: Record<string, number>;
  unknownWork: Record<string, number>;
  admittedTotal: number;
  activeTotal: number;
  settledTotal: number;
  failedTotal: number;
  unknownTotal: number;
  localClosure: boolean;
  outcomeReconciled: boolean;
}
