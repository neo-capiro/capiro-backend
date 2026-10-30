import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  CapiroServiceName,
  EngagementBackgroundOwner,
  EngagementBackgroundWorkerRestriction,
  EngagementExternalAction,
  EngagementExternalActionMode,
  EngagementMailHandoffBoundary,
  EngagementMailHandoffContext,
  EngagementMailHandoffDisposition,
  EngagementMailHandoffHandle,
  EngagementMailHandoffObservation,
  EngagementMailHandoffOutcome,
  EngagementMailHandoffPhase,
  EngagementMailHandoffSelection,
  EngagementProcessMode,
  EngagementRuntimeSnapshot,
} from './engagement-runtime.types.js';
import {
  mailHandoff as processMailHandoff,
  type EngagementMailHandoffBarrier,
} from './engagement-mail-handoff.js';
import { meetingPrepEnabled } from '../meeting-prep-policy.js';

/**
 * The existing versioned-outreach feature flag, read the way the config schema reads it. Absent
 * means OFF: ownership alone must never start the ordinary sender, so every admission branch in
 * `ordinaryOutreachSendWorkerEnabled()` is gated on this.
 */
export function ordinaryOutreachSendEnabled(): boolean {
  const value = (process.env.ENGAGEMENT_VERSIONED_OUTREACH ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(value);
}

/**
 * Central runtime policy service for the Engagement API extraction.
 *
 * A single source of truth that every background timer, external-action
 * route, and provider boundary consults before doing work.
 *
 * In shadow mode (engagement-api) the policy fails closed:
 *   - no background timers start;
 *   - no external actions execute, except the separately feature-gated
 *     Outreach V3 reasoning provider boundary;
 *   - no OAuth callbacks or notifications are processed;
 *   - no Recall webhooks are handled.
 */
@Injectable()
export class EngagementRuntimePolicyService {
  private readonly logger = new Logger(EngagementRuntimePolicyService.name);

  private readonly serviceName: CapiroServiceName;
  private readonly processMode: EngagementProcessMode;
  private readonly backgroundOwner: EngagementBackgroundOwner;
  private readonly externalActionsMode: EngagementExternalActionMode;
  private readonly callbacksEnabled: boolean;
  private readonly recallWebhookEnabled: boolean;
  private readonly backgroundWorkerRestriction?: EngagementBackgroundWorkerRestriction;
  /** The barrier this policy owns: the process singleton in Nest, or a test instance. */
  private readonly mailHandoffBarrier: EngagementMailHandoffBarrier;

  constructor(config: {
    serviceName: CapiroServiceName;
    processMode: EngagementProcessMode;
    backgroundOwner: EngagementBackgroundOwner;
    externalActions: EngagementExternalActionMode;
    callbacksEnabled: boolean;
    recallWebhookEnabled: boolean;
    backgroundWorkerRestriction?: EngagementBackgroundWorkerRestriction;
    mailHandoff?: EngagementMailHandoffSelection;
  }, barrier?: EngagementMailHandoffBarrier) {
    this.serviceName = config.serviceName;
    this.processMode = config.processMode;
    this.backgroundOwner = config.backgroundOwner;
    this.externalActionsMode = config.externalActions;
    this.callbacksEnabled = config.callbacksEnabled;
    this.recallWebhookEnabled = config.recallWebhookEnabled;
    this.backgroundWorkerRestriction = config.backgroundWorkerRestriction;
    // The policy OWNS its barrier: the process singleton under normal Nest wiring,
    // or an explicitly supplied instance for isolated cases. Binding is once-only
    // inside the barrier, so a helper constructed with an omitted selection cannot
    // reset an existing fence or mix generations.
    this.mailHandoffBarrier = barrier ?? processMailHandoff;
    this.mailHandoffBarrier.bind({
      serviceName: config.serviceName,
      processMode: config.processMode,
      backgroundOwner: config.backgroundOwner,
      externalActions: config.externalActions,
      callbacksEnabled: config.callbacksEnabled,
      recallWebhookEnabled: config.recallWebhookEnabled,
      backgroundWorkerRestriction: config.backgroundWorkerRestriction,
      mailHandoff: config.mailHandoff,
    });
  }

  snapshot(): EngagementRuntimeSnapshot {
    return {
      serviceName: this.serviceName,
      processMode: this.processMode,
      backgroundOwner: this.backgroundOwner,
      externalActions: this.externalActionsMode,
      callbacksEnabled: this.callbacksEnabled,
      recallWebhookEnabled: this.recallWebhookEnabled,
      backgroundWorkerRestriction: this.backgroundWorkerRestriction,
    };
  }

  /**
   * Mail-handoff admission fence. Delegated by every service/provider boundary
   * that performs an actual state or provider effect, so the refusal happens
   * before the effect rather than at an HTTP route.
   */
  mailHandoffPhase(): EngagementMailHandoffPhase {
    return this.mailHandoffBarrier.phase();
  }

  assertMailHandoffInitiation(boundary: EngagementMailHandoffBoundary): void {
    this.mailHandoffBarrier.assertInitiation(boundary);
  }

  /**
   * Route a boundary to the correct decision. Grant writes (token refresh and
   * token persistence) require a LIVE admitted record, so an already-admitted
   * callback or queue drain keeps its nested refresh while a new writer is
   * refused. Every other boundary is a new-work gate.
   */
  assertMailHandoffBoundary(
    boundary: EngagementMailHandoffBoundary,
    context?: EngagementMailHandoffContext,
  ): void {
    if (boundary === 'grant_refresh' || boundary === 'grant_persist') {
      this.mailHandoffBarrier.assertGrantWrite(boundary, context);
      return;
    }
    this.mailHandoffBarrier.assertInitiation(boundary);
  }

  /**
   * Run one admitted unit inside its live record and settle it exactly once.
   * `disposition` lets the effect owner retain a real unknown outcome.
   */
  runAdmittedMailHandoffWork<T>(
    boundary: EngagementMailHandoffBoundary,
    work: () => Promise<T> | T,
    disposition?: () => EngagementMailHandoffOutcome,
  ): Promise<T> {
    return this.mailHandoffBarrier.runAdmitted(boundary, work, disposition);
  }

  /**
   * Explicit trusted continuation for an already-admitted owner (scheduled
   * sync/renewal, deferred notification drain, admitted disconnect). Requires a
   * live record; otherwise the NEW-admission gate for the same boundary applies.
   */
  assertMailHandoffContinuation(boundary: EngagementMailHandoffBoundary): void {
    this.mailHandoffBarrier.assertOwnedContinuation(boundary);
  }

  /** Enter an already-issued live handle (deferred queue drain). Never mints. */
  runMailHandoffInAdmission<T>(
    boundary: EngagementMailHandoffBoundary,
    context: EngagementMailHandoffContext,
    work: () => Promise<T> | T,
  ): Promise<T> {
    return this.mailHandoffBarrier.runInAdmission(boundary, context, work);
  }

  admitMailHandoffWork(boundary: EngagementMailHandoffBoundary): EngagementMailHandoffHandle {
    return this.mailHandoffBarrier.admitWork(boundary);
  }

  /**
   * Retain already-admitted work as a child of the live record in scope, so a
   * deferred queue item outlives its HTTP parent without opening a new admission.
   */
  retainMailHandoffAdmission(boundary: EngagementMailHandoffBoundary): EngagementMailHandoffHandle {
    return this.mailHandoffBarrier.retainAdmission(boundary);
  }

  /** The call-local outcome box of the live record in scope, if any. */
  mailHandoffDisposition(): EngagementMailHandoffDisposition | undefined {
    return this.mailHandoffBarrier.mailHandoffDisposition();
  }

  /** Synchronously stop admitting NEW mail work in this process (shutdown join). */
  beginMailHandoffLocalShutdown(): void {
    this.mailHandoffBarrier.beginLocalShutdown();
  }

  /** Resolve when this process owns no further admitted work. */
  waitForMailHandoffLocalSettlement(): Promise<void> {
    return this.mailHandoffBarrier.waitForLocalSettlement();
  }

  mailHandoffObservation(): EngagementMailHandoffObservation | null {
    return this.mailHandoffBarrier.observation();
  }

  private notetakerPostureEnabled(): boolean {
    return this.externalActionsMode === 'integrations_and_notetaker' &&
      this.serviceName === 'api' && this.processMode === 'shadow' &&
      this.backgroundOwner === 'api' && this.callbacksEnabled && this.recallWebhookEnabled;
  }

  /**
   * Whether background work may run in this process. The optional worker name
   * narrows the `integrations_only` posture: only the existing
   * `engagement-sync-scheduler` is admitted, and only on the explicitly owned
   * API sync posture. A no-argument call keeps the generic meaning (false in
   * `integrations_only`).
   * The separately explicit notetaker posture adds only its two existing guard
   * names; generic workers remain disabled.
   * An explicitly configured `backgroundWorkerRestriction` narrows an otherwise
   * generic owner immediately after the disabled-owner and owner-identity
   * guards: only the exact `engagement-sync-scheduler` name is admitted, while
   * no argument, a blank name and every other name stay denied rather than
   * falling through to generic ownership.
   */
  backgroundWorkersEnabled(workerName?: string): boolean {
    if (this.backgroundOwner === 'disabled') return false;
    if (this.backgroundOwner !== this.serviceName) return false;
    if (this.backgroundWorkerRestriction) {
      return workerName === 'engagement-sync-scheduler';
    }
    if (this.externalActionsMode === 'integrations_and_notetaker') {
      return this.notetakerPostureEnabled() &&
        ['engagement-sync-scheduler', 'notetaker-reconcile', 'client-notetaker'].includes(workerName ?? '');
    }
    if (this.externalActionsMode === 'integrations_only') {
      return this.serviceName === 'api' && workerName === 'engagement-sync-scheduler';
    }
    return true;
  }

  /** Dedicated exception for the send-intent worker, scoped to V3 sessions. */
  outreachV3SendIntentWorkerEnabled(): boolean {
    return (
      this.externalActionsMode !== 'integrations_only' &&
      this.externalActionsMode !== 'integrations_and_notetaker' &&
      this.serviceName === 'engagement-api' &&
      process.env.OUTREACH_V3_STATE_ENABLED === 'true' &&
      process.env.OUTREACH_V3_DRAFTS_ENABLED === 'true' &&
      process.env.OUTREACH_V3_SEND_ENABLED === 'true'
    );
  }

  assertOutreachV3SendIntentWorker(): void {
    if (!this.outreachV3SendIntentWorkerEnabled()) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'OUTREACH_V3_SEND_WORKER_DISABLED',
        message: 'The Outreach V3 send-intent worker is disabled.',
      });
    }
  }

  /**
   * Dedicated exception for the comprehensive meeting-prep worker on the final API owner.
   *
   * It admits ONLY the meeting-prep worker, and only on the exact accepted final tuple: the API
   * service in its active process mode, the API background owner, external actions enabled,
   * callbacks enabled, Recall webhooks disabled, the existing `integration_sync_scheduler`
   * restriction and an unphased (open) mail-handoff barrier. The comprehensive-prep feature flag
   * gates every branch in `meetingPrepWorkerEnabled()` below, so it is not re-checked here.
   * The generic scheduler-only selector keeps its exact meaning and is not widened.
   */
  private meetingPrepComprehensiveExceptionEnabled(): boolean {
    return (
      this.serviceName === 'api' &&
      this.processMode === 'active' &&
      this.backgroundOwner === 'api' &&
      this.externalActionsMode === 'enabled' &&
      this.callbacksEnabled &&
      !this.recallWebhookEnabled &&
      this.backgroundWorkerRestriction === 'integration_sync_scheduler' &&
      this.mailHandoffPhase() === 'off'
    );
  }

  /**
   * The single ownership predicate for the meeting-prep worker: startup and tick both consult it.
   * The existing comprehensive-prep feature flag is required for EVERY branch, so a legacy generic
   * owner keeps its original flag-off behavior (no timer, no tick) instead of starting on ownership
   * alone. When the flag is on, the existing named background policy remains authoritative where it
   * already admits prep; the dedicated exception above is the only additional admission and applies
   * to the meeting-prep worker alone.
   */
  meetingPrepWorkerEnabled(): boolean {
    if (!meetingPrepEnabled()) return false;
    if (this.backgroundWorkersEnabled('meeting-prep-worker')) return true;
    return this.meetingPrepComprehensiveExceptionEnabled();
  }

  /**
   * Dedicated exception for the ordinary canonical send-intent worker on the final API owner.
   *
   * It admits ONLY the ordinary sender, and only on the exact accepted final tuple: the API service
   * in its active process mode, the API background owner, external actions enabled, callbacks
   * enabled, Recall webhooks disabled, the existing `integration_sync_scheduler` restriction and an
   * unphased (open) mail-handoff barrier. The existing versioned-outreach flag gates every branch in
   * `ordinaryOutreachSendWorkerEnabled()` below, so it is not re-checked here. The generic
   * scheduler-only selector keeps its exact meaning and is never widened, and unnamed
   * `backgroundWorkersEnabled()` stays false on this tuple.
   */
  private ordinaryOutreachSendExceptionEnabled(): boolean {
    return (
      this.serviceName === 'api' &&
      this.processMode === 'active' &&
      this.backgroundOwner === 'api' &&
      this.externalActionsMode === 'enabled' &&
      this.callbacksEnabled &&
      !this.recallWebhookEnabled &&
      this.backgroundWorkerRestriction === 'integration_sync_scheduler' &&
      this.mailHandoffPhase() === 'off'
    );
  }

  /**
   * The single ownership predicate for the ordinary canonical sender: startup and every tick/sweep
   * consult it. The existing `ENGAGEMENT_VERSIONED_OUTREACH` flag is required for EVERY branch, so a
   * flag-off process never starts a timer and never sweeps, even when the ownership tuple matches.
   * Where the existing named background policy already admits this worker, that admission stands; the
   * dedicated exception above is the only additional admission and applies to this worker alone.
   * The V3-only selector is a separate existing path and is not changed here.
   */
  ordinaryOutreachSendWorkerEnabled(): boolean {
    if (!ordinaryOutreachSendEnabled()) return false;
    if (this.backgroundWorkersEnabled('outreach-send-intent-worker')) return true;
    return this.ordinaryOutreachSendExceptionEnabled();
  }

  assertOrdinaryOutreachSendWorker(): void {
    if (!this.ordinaryOutreachSendWorkerEnabled()) {
      this.logger.log(
        `outreach-send-intent-worker disabled by engagement runtime policy ` +
          `(service=${this.serviceName} owner=${this.backgroundOwner} mode=${this.processMode})`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_BACKGROUND_DISABLED',
        worker: 'outreach-send-intent-worker',
        message: 'Background workers are disabled in the engagement-api shadow runtime.',
      });
    }
  }

  assertMeetingPrepWorker(): void {
    if (!this.meetingPrepWorkerEnabled()) {
      this.logger.log(
        `meeting-prep-worker disabled by engagement runtime policy ` +
          `(service=${this.serviceName} owner=${this.backgroundOwner} mode=${this.processMode})`,
      );
      // Same stable denial contract as every other background-owner refusal; the worker name keeps it
      // distinguishable without adding a new error taxonomy for this internal ownership change.
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_BACKGROUND_DISABLED',
        worker: 'meeting-prep-worker',
        message: 'Background workers are disabled in the engagement-api shadow runtime.',
      });
    }
  }

  assertBackgroundOwner(workerName: string): void {
    if (!this.backgroundWorkersEnabled(workerName)) {
      this.logger.log(
        `${workerName} disabled by engagement runtime policy ` +
          `(service=${this.serviceName} owner=${this.backgroundOwner} mode=${this.processMode})`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_BACKGROUND_DISABLED',
        worker: workerName,
        message: 'Background workers are disabled in the engagement-api shadow runtime.',
      });
    }
  }

  /**
   * Check whether an external action is allowed without throwing.
   *
   * `outreach_reasoning` is special in every mode: it can run only in the
   * existing engagement-api process and only when BOTH the Phase 2 canonical
   * state substrate and the Phase 3 reasoning surface are explicitly enabled.
   * A globally-active main API must never gain reasoning authority.
   *
   * Other rules:
   *   integrations_only → explicit Mail integration actions, before V3 exceptions
   *   enabled    → all other registered actions
   *   disabled   → no other action
   *   test_only  → only outreach_test_send with testMode=true
   */
  externalActionAllowed(action: EngagementExternalAction, opts?: { testMode?: boolean }): boolean {
    // Test grants are provisioned separately with a preview-owned encryption key.
    // This mode limits operations; it does not make copied live grants safe to use.
    // Evaluate it first so V3 flags cannot restore send or generation authority.
    if (this.externalActionsMode === 'integrations_only' ||
      this.externalActionsMode === 'integrations_and_notetaker') {
      const notetaker = this.notetakerPostureEnabled();
      if (this.externalActionsMode === 'integrations_and_notetaker' && !notetaker) return false;
      return (
        action === 'integration_oauth_start' ||
        action === 'integration_oauth_callback' ||
        action === 'integration_sync' ||
        action === 'integration_subscription' ||
        action === 'integration_notification' ||
        // These dependencies retain their ordinary owner/access checks. Attachment
        // reads and writes include authorized Engagement attachment operations, not
        // just Recall; the final owner lists and imports incoming message files.
        (notetaker && (action === 'notetaker_dispatch' || action === 'notetaker_remove' ||
          action === 'meeting_debrief_generate' || action === 'attachment_external_read' ||
          action === 'attachment_external_write' ||
          action === 'internal_ai_credential_resolve'))
      );
    }
    if (action === 'outreach_reasoning') {
      return (
        this.serviceName === 'engagement-api' &&
        process.env.OUTREACH_V3_STATE_ENABLED === 'true' &&
        process.env.OUTREACH_V3_REASONING_ENABLED === 'true'
      );
    }
    if (action === 'outreach_v3_generate') {
      return (
        this.serviceName === 'engagement-api' &&
        process.env.OUTREACH_V3_STATE_ENABLED === 'true' &&
        process.env.OUTREACH_V3_GENERATION_ENABLED === 'true' &&
        process.env.OUTREACH_V3_DRAFTS_ENABLED === 'true'
      );
    }
    if (action === 'outreach_v3_send' || action === 'outreach_v3_test_send') {
      return (
        this.serviceName === 'engagement-api' &&
        process.env.OUTREACH_V3_STATE_ENABLED === 'true' &&
        process.env.OUTREACH_V3_DRAFTS_ENABLED === 'true' &&
        process.env.OUTREACH_V3_SEND_ENABLED === 'true' &&
        (action !== 'outreach_v3_test_send' || opts?.testMode === true)
      );
    }
    if (this.externalActionsMode === 'enabled') return true;
    if (this.externalActionsMode === 'disabled') return false;
    if (action === 'outreach_test_send' && opts?.testMode === true) return true;
    return false;
  }

  assertExternalAction(action: EngagementExternalAction, opts?: { testMode?: boolean }): void {
    if (!this.externalActionAllowed(action, opts)) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
        action,
        message: 'This action is disabled in the engagement-api shadow runtime.',
      });
    }
  }

  assertCallbacksEnabled(action: string): void {
    if (!this.callbacksEnabled) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_CALLBACKS_DISABLED',
        action,
        message: 'Callbacks are disabled in the engagement-api shadow runtime.',
      });
    }
  }

  assertRecallWebhookEnabled(action = 'recall_webhook'): void {
    if (!this.recallWebhookEnabled) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENGAGEMENT_RECALL_WEBHOOK_DISABLED',
        action,
        message: 'Recall webhook processing is disabled in this runtime.',
      });
    }
  }

  isRecallWebhookEnabled(): boolean {
    return this.recallWebhookEnabled;
  }
}
