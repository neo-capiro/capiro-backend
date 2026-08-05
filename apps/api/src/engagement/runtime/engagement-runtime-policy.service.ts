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
 *   - no external actions execute;
 *   - no OAuth callbacks or notifications are processed;
 *   - no Recall webhooks are handled.
 *
 * In active mode (main API) the policy permits current behavior.
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

  /**
   * Return a sanitized snapshot of the current runtime posture.
   * Must never include secrets, tokens, or tenant data.
   */
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

  /**
   * Background workers (timers, schedulers) are enabled only when
   * ENGAGEMENT_BACKGROUND_OWNER === CAPIRO_SERVICE_NAME.
   * `disabled` never runs workers.
   */
  backgroundWorkersEnabled(): boolean {
    if (this.backgroundOwner === 'disabled') return false;
    return this.backgroundOwner === this.serviceName;
  }

  /**
   * Assert that background workers are enabled for this service.
   * Throws a sanitized 503 when the worker is not allowed.
   */
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
   * Rules:
   *   enabled    → all registered actions
   *   disabled   → none
   *   test_only  → only outreach_test_send with testMode=true
   */
  externalActionAllowed(
    action: EngagementExternalAction,
    opts?: { testMode?: boolean },
  ): boolean {
    if (this.externalActionsMode === 'enabled') return true;
    if (this.externalActionsMode === 'disabled') return false;
    // test_only
    if (action === 'outreach_test_send' && opts?.testMode === true) return true;
    return false;
  }

  /**
   * Assert that an external action is allowed. Throws a sanitized 503
   * with a stable error shape before any adapter or provider is called.
   */
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

  /**
   * Assert that OAuth callbacks / Microsoft notifications are enabled.
   */
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

  /**
   * Whether Recall webhook processing is enabled.
   */
  isRecallWebhookEnabled(): boolean {
    return this.recallWebhookEnabled;
  }
}
