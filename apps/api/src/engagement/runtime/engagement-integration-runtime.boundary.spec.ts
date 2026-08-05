import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { GmailSendService } from '../google/gmail-send.service.js';
import type { GoogleOAuthService } from '../google/google-oauth.service.js';
import type { GoogleSyncService } from '../google/google-sync.service.js';
import type { MicrosoftGraphSyncService } from '../microsoft/microsoft-graph-sync.service.js';
import type { MicrosoftOAuthService } from '../microsoft/microsoft-oauth.service.js';
import {
  GMAIL_SEND_RUNTIME_METHODS,
  GOOGLE_OAUTH_RUNTIME_METHODS,
  GOOGLE_SYNC_RUNTIME_METHODS,
  guardGmailSendService,
  guardGoogleOAuthService,
  guardGoogleSyncService,
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
});
