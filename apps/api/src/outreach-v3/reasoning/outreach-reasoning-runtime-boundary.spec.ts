import { EngagementRuntimePolicyService } from '../../engagement/runtime/engagement-runtime-policy.service.js';

function shadowPolicy() {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

describe('Outreach V3 reasoning runtime boundary', () => {
  const originalReasoning = process.env.OUTREACH_V3_REASONING_ENABLED;
  const originalState = process.env.OUTREACH_V3_STATE_ENABLED;

  afterEach(() => {
    if (originalReasoning === undefined) delete process.env.OUTREACH_V3_REASONING_ENABLED;
    else process.env.OUTREACH_V3_REASONING_ENABLED = originalReasoning;
    if (originalState === undefined) delete process.env.OUTREACH_V3_STATE_ENABLED;
    else process.env.OUTREACH_V3_STATE_ENABLED = originalState;
  });

  it('keeps reasoning denied in engagement-api shadow by default', () => {
    delete process.env.OUTREACH_V3_STATE_ENABLED;
    delete process.env.OUTREACH_V3_REASONING_ENABLED;
    const policy = shadowPolicy();
    expect(policy.externalActionAllowed('outreach_reasoning')).toBe(false);
    expect(() => policy.assertExternalAction('outreach_reasoning')).toThrow();
  });

  it('does not allow reasoning when state is dark even if the reasoning flag is true', () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'false';
    process.env.OUTREACH_V3_REASONING_ENABLED = 'true';
    const policy = shadowPolicy();
    expect(policy.externalActionAllowed('outreach_reasoning')).toBe(false);
  });

  it('allows only the reasoning action when both Phase 2 state and Phase 3 reasoning gates are true', () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    process.env.OUTREACH_V3_REASONING_ENABLED = 'true';
    const policy = shadowPolicy();
    expect(policy.externalActionAllowed('outreach_reasoning')).toBe(true);
    expect(() => policy.assertExternalAction('outreach_reasoning')).not.toThrow();

    for (const action of [
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
      'internal_ai_credential_resolve',
    ] as const) {
      expect(policy.externalActionAllowed(action)).toBe(false);
    }

    expect(policy.backgroundWorkersEnabled()).toBe(false);
    expect(policy.isRecallWebhookEnabled()).toBe(false);
    expect(() => policy.assertCallbacksEnabled('oauth')).toThrow();
  });

  it.each([
    { processMode: 'shadow' as const, externalActions: 'disabled' as const },
    { processMode: 'active' as const, externalActions: 'enabled' as const },
  ])(
    'does not grant reasoning authority to the main API in $processMode mode',
    ({ processMode, externalActions }) => {
      process.env.OUTREACH_V3_STATE_ENABLED = 'true';
      process.env.OUTREACH_V3_REASONING_ENABLED = 'true';
      const policy = new EngagementRuntimePolicyService({
        serviceName: 'api',
        processMode,
        backgroundOwner: processMode === 'active' ? 'api' : 'disabled',
        externalActions,
        callbacksEnabled: processMode === 'active',
        recallWebhookEnabled: processMode === 'active',
      });
      expect(policy.externalActionAllowed('outreach_reasoning')).toBe(false);
      expect(() => policy.assertExternalAction('outreach_reasoning')).toThrow();
    },
  );
});
