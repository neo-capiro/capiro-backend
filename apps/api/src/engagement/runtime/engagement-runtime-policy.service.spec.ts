import { describe, it, expect } from '@jest/globals';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import type { EngagementExternalAction } from './engagement-runtime.types.js';

// Table-driven test for the full policy matrix.
function makePolicy(config: {
  serviceName: 'api' | 'engagement-api';
  processMode: 'shadow' | 'active';
  backgroundOwner: 'api' | 'engagement-api' | 'disabled';
  externalActions: 'disabled' | 'test_only' | 'enabled';
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
      // No secrets in the snapshot
      const json = JSON.stringify(snap);
      expect(json).not.toMatch(/password|secret|token|apiKey|credential/i);
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

    it.each(
      ALL_ACTIONS.filter((a) => a !== 'outreach_test_send'),
    )('denies ordinary action %s in test_only mode', (action) => {
      expect(policy.externalActionAllowed(action)).toBe(false);
    });

    it('denies outreach_send in test_only mode', () => {
      expect(policy.externalActionAllowed('outreach_send', { testMode: true })).toBe(false);
    });

    it('denies outreach_generate in test_only mode', () => {
      expect(policy.externalActionAllowed('outreach_generate', { testMode: true })).toBe(false);
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

  describe('isRecallWebhookEnabled', () => {
    it('returns false when disabled', () => {
      const policy = makePolicy({
        serviceName: 'engagement-api',
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      expect(policy.isRecallWebhookEnabled()).toBe(false);
    });

    it('returns true when enabled', () => {
      const policy = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
      expect(policy.isRecallWebhookEnabled()).toBe(true);
    });
  });
});
