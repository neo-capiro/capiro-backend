import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

const KEYS = [
  'OUTREACH_V3_STATE_ENABLED',
  'OUTREACH_V3_REASONING_ENABLED',
  'OUTREACH_V3_GENERATION_ENABLED',
  'OUTREACH_V3_DRAFTS_ENABLED',
  'OUTREACH_V3_SEND_ENABLED',
  'OUTREACH_V3_FULL_GENERATION_ENABLED',
] as const;

const prior = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    prior.set(key, process.env[key]);
    process.env[key] = 'true';
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = prior.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  prior.clear();
});

function policy(serviceName: 'api' | 'engagement-api') {
  return new EngagementRuntimePolicyService({
    serviceName,
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

describe('bounded Outreach V3 runtime authority', () => {
  it('allows only the dedicated V3 action classes in engagement-api', () => {
    const runtime = policy('engagement-api');

    expect(runtime.externalActionAllowed('outreach_v3_generate')).toBe(true);
    expect(runtime.externalActionAllowed('outreach_v3_test_send', { testMode: true })).toBe(true);
    expect(runtime.externalActionAllowed('outreach_v3_send')).toBe(true);

    expect(runtime.externalActionAllowed('outreach_generate')).toBe(false);
    expect(runtime.externalActionAllowed('outreach_send')).toBe(false);
    expect(runtime.externalActionAllowed('meeting_prep_generate')).toBe(false);
  });

  it('keeps V3 authority out of the main API process', () => {
    const runtime = policy('api');
    expect(runtime.externalActionAllowed('outreach_v3_generate')).toBe(false);
    expect(runtime.externalActionAllowed('outreach_v3_send')).toBe(false);
    expect(runtime.outreachV3FullGenerationWorkerEnabled()).toBe(false);
    expect(runtime.outreachV3SendIntentWorkerEnabled()).toBe(false);
  });

  it('permits only the dedicated full-generation worker while global background ownership stays disabled', () => {
    const runtime = policy('engagement-api');
    expect(runtime.backgroundWorkersEnabled()).toBe(false);
    expect(runtime.outreachV3FullGenerationWorkerEnabled()).toBe(true);
    expect(runtime.outreachV3SendIntentWorkerEnabled()).toBe(true);
    expect(() => runtime.assertOutreachV3FullGenerationWorker()).not.toThrow();
    expect(() => runtime.assertOutreachV3SendIntentWorker()).not.toThrow();
  });

  it('fails closed when any required capability flag is removed', () => {
    delete process.env.OUTREACH_V3_DRAFTS_ENABLED;
    const runtime = policy('engagement-api');
    expect(runtime.externalActionAllowed('outreach_v3_generate')).toBe(false);
    expect(runtime.externalActionAllowed('outreach_v3_send')).toBe(false);
    expect(runtime.outreachV3FullGenerationWorkerEnabled()).toBe(false);
    expect(runtime.outreachV3SendIntentWorkerEnabled()).toBe(false);
  });
});
