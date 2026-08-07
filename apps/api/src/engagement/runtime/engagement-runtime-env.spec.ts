import { describe, expect, it } from '@jest/globals';
import {
  parseExactBooleanEnvironment,
  resolveEngagementRuntimeEnvironment,
} from './engagement-runtime-env.js';

describe('engagement runtime environment preflight', () => {
  it('preserves current main API defaults when variables are unset', () => {
    expect(resolveEngagementRuntimeEnvironment({})).toEqual({
      serviceName: 'api',
      processMode: 'active',
      backgroundOwner: 'api',
      externalActions: 'enabled',
      callbacksEnabled: true,
      recallWebhookEnabled: true,
    });
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('parses exact boolean %s', (raw: string, expected: boolean) => {
    expect(parseExactBooleanEnvironment('FLAG', raw, !expected)).toBe(expected);
  });

  it.each(['flase', 'disabled', 'truthy', '2', 'null', 'undefined'])(
    'rejects malformed boolean %s',
    (raw) => {
      expect(() => parseExactBooleanEnvironment('FLAG', raw, false)).toThrow(/exact boolean/i);
    },
  );

  it('accepts the exact Phase 1 shadow matrix', () => {
    expect(
      resolveEngagementRuntimeEnvironment({
        CAPIRO_SERVICE_NAME: 'engagement-api',
        ENGAGEMENT_PROCESS_MODE: 'shadow',
        ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
        ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
        ENGAGEMENT_CALLBACKS_ENABLED: 'false',
        ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
      }),
    ).toEqual({
      serviceName: 'engagement-api',
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'disabled',
      callbacksEnabled: false,
      recallWebhookEnabled: false,
    });
  });

  it.each([
    ['ENGAGEMENT_PROCESS_MODE', 'active'],
    ['ENGAGEMENT_BACKGROUND_OWNER', 'engagement-api'],
    ['ENGAGEMENT_EXTERNAL_ACTIONS', 'enabled'],
    ['ENGAGEMENT_CALLBACKS_ENABLED', 'true'],
    ['ENGAGEMENT_RECALL_WEBHOOK_ENABLED', 'true'],
  ])('rejects armed shadow field %s', (field: string, value: string) => {
    const env: Record<string, string> = {
      CAPIRO_SERVICE_NAME: 'engagement-api',
      ENGAGEMENT_PROCESS_MODE: 'shadow',
      ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
      ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
      ENGAGEMENT_CALLBACKS_ENABLED: 'false',
      ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
    };
    env[field] = value;
    expect(() => resolveEngagementRuntimeEnvironment(env)).toThrow(/shadow posture/i);
  });
});
