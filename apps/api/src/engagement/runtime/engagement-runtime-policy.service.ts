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

  backgroundWorkersEnabled(): boolean {
    if (this.backgroundOwner === 'disabled') return false;
    return this.backgroundOwner === this.serviceName;
  }

  assertBackgroundOwner(workerName: string): void {
    if (!this.backgroundWorkersEnabled()) {
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
   * existing engagement-api process and only when its own strict feature gate
   * is true. A globally-active main API must never gain reasoning authority.
   *
   * Other rules:
   *   enabled    → all other registered actions
   *   disabled   → no other action
   *   test_only  → only outreach_test_send with testMode=true
   */
  externalActionAllowed(
    action: EngagementExternalAction,
    opts?: { testMode?: boolean },
  ): boolean {
    if (action === 'outreach_reasoning') {
      return (
        this.serviceName === 'engagement-api' &&
        process.env.OUTREACH_V3_REASONING_ENABLED === 'true'
      );
    }
    if (this.externalActionsMode === 'enabled') return true;
    if (this.externalActionsMode === 'disabled') return false;
    if (action === 'outreach_test_send' && opts?.testMode === true) return true;
    return false;
  }

  assertExternalAction(
    action: EngagementExternalAction,
    opts?: { testMode?: boolean },
  ): void {
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
