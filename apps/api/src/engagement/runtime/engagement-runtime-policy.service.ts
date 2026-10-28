import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  CapiroServiceName,
  EngagementBackgroundOwner,
  EngagementExternalAction,
  EngagementExternalActionMode,
  EngagementProcessMode,
  EngagementRuntimeSnapshot,
} from './engagement-runtime.types.js';

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

  constructor(config: {
    serviceName: CapiroServiceName;
    processMode: EngagementProcessMode;
    backgroundOwner: EngagementBackgroundOwner;
    externalActions: EngagementExternalActionMode;
    callbacksEnabled: boolean;
    recallWebhookEnabled: boolean;
  }) {
    this.serviceName = config.serviceName;
    this.processMode = config.processMode;
    this.backgroundOwner = config.backgroundOwner;
    this.externalActionsMode = config.externalActions;
    this.callbacksEnabled = config.callbacksEnabled;
    this.recallWebhookEnabled = config.recallWebhookEnabled;
  }

  snapshot(): EngagementRuntimeSnapshot {
    return {
      serviceName: this.serviceName,
      processMode: this.processMode,
      backgroundOwner: this.backgroundOwner,
      externalActions: this.externalActionsMode,
      callbacksEnabled: this.callbacksEnabled,
      recallWebhookEnabled: this.recallWebhookEnabled,
    };
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
   */
  backgroundWorkersEnabled(workerName?: string): boolean {
    if (this.backgroundOwner === 'disabled') return false;
    if (this.backgroundOwner !== this.serviceName) return false;
    if (this.externalActionsMode === 'integrations_and_notetaker') {
      return this.notetakerPostureEnabled() &&
        ['engagement-sync-scheduler', 'notetaker-reconcile', 'client-notetaker'].includes(workerName ?? '');
    }
    if (this.externalActionsMode === 'integrations_only') {
      return this.serviceName === 'api' && workerName === 'engagement-sync-scheduler';
    }
    return true;
  }

  /**
   * Dedicated exception for Outreach V3 full generation. It does not change
   * global background ownership and cannot start any other Engagement worker.
   */
  outreachV3FullGenerationWorkerEnabled(): boolean {
    return (
      this.externalActionsMode !== 'integrations_only' &&
      this.externalActionsMode !== 'integrations_and_notetaker' &&
      this.serviceName === 'engagement-api' &&
      process.env.OUTREACH_V3_STATE_ENABLED === 'true' &&
      process.env.OUTREACH_V3_GENERATION_ENABLED === 'true' &&
      process.env.OUTREACH_V3_DRAFTS_ENABLED === 'true' &&
      process.env.OUTREACH_V3_FULL_GENERATION_ENABLED === 'true'
    );
  }

  assertOutreachV3FullGenerationWorker(): void {
    if (!this.outreachV3FullGenerationWorkerEnabled()) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'OUTREACH_V3_FULL_GENERATION_WORKER_DISABLED',
        message: 'The Outreach V3 full-generation worker is disabled.',
      });
    }
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
        // writes include authorized Engagement attachment operations, not just Recall.
        (notetaker && (action === 'notetaker_dispatch' || action === 'notetaker_remove' ||
          action === 'meeting_debrief_generate' || action === 'attachment_external_write' ||
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
