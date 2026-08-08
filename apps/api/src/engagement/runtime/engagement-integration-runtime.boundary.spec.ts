import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { GmailSendService } from '../google/gmail-send.service.js';
import type { GoogleOAuthService } from '../google/google-oauth.service.js';
import type { GoogleSyncService } from '../google/google-sync.service.js';
import type { GoogleTokenService } from '../google/google-token.service.js';
import type { MicrosoftGraphSyncService } from '../microsoft/microsoft-graph-sync.service.js';
import type { MicrosoftOAuthService } from '../microsoft/microsoft-oauth.service.js';
import {
  GMAIL_SEND_RUNTIME_METHODS,
  GOOGLE_OAUTH_RUNTIME_METHODS,
  GOOGLE_SYNC_RUNTIME_METHODS,
  GOOGLE_TOKEN_RUNTIME_METHODS,
  guardGmailSendService,
  guardGoogleOAuthService,
  guardGoogleSyncService,
  guardGoogleTokenService,
  guardMicrosoftGraphSyncService,
  guardMicrosoftOAuthService,
  MICROSOFT_GRAPH_RUNTIME_METHODS,
  MICROSOFT_OAUTH_RUNTIME_METHODS,
} from './engagement-integration-runtime.boundary.js';
import { EngagementRuntimePolicyService } from './engagement-runtime-policy.service.js';

function shadowPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'engagement-api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'disabled',
    callbacksEnabled: false,
    recallWebhookEnabled: false,
  });
}

function callbackDisabledPolicy(): EngagementRuntimePolicyService {
  return new EngagementRuntimePolicyService({
    serviceName: 'api',
    processMode: 'active',
    backgroundOwner: 'api',
    externalActions: 'enabled',
    callbacksEnabled: false,
    recallWebhookEnabled: true,
  });
}

function expectBlocked(
  methods: Readonly<Record<string, unknown>>,
  wrap: (raw: object) => object,
): void {
  for (const methodName of Object.keys(methods)) {
    const implementation = jest.fn(async () => ({ unsafe: true }));
    const guarded = wrap({ [methodName]: implementation }) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    let caught: unknown;
    try {
      void guarded[methodName]?.({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getStatus()).toBe(503);
    expect((caught as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
    });
    expect(implementation).not.toHaveBeenCalled();
  }
}

describe('Engagement integration runtime boundaries', () => {
  it('blocks every Microsoft Graph sync, subscription, notification, and send entry point', () => {
    expectBlocked(MICROSOFT_GRAPH_RUNTIME_METHODS, (raw) =>
      guardMicrosoftGraphSyncService(
        raw as unknown as MicrosoftGraphSyncService,
        shadowPolicy(),
      ),
    );
  });

  it('blocks every Microsoft OAuth lifecycle entry point', () => {
    expectBlocked(MICROSOFT_OAUTH_RUNTIME_METHODS, (raw) =>
      guardMicrosoftOAuthService(raw as unknown as MicrosoftOAuthService, shadowPolicy()),
    );
  });

  it('blocks Google token loading, decryption, and refresh', () => {
    expectBlocked(GOOGLE_TOKEN_RUNTIME_METHODS, (raw) =>
      guardGoogleTokenService(raw as unknown as GoogleTokenService, shadowPolicy()),
    );
  });

  it('blocks every Google sync entry point', () => {
    expectBlocked(GOOGLE_SYNC_RUNTIME_METHODS, (raw) =>
      guardGoogleSyncService(raw as unknown as GoogleSyncService, shadowPolicy()),
    );
  });

  it('blocks every Google OAuth lifecycle entry point', () => {
    expectBlocked(GOOGLE_OAUTH_RUNTIME_METHODS, (raw) =>
      guardGoogleOAuthService(raw as unknown as GoogleOAuthService, shadowPolicy()),
    );
  });

  it('blocks direct Gmail sends', () => {
    expectBlocked(GMAIL_SEND_RUNTIME_METHODS, (raw) =>
      guardGmailSendService(raw as unknown as GmailSendService, shadowPolicy()),
    );
  });

  it('preserves local capability reads', () => {
    const capabilities = jest.fn(() => ({ configured: false }));
    const guarded = guardGoogleOAuthService(
      { capabilities } as unknown as GoogleOAuthService,
      shadowPolicy(),
    );
    expect(guarded.capabilities()).toEqual({ configured: false });
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('fails closed on Microsoft notifications when external actions are enabled but callback ownership is off', () => {
    const handleNotifications = jest.fn(async () => ({ unsafe: true }));
    const guarded = guardMicrosoftGraphSyncService(
      { handleNotifications } as unknown as MicrosoftGraphSyncService,
      callbackDisabledPolicy(),
    );

    expect(() => guarded.handleNotifications({ value: [] } as never)).toThrow(
      ServiceUnavailableException,
    );
    expect(handleNotifications).not.toHaveBeenCalled();
    try {
      void guarded.handleNotifications({ value: [] } as never);
    } catch (error) {
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'ENGAGEMENT_CALLBACKS_DISABLED',
      });
    }
  });

  it('fails closed on Google OAuth callback when external actions are enabled but callback ownership is off', () => {
    const handleCallback = jest.fn(async () => ({ unsafe: true }));
    const guarded = guardGoogleOAuthService(
      { handleCallback } as unknown as GoogleOAuthService,
      callbackDisabledPolicy(),
    );

    expect(() => guarded.handleCallback({ code: 'code', state: 'state' })).toThrow(
      ServiceUnavailableException,
    );
    expect(handleCallback).not.toHaveBeenCalled();
  });
});
