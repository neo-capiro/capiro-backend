import { describe, expect, it } from '@jest/globals';
import {
  ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT,
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

  describe('integrations-only posture', () => {
    const env = {
      ENGAGEMENT_PROCESS_MODE: 'shadow',
      ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
      ENGAGEMENT_EXTERNAL_ACTIONS: 'integrations_only',
      ENGAGEMENT_CALLBACKS_ENABLED: 'false',
      ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
    };

    it.each(['api', 'engagement-api'])('accepts bounded operations in %s', (serviceName) => {
      for (const callbacks of ['false', 'true']) {
        expect(
          resolveEngagementRuntimeEnvironment({
            ...env,
            CAPIRO_SERVICE_NAME: serviceName,
            ENGAGEMENT_CALLBACKS_ENABLED: callbacks,
          }),
        ).toMatchObject({
          serviceName,
          processMode: 'shadow',
          backgroundOwner: 'disabled',
          externalActions: 'integrations_only',
          callbacksEnabled: callbacks === 'true',
          recallWebhookEnabled: false,
        });
      }
    });

    it.each([
      ['ENGAGEMENT_PROCESS_MODE', 'active'],
      ['ENGAGEMENT_BACKGROUND_OWNER', 'engagement-api'],
      ['ENGAGEMENT_RECALL_WEBHOOK_ENABLED', 'true'],
    ])('rejects an armed %s=%s in either bootstrap', (field, value) => {
      for (const serviceName of ['api', 'engagement-api']) {
        expect(() =>
          resolveEngagementRuntimeEnvironment({
            ...env,
            CAPIRO_SERVICE_NAME: serviceName,
            [field]: value,
          }),
        ).toThrow(/integrations_only requires/);
      }
    });

    it.each(['false', 'true'] as const)(
      'accepts the explicit API background owner with callbacks=%s',
      (callbacks) => {
        expect(
          resolveEngagementRuntimeEnvironment({
            ...env,
            CAPIRO_SERVICE_NAME: 'api',
            ENGAGEMENT_BACKGROUND_OWNER: 'api',
            ENGAGEMENT_CALLBACKS_ENABLED: callbacks,
          }),
        ).toMatchObject({
          serviceName: 'api',
          processMode: 'shadow',
          backgroundOwner: 'api',
          externalActions: 'integrations_only',
          callbacksEnabled: callbacks === 'true',
          recallWebhookEnabled: false,
        });
      },
    );

    it('rejects the API background owner on the engagement-api service', () => {
      expect(() =>
        resolveEngagementRuntimeEnvironment({
          ...env,
          CAPIRO_SERVICE_NAME: 'engagement-api',
          ENGAGEMENT_BACKGROUND_OWNER: 'api',
        }),
      ).toThrow(/integrations_only requires/);
    });

    it.each([undefined, '', '  '])(
      'rejects an omitted or blank API background owner (%s) instead of inheriting the live default',
      (owner) => {
        expect(() =>
          resolveEngagementRuntimeEnvironment({
            ...env,
            CAPIRO_SERVICE_NAME: 'api',
            ENGAGEMENT_BACKGROUND_OWNER: owner,
          }),
        ).toThrow(/integrations_only requires/);
      },
    );

    it.each([
      ['ENGAGEMENT_PROCESS_MODE', 'active'],
      ['ENGAGEMENT_RECALL_WEBHOOK_ENABLED', 'true'],
    ])('rejects %s=%s on the explicit API owner posture', (field, value) => {
      expect(() =>
        resolveEngagementRuntimeEnvironment({
          ...env,
          CAPIRO_SERVICE_NAME: 'api',
          ENGAGEMENT_BACKGROUND_OWNER: 'api',
          [field]: value,
        }),
      ).toThrow(/integrations_only requires/);
    });

    it('does not accept a bare mode flip with active defaults', () => {
      expect(() =>
        resolveEngagementRuntimeEnvironment({
          ENGAGEMENT_EXTERNAL_ACTIONS: 'integrations_only',
        }),
      ).toThrow(/integrations_only requires/);
    });

    it.each([undefined, '', '  '])('rejects an omitted or blank callback choice (%s)', (value) => {
      for (const serviceName of ['api', 'engagement-api']) {
        expect(() =>
          resolveEngagementRuntimeEnvironment({
            ...env,
            CAPIRO_SERVICE_NAME: serviceName,
            ENGAGEMENT_CALLBACKS_ENABLED: value,
          }),
        ).toThrow(/requires an explicit ENGAGEMENT_CALLBACKS_ENABLED/);
      }
    });
  });

  it.each([
    ['ENGAGEMENT_PROCESS_MODE', 'active'],
    ['ENGAGEMENT_BACKGROUND_OWNER', 'engagement-api'],
    ['ENGAGEMENT_EXTERNAL_ACTIONS', 'enabled'],
    ['ENGAGEMENT_CALLBACKS_ENABLED', 'true'],
    ['ENGAGEMENT_RECALL_WEBHOOK_ENABLED', 'true'],
  ])('rejects a PARTIAL arm of shadow field %s (all-or-nothing posture)', (field: string, value: string) => {
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

  describe('the active (promoted) posture', () => {
    const activeEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
      CAPIRO_SERVICE_NAME: 'engagement-api',
      ENGAGEMENT_PROCESS_MODE: 'active',
      ENGAGEMENT_BACKGROUND_OWNER: 'engagement-api',
      ENGAGEMENT_EXTERNAL_ACTIONS: 'enabled',
      ENGAGEMENT_CALLBACKS_ENABLED: 'true',
      ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'true',
      ENGAGEMENT_API_PROMOTION_TOKEN: ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT,
      ...extra,
    });

    it('accepts all five controls armed together WITH the matching promotion token', () => {
      expect(resolveEngagementRuntimeEnvironment(activeEnv())).toEqual({
        serviceName: 'engagement-api',
        processMode: 'active',
        backgroundOwner: 'engagement-api',
        externalActions: 'enabled',
        callbacksEnabled: true,
        recallWebhookEnabled: true,
      });
    });

    it('rejects all five controls armed WITHOUT the promotion token', () => {
      const env = activeEnv();
      delete env.ENGAGEMENT_API_PROMOTION_TOKEN;
      expect(() => resolveEngagementRuntimeEnvironment(env)).toThrow(
        /promotion token|acknowledgement/i,
      );
    });

    it('rejects all five controls armed WITH a WRONG promotion token', () => {
      expect(() =>
        resolveEngagementRuntimeEnvironment(
          activeEnv({ ENGAGEMENT_API_PROMOTION_TOKEN: 'yes-i-am-sure' }),
        ),
      ).toThrow(/promotion token|acknowledgement/i);
    });

    it('rejects a partial active combination even WITH a correct-looking token', () => {
      // backgroundOwner left at 'api' (shadow's value) while everything else
      // says active — the token alone must not paper over a partial mix.
      const env = activeEnv({ ENGAGEMENT_BACKGROUND_OWNER: 'api' });
      expect(() => resolveEngagementRuntimeEnvironment(env)).toThrow(/shadow posture/i);
    });

    it('rejects a promotion token supplied on a SHADOW-postured service (token alone cannot arm it)', () => {
      // The token only matters once every posture field already says active.
      // Supplying it while every field is still at its shadow value must not
      // partially arm anything — resolveEngagementRuntimeEnvironment ignores
      // the token entirely in that branch, so this asserts shadow behavior is
      // unchanged rather than throwing for the wrong reason.
      expect(
        resolveEngagementRuntimeEnvironment({
          CAPIRO_SERVICE_NAME: 'engagement-api',
          ENGAGEMENT_PROCESS_MODE: 'shadow',
          ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
          ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
          ENGAGEMENT_CALLBACKS_ENABLED: 'false',
          ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
          ENGAGEMENT_API_PROMOTION_TOKEN: ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT,
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

    it('never applies the promotion-token requirement to service=api', () => {
      // The main API can freely run with backgroundOwner=engagement-api etc.
      // (that is exactly the ownership-transfer shape) without ever needing
      // this token — the gate exists only for the engagement-api process
      // arming ITSELF.
      expect(
        resolveEngagementRuntimeEnvironment({
          CAPIRO_SERVICE_NAME: 'api',
          ENGAGEMENT_BACKGROUND_OWNER: 'engagement-api',
          ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
          ENGAGEMENT_CALLBACKS_ENABLED: 'false',
          ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
        }),
      ).toEqual({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'engagement-api',
        externalActions: 'disabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
    });
  });
});
