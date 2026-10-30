import { describe, it, expect } from '@jest/globals';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';
import { guardEngagementServiceRuntime } from '../governed-engagement.factory.js';
import { MeetingCapturePersistenceService } from '../../meeting-capture/meeting-capture-persistence.service.js';
import { AiCredentialResolverService } from '../../ai-credentials/ai-credential-resolver.service.js';
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
  backgroundWorkerRestriction?: 'integration_sync_scheduler';
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

describe('integrations_and_notetaker bounded API owner', () => {
  beforeEach(() => jest.replaceProperty(process, 'env', {
    ...process.env, OUTREACH_V3_STATE_ENABLED: 'true', OUTREACH_V3_DRAFTS_ENABLED: 'true',
    OUTREACH_V3_SEND_ENABLED: 'true', OUTREACH_V3_GENERATION_ENABLED: 'true',
    OUTREACH_V3_FULL_GENERATION_ENABLED: 'true', OUTREACH_V3_REASONING_ENABLED: 'true',
  }));
  afterEach(() => jest.restoreAllMocks());
  const posture = {
    serviceName: 'api', processMode: 'shadow', backgroundOwner: 'api',
    externalActions: 'integrations_and_notetaker', callbacksEnabled: true,
    recallWebhookEnabled: true,
  } as const;
  const policy = makePolicy(posture);
  it('permits integration, capture/debrief and final-owner attachment boundaries only', () => {
    const allowed: EngagementExternalAction[] = ['integration_oauth_start', 'integration_oauth_callback',
      'integration_sync', 'integration_subscription', 'integration_notification',
      'notetaker_dispatch', 'notetaker_remove', 'meeting_debrief_generate',
      'attachment_external_read', 'attachment_external_write', 'internal_ai_credential_resolve'];
    for (const action of allowed) expect(() => policy.assertExternalAction(action)).not.toThrow();
    for (const action of [...ALL_ACTIONS.filter((a) => !allowed.includes(a)),
      'outreach_reasoning', 'outreach_v3_generate', 'outreach_v3_send', 'outreach_v3_test_send'] as EngagementExternalAction[]) {
      expect(policy.externalActionAllowed(action, { testMode: true })).toBe(false);
    }
    expect(() => policy.assertCallbacksEnabled('recall')).not.toThrow();
    expect(() => policy.assertRecallWebhookEnabled('recall')).not.toThrow();
  });
  it('admits both actual notetaker guard names and the existing sync scheduler', () => {
    for (const name of ['notetaker-reconcile', 'client-notetaker', 'engagement-sync-scheduler']) {
      expect(policy.backgroundWorkersEnabled(name)).toBe(true);
      expect(() => policy.assertBackgroundOwner(name)).not.toThrow();
    }
    for (const name of [undefined, '', 'engagement-notetaker-reconcile', 'krisp-notetaker-worker',
      'outreach-v3-full-generation', 'outreach-v3-send-intent', 'mailbox-indexing-worker']) {
      expect(policy.backgroundWorkersEnabled(name)).toBe(false);
    }
    expect(policy.outreachV3SendIntentWorkerEnabled()).toBe(false);
  });
  it('refuses capture actions and named workers on an incomplete policy', () => {
    for (const change of [{ serviceName: 'engagement-api' }, { backgroundOwner: 'disabled' },
      { processMode: 'active' }, { callbacksEnabled: false }, { recallWebhookEnabled: false }] as const) {
      const incomplete = makePolicy({ ...posture, ...change });
      expect(incomplete.externalActionAllowed('notetaker_dispatch')).toBe(false);
      expect(incomplete.externalActionAllowed('attachment_external_read')).toBe(false);
      expect(incomplete.backgroundWorkersEnabled('notetaker-reconcile')).toBe(false);
    }
  });
  it.each(['integrations_and_notetaker', 'integrations_only'] as const)(
    'capture persistence and credential guards honor %s without bypassing their owners', async (mode) => {
      const currentPolicy = makePolicy({ ...posture, externalActions: mode, recallWebhookEnabled: mode !== 'integrations_only' });
      const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-user' } as never;
      const attachment = { buffer: Buffer.from('synthetic transcript'), source: 'notetaker' } as never;
      const createAttachmentFromBuffer = jest.fn().mockResolvedValue({ id: 'synthetic-attachment' });
      const eraseAttachmentAsSystem = jest.fn().mockResolvedValue({ ok: true });
      const capture = new MeetingCapturePersistenceService(guardEngagementServiceRuntime({
        createAttachmentFromBuffer, eraseAttachmentAsSystem,
      } as never, currentPolicy));
      const values: Record<string, string> = {
        OPENAI_API_KEY: 'synthetic-key', OPENAI_MODEL: 'gpt-4.1-mini', ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      };
      const prisma = { withTenant: jest.fn() };
      const credentials = new AiCredentialResolverService({ get: (key: string) => values[key] } as never, prisma as never, currentPolicy);
      if (mode === 'integrations_only') {
        expect(() => capture.createAttachmentFromBuffer(ctx, attachment)).toThrow();
        expect(() => capture.eraseAttachmentAsSystem('synthetic-tenant', 'synthetic-attachment')).toThrow();
        await expect(credentials.resolveOrder(ctx)).rejects.toThrow();
        expect(createAttachmentFromBuffer).not.toHaveBeenCalled();
        expect(eraseAttachmentAsSystem).not.toHaveBeenCalled();
      } else {
        await capture.createAttachmentFromBuffer(ctx, attachment);
        await capture.eraseAttachmentAsSystem('synthetic-tenant', 'synthetic-attachment');
        expect(createAttachmentFromBuffer).toHaveBeenCalledWith(ctx, attachment);
        expect(eraseAttachmentAsSystem).toHaveBeenCalledWith('synthetic-tenant', 'synthetic-attachment');
        await expect(credentials.resolveOrder(ctx)).resolves.toMatchObject([{ provider: 'openai', usedTenantKey: false }]);
        createAttachmentFromBuffer.mockRejectedValueOnce(new Error('current access refused'));
        await expect(capture.createAttachmentFromBuffer(ctx, attachment)).rejects.toThrow('current access refused');
      }
      expect(prisma.withTenant).not.toHaveBeenCalled();
    },
  );
});

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

  describe('opt-in background worker restriction', () => {
    const posture = {
      serviceName: 'api',
      processMode: 'active',
      backgroundOwner: 'api',
      externalActions: 'enabled',
      callbacksEnabled: true,
      recallWebhookEnabled: false,
      backgroundWorkerRestriction: 'integration_sync_scheduler',
    } as const;
    const policy = makePolicy(posture);

    it('admits only the exact integration sync scheduler name', () => {
      expect(policy.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(true);
      expect(() => policy.assertBackgroundOwner('engagement-sync-scheduler')).not.toThrow();
    });

    it.each([
      undefined,
      '',
      '  ',
      'engagement-sync-scheduler-v2',
      'engagement-outreach-scheduler',
      'engagement-notetaker-reconcile',
      'notetaker-reconcile',
      'client-notetaker',
      'mailbox-indexing-worker',
      'attachment-indexing-worker',
      'krisp-notetaker-worker',
      'meeting-prep-worker',
      'outreach-v3-full-generation',
      'outreach-v3-send-intent',
    ])('denies the non-exact worker name %p instead of falling through to generic ownership', (workerName) => {
      expect(policy.backgroundWorkersEnabled(workerName)).toBe(false);
      expect(() => policy.assertBackgroundOwner(workerName ?? '')).toThrow();
    });

    it('keeps every external-action decision identical to the unrestricted api/active/enabled baseline', () => {
      const baseline = makePolicy({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: false,
      });
      const actions = [...ALL_ACTIONS, 'outreach_reasoning', 'outreach_v3_generate',
        'outreach_v3_send', 'outreach_v3_test_send'] as EngagementExternalAction[];
      for (const action of actions) {
        expect(policy.externalActionAllowed(action)).toBe(baseline.externalActionAllowed(action));
        expect(policy.externalActionAllowed(action, { testMode: true }))
          .toBe(baseline.externalActionAllowed(action, { testMode: true }));
      }
      // The enabled API baseline itself is unchanged by this story: manual
      // disconnect, sync, subscription and the attachment boundaries stay admitted.
      for (const action of [
        'integration_disconnect',
        'integration_sync',
        'integration_subscription',
        'attachment_external_read',
        'attachment_external_write',
      ] as EngagementExternalAction[]) {
        expect(policy.externalActionAllowed(action)).toBe(true);
      }
      // Existing V3 denials stay denied for the api service name.
      for (const action of ['outreach_v3_generate', 'outreach_v3_send', 'outreach_reasoning',
        'outreach_v3_test_send'] as EngagementExternalAction[]) {
        expect(policy.externalActionAllowed(action)).toBe(false);
      }
    });

    it('keeps callbacks admitted and Recall denied in the intended tuple', () => {
      expect(() => policy.assertCallbacksEnabled('integration_oauth_callback')).not.toThrow();
      expect(policy.isRecallWebhookEnabled()).toBe(false);
      expect(() => policy.assertRecallWebhookEnabled()).toThrow(/Recall/);
    });

    it('still refuses every worker when the owner is disabled', () => {
      const disabledOwner = makePolicy({ ...posture, backgroundOwner: 'disabled' });
      expect(disabledOwner.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(false);
      expect(() => disabledOwner.assertBackgroundOwner('engagement-sync-scheduler')).toThrow();
    });

    it('still refuses a mismatched owner before the restriction applies', () => {
      const mismatched = makePolicy({ ...posture, serviceName: 'engagement-api' });
      expect(mismatched.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(false);
      expect(() => mismatched.assertBackgroundOwner('engagement-sync-scheduler')).toThrow();
    });

    it('reports the restriction in the sanitized snapshot', () => {
      expect(policy.snapshot().backgroundWorkerRestriction).toBe('integration_sync_scheduler');
      expect(JSON.stringify(policy.snapshot())).not.toMatch(
        /password|secret|token|apiKey|credential/i,
      );
    });
  });
});
