import { describe, it, expect } from '@jest/globals';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import type {
  EngagementExternalAction,
  EngagementExternalActionMode,
} from './engagement-runtime.types.js';

function makePolicy(config: {
  serviceName: 'api' | 'engagement-api';
  processMode: 'shadow' | 'active';
  backgroundOwner: 'api' | 'engagement-api' | 'disabled';
  externalActions: EngagementExternalActionMode;
  callbacksEnabled: boolean;
  recallWebhookEnabled: boolean;
}) {
  return new EngagementRuntimePolicyService(config);
}

const ALL_ACTIONS: EngagementExternalAction[] = [
  'outreach_generate',
  'outreach_send',
  'outreach_test_send',
  'meeting_prep_generate',
  'meeting_debrief_generate',
  'integration_oauth_start',
  'integration_oauth_callback',
  'integration_disconnect',
  'integration_sync',
  'integration_subscription',
  'integration_notification',
  'notetaker_dispatch',
  'notetaker_remove',
  'attachment_external_read',
  'attachment_external_write',
];

describe('EngagementRuntimePolicyService', () => {
  describe('snapshot', () => {
    it('returns a sanitized posture with no secrets', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      const snap = policy.snapshot();
      expect(snap.serviceName).toBe('engagement-api');
      expect(snap.processMode).toBe('shadow');
      expect(snap.backgroundOwner).toBe('disabled');
      expect(snap.externalActions).toBe('disabled');
      expect(snap.callbacksEnabled).toBe(false);
      expect(snap.recallWebhookEnabled).toBe(false);
      expect(JSON.stringify(snap)).not.toMatch(/password|secret|token|apiKey|credential/i);
    });
  });

  describe('backgroundWorkersEnabled', () => {
    it('returns true when owner === serviceName', () => {
      const policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
      expect(policy.backgroundWorkersEnabled()).toBe(true);
    });

    it('returns false when owner is disabled', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      expect(policy.backgroundWorkersEnabled()).toBe(false);
    });

    it('returns false when owner !== serviceName', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'api',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      expect(policy.backgroundWorkersEnabled()).toBe(false);
    });
  });

  describe('assertBackgroundOwner', () => {
    it('throws 503 when background is disabled', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      expect(() => policy.assertBackgroundOwner('test-worker')).toThrow();
    });

    it('does not throw when background is enabled', () => {
      const policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
      expect(() => policy.assertBackgroundOwner('test-worker')).not.toThrow();
    });
  });

  describe('externalActionAllowed — enabled mode', () => {
    const policy = makePolicy({
      serviceName: 'api',
      processMode: 'active',
      backgroundOwner: 'api',
      externalActions: 'enabled',
      callbacksEnabled: true,
      recallWebhookEnabled: true,
    });
    it.each(ALL_ACTIONS)('allows action %s in enabled mode', (action) => {
      expect(policy.externalActionAllowed(action)).toBe(true);
    });
  });

  describe('externalActionAllowed — disabled mode (shadow)', () => {
    const policy = makePolicy({
      serviceName: 'engagement-api',
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'disabled',
      callbacksEnabled: false,
      recallWebhookEnabled: false,
    });
    it.each(ALL_ACTIONS)('denies action %s in disabled mode', (action) => {
      expect(policy.externalActionAllowed(action)).toBe(false);
    });
  });

  describe('externalActionAllowed — test_only mode', () => {
    const policy = makePolicy({
      serviceName: 'engagement-api',
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'test_only',
      callbacksEnabled: false,
      recallWebhookEnabled: false,
    });
    it('allows outreach_test_send with testMode=true', () => {
      expect(policy.externalActionAllowed('outreach_test_send', { testMode: true })).toBe(true);
    });
    it('denies outreach_test_send without testMode', () => {
      expect(policy.externalActionAllowed('outreach_test_send')).toBe(false);
    });
    it.each(ALL_ACTIONS.filter((action) => action !== 'outreach_test_send'))(
      'denies ordinary action %s in test_only mode',
      (action) => {
        expect(policy.externalActionAllowed(action)).toBe(false);
      },
    );
    it('denies outreach_send in test_only mode', () => {
      expect(policy.externalActionAllowed('outreach_send', { testMode: true })).toBe(false);
    });
    it('denies outreach_generate in test_only mode', () => {
      expect(policy.externalActionAllowed('outreach_generate', { testMode: true })).toBe(false);
    });
  });

  describe.each(['api', 'engagement-api'] as const)('integrations_only in %s', (serviceName) => {
    const policy = makePolicy({
      serviceName,
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'integrations_only',
      callbacksEnabled: true,
      recallWebhookEnabled: false,
    });
    it.each([
      'integration_oauth_start',
      'integration_oauth_callback',
      'integration_sync',
      'integration_subscription',
      'integration_notification',
    ] as const)('allows %s', (action) => {
      expect(policy.externalActionAllowed(action)).toBe(true);
      expect(() => policy.assertExternalAction(action)).not.toThrow();
    });
    it('keeps named background work disabled for the disabled owner', () => {
      expect(policy.backgroundWorkersEnabled()).toBe(false);
      expect(policy.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(false);
      expect(() => policy.assertBackgroundOwner('engagement-sync-scheduler')).toThrow();
    });
    it.each([
      'outreach_send',
      'outreach_test_send',
      'outreach_v3_send',
      'outreach_v3_test_send',
      'outreach_generate',
      'outreach_reasoning',
      'outreach_v3_generate',
      'meeting_prep_generate',
      'meeting_debrief_generate',
      'integration_disconnect',
      'notetaker_dispatch',
      'notetaker_remove',
      'attachment_external_read',
      'attachment_external_write',
      'internal_ai_credential_resolve',
    ] as const)('denies %s even with testMode', (action) => {
      expect(policy.externalActionAllowed(action, { testMode: true })).toBe(false);
      expect(() => policy.assertExternalAction(action, { testMode: true })).toThrow();
    });
  });

  describe('integrations_only named worker exception', () => {
    const policy = makePolicy({
      serviceName: 'api',
      processMode: 'shadow',
      backgroundOwner: 'api',
      externalActions: 'integrations_only',
      callbacksEnabled: true,
      recallWebhookEnabled: false,
    });

    it('admits only the exact engagement-sync-scheduler name on the API owner', () => {
      expect(policy.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(true);
      expect(() => policy.assertBackgroundOwner('engagement-sync-scheduler')).not.toThrow();
    });

    it('keeps the generic no-argument predicate false', () => {
      expect(policy.backgroundWorkersEnabled()).toBe(false);
      expect(() => policy.assertBackgroundOwner('')).toThrow();
    });

    it.each([
      'engagement-outreach-scheduler',
      'engagement-sync-scheduler-v2',
      'outreach-v3-full-generation',
      'outreach-v3-send-intent',
      'engagement-notetaker-reconcile',
      'meeting-prep-worker',
      'krisp-notetaker-worker',
      'mailbox-indexing-worker',
    ])('denies the other worker name %s', (workerName) => {
      expect(policy.backgroundWorkersEnabled(workerName)).toBe(false);
      expect(() => policy.assertBackgroundOwner(workerName)).toThrow();
    });

    it('keeps the V3 send worker denied in this posture', () => {
      expect(policy.outreachV3SendIntentWorkerEnabled()).toBe(false);
    });

    it('keeps sends denied while sync and subscription renewal remain allowed', () => {
      expect(policy.externalActionAllowed('integration_sync')).toBe(true);
      expect(policy.externalActionAllowed('integration_subscription')).toBe(true);
      expect(policy.externalActionAllowed('outreach_send')).toBe(false);
      expect(policy.externalActionAllowed('outreach_test_send', { testMode: true })).toBe(false);
      expect(policy.externalActionAllowed('outreach_v3_send', { testMode: true })).toBe(false);
      expect(policy.externalActionAllowed('outreach_v3_test_send', { testMode: true })).toBe(false);
    });
  });

  describe('assertExternalAction', () => {
    it('throws 503 for denied action', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      expect(() => policy.assertExternalAction('outreach_send')).toThrow();
    });
    it('does not throw for allowed action', () => {
      const policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
      expect(() => policy.assertExternalAction('outreach_send')).not.toThrow();
    });
    it('does not throw for test_send in test_only mode', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'test_only',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      expect(() =>
        policy.assertExternalAction('outreach_test_send', { testMode: true }),
      ).not.toThrow();
    });
  });

  describe('assertCallbacksEnabled', () => {
    it('throws when callbacks are disabled', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      expect(() => policy.assertCallbacksEnabled('integration_oauth_callback')).toThrow();
    });
    it('does not throw when callbacks are enabled', () => {
      const policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
      expect(() => policy.assertCallbacksEnabled('integration_oauth_callback')).not.toThrow();
    });
  });

  describe('Recall webhook ownership', () => {
    it('throws the Recall-specific code when callbacks are on but Recall is disabled', () => {
      const policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: false,
      });
      try {
        policy.assertRecallWebhookEnabled();
        throw new Error('expected Recall ownership denial');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as { getResponse?: () => unknown }).getResponse?.()).toMatchObject({
          code: 'ENGAGEMENT_RECALL_WEBHOOK_DISABLED',
        });
      }
      expect(policy.isRecallWebhookEnabled()).toBe(false);
    });

    it('allows Recall processing only when its own flag is enabled', () => {
      const policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
      expect(() => policy.assertRecallWebhookEnabled()).not.toThrow();
      expect(policy.isRecallWebhookEnabled()).toBe(true);
    });
  });
});
