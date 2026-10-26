import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
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
  describe.each(['api', 'engagement-api'] as const)('integrations_only in %s', (serviceName) => {
    const policy = (callbacksEnabled = true) =>
      new EngagementRuntimePolicyService({
        serviceName,
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'integrations_only',
        callbacksEnabled,
        recallWebhookEnabled: false,
      });

    beforeEach(() => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        OUTREACH_V3_STATE_ENABLED: 'true',
        OUTREACH_V3_DRAFTS_ENABLED: 'true',
        OUTREACH_V3_SEND_ENABLED: 'true',
      });
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('allows both provider syncs, token access, OAuth and subscriptions through their existing boundaries', async () => {
      const sync = jest.fn(async () => ({ completed: true }));
      const start = jest.fn(async () => ({ url: 'https://provider.example.test/authorize' }));
      const callback = jest.fn(async () => ({ connected: true }));
      const subscriptions = jest.fn(async () => ({ configured: true }));
      const notifications = jest.fn(async () => ({ accepted: true }));
      const token = jest.fn(async () => 'synthetic-token');
      const google = guardGoogleSyncService(
        { syncConnection: sync } as unknown as GoogleSyncService,
        policy(),
      );
      const graph = guardMicrosoftGraphSyncService(
        {
          syncConnection: sync,
          configureSubscriptions: subscriptions,
          handleNotifications: notifications,
        } as unknown as MicrosoftGraphSyncService,
        policy(),
      );
      const googleOAuth = guardGoogleOAuthService(
        { start, handleCallback: callback } as unknown as GoogleOAuthService,
        policy(),
      );
      const microsoftOAuth = guardMicrosoftOAuthService(
        { start, handleCallback: callback } as unknown as MicrosoftOAuthService,
        policy(),
      );
      const tokens = guardGoogleTokenService(
        { getValidAccessToken: token } as unknown as GoogleTokenService,
        policy(),
      );
      await expect(google.syncConnection({} as never, 'test-connection')).resolves.toEqual({
        completed: true,
      });
      await expect(graph.syncConnection({} as never, 'test-connection')).resolves.toEqual({
        completed: true,
      });
      for (const oauth of [googleOAuth, microsoftOAuth]) {
        await expect(oauth.start({} as never, {})).resolves.toEqual({
          url: 'https://provider.example.test/authorize',
        });
        await expect(
          oauth.handleCallback({ code: 'synthetic-code', state: 'synthetic-state' }),
        ).resolves.toEqual({ connected: true });
      }
      await expect(graph.configureSubscriptions({} as never, 'test-connection')).resolves.toEqual({
        configured: true,
      });
      await expect(graph.handleNotifications({ value: [] } as never)).resolves.toEqual({
        accepted: true,
      });
      await expect(
        tokens.getValidAccessToken('test-tenant', 'test-connection', {} as never),
      ).resolves.toBe('synthetic-token');
      expect(sync).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('keeps callbacks off unless explicitly enabled', () => {
      const handleCallback = jest.fn();
      const handleNotifications = jest.fn();
      const google = guardGoogleOAuthService(
        { handleCallback } as unknown as GoogleOAuthService,
        policy(false),
      );
      const microsoft = guardMicrosoftOAuthService(
        { handleCallback } as unknown as MicrosoftOAuthService,
        policy(false),
      );
      const graph = guardMicrosoftGraphSyncService(
        { handleNotifications } as unknown as MicrosoftGraphSyncService,
        policy(false),
      );
      for (const oauth of [google, microsoft]) {
        expect(() =>
          oauth.handleCallback({ code: 'synthetic-code', state: 'synthetic-state' }),
        ).toThrow(ServiceUnavailableException);
      }
      expect(() => graph.handleNotifications({ value: [] } as never)).toThrow(
        ServiceUnavailableException,
      );
      expect(handleCallback).not.toHaveBeenCalled();
      expect(handleNotifications).not.toHaveBeenCalled();
    });

    it.each([
      'outreach_send',
      'outreach_test_send',
      'outreach_v3_send',
      'outreach_v3_test_send',
    ] as const)(
      'denies %s before either provider sees a send, with every V3 send flag enabled',
      (runtimeAction) => {
        const sendMail = jest.fn();
        const google = guardGmailSendService({ sendMail } as unknown as GmailSendService, policy());
        const microsoft = guardMicrosoftGraphSyncService(
          { sendMail } as unknown as MicrosoftGraphSyncService,
          policy(),
        );
        for (const sender of [google, microsoft]) {
          expect(() =>
            sender.sendMail({} as never, 'test-connection', {
              runtimeAction,
              testMode: true,
            } as never),
          ).toThrow(ServiceUnavailableException);
        }
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    it('denies disconnect before either provider can revoke a grant or delete subscriptions', () => {
      const disconnect = jest.fn();
      const google = guardGoogleOAuthService(
        { disconnect } as unknown as GoogleOAuthService,
        policy(),
      );
      const microsoft = guardMicrosoftOAuthService(
        { disconnect } as unknown as MicrosoftOAuthService,
        policy(),
      );
      for (const oauth of [google, microsoft]) {
        expect(() => oauth.disconnect({} as never, 'test-connection')).toThrow(
          ServiceUnavailableException,
        );
      }
      expect(disconnect).not.toHaveBeenCalled();
    });
  });

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

  describe('explicit API owner integrations_only', () => {
    const policy = (callbacksEnabled = true) =>
      new EngagementRuntimePolicyService({
        serviceName: 'api',
        processMode: 'shadow',
        backgroundOwner: 'api',
        externalActions: 'integrations_only',
        callbacksEnabled,
        recallWebhookEnabled: false,
      });

    beforeEach(() => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        OUTREACH_V3_STATE_ENABLED: 'true',
        OUTREACH_V3_DRAFTS_ENABLED: 'true',
        OUTREACH_V3_SEND_ENABLED: 'true',
        OUTREACH_V3_GENERATION_ENABLED: 'true',
        OUTREACH_V3_FULL_GENERATION_ENABLED: 'true',
        OUTREACH_V3_REASONING_ENABLED: 'true',
      });
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('allows guarded sync and subscription renewal through the existing boundaries', async () => {
      const sync = jest.fn(async () => ({ completed: true }));
      const subscriptions = jest.fn(async () => ({ configured: true }));
      const google = guardGoogleSyncService(
        { syncConnection: sync } as unknown as GoogleSyncService,
        policy(),
      );
      const graph = guardMicrosoftGraphSyncService(
        {
          syncConnection: sync,
          configureSubscriptions: subscriptions,
        } as unknown as MicrosoftGraphSyncService,
        policy(),
      );
      await expect(google.syncConnection({} as never, 'test-connection')).resolves.toEqual({
        completed: true,
      });
      await expect(graph.syncConnection({} as never, 'test-connection')).resolves.toEqual({
        completed: true,
      });
      await expect(graph.configureSubscriptions({} as never, 'test-connection')).resolves.toEqual({
        configured: true,
      });
      expect(sync).toHaveBeenCalledTimes(2);
      expect(subscriptions).toHaveBeenCalledTimes(1);
    });

    it.each([
      'outreach_send',
      'outreach_test_send',
      'outreach_v3_send',
      'outreach_v3_test_send',
    ] as const)(
      'denies %s before either provider sees a send, with every V3 send flag enabled',
      (runtimeAction) => {
        const sendMail = jest.fn();
        const google = guardGmailSendService({ sendMail } as unknown as GmailSendService, policy());
        const microsoft = guardMicrosoftGraphSyncService(
          { sendMail } as unknown as MicrosoftGraphSyncService,
          policy(),
        );
        for (const sender of [google, microsoft]) {
          expect(() =>
            sender.sendMail({} as never, 'test-connection', {
              runtimeAction,
              testMode: true,
            } as never),
          ).toThrow(ServiceUnavailableException);
        }
        expect(sendMail).not.toHaveBeenCalled();
      },
    );

    it('keeps callbacks off unless explicitly enabled', () => {
      const handleCallback = jest.fn();
      const google = guardGoogleOAuthService(
        { handleCallback } as unknown as GoogleOAuthService,
        policy(false),
      );
      expect(() =>
        google.handleCallback({ code: 'synthetic-code', state: 'synthetic-state' }),
      ).toThrow(ServiceUnavailableException);
      expect(handleCallback).not.toHaveBeenCalled();
    });

    it('denies disconnect before either provider can revoke a grant', () => {
      const disconnect = jest.fn();
      const google = guardGoogleOAuthService(
        { disconnect } as unknown as GoogleOAuthService,
        policy(),
      );
      const microsoft = guardMicrosoftOAuthService(
        { disconnect } as unknown as MicrosoftOAuthService,
        policy(),
      );
      for (const oauth of [google, microsoft]) {
        expect(() => oauth.disconnect({} as never, 'test-connection')).toThrow(
          ServiceUnavailableException,
        );
      }
      expect(disconnect).not.toHaveBeenCalled();
    });
  });
});
