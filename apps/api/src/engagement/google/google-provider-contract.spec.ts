// Phase H (completion plan §3.h1) — Google provider contract tests. Fetch-stub
// driven, no network. Covers start()'s auth-URL shape, the HMAC state
// sign/verify pair, capabilities()'s configured flag, and
// GoogleTokenService.getValidAccessToken's cache/refresh/invalid_grant/
// transient-failure branches.
//
// signState/verifyState are private -- reached via a same-shape cast
// (asTestable below), not by changing their visibility. getValidAccessToken
// lives on GoogleTokenService, not GoogleOAuthService (the two providers
// split this differently: Google extracted it to a shared service used by
// both the read and send paths; Microsoft keeps it private on
// MicrosoftGraphSyncService itself).

import { describe, expect, test } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { EngagementConnectionStatus, type IntegrationConnectionToken } from '@prisma/client';
import { GOOGLE_WORKSPACE_SCOPES } from '@capiro/shared';
import type { TenantContext } from '@capiro/shared';
import { GoogleOAuthService } from './google-oauth.service.js';
import { GoogleTokenService } from './google-token.service.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

type StatePayload = { c: string; t: string; n: string; e: number };
type OAuthTestSurface = {
  signState(payload: StatePayload): string;
  verifyState(state: string): StatePayload;
};

function asTestable(service: GoogleOAuthService): OAuthTestSurface {
  return service as unknown as OAuthTestSurface;
}

function makeOAuthService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(GoogleOAuthService.prototype) as GoogleOAuthService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.clientId = 'client-id';
  patch.clientSecret = 'client-secret';
  patch.redirectUri = 'https://app.capiro.ai/api/engagement/integrations/google/callback';
  patch.successRedirect = '/settings/integrations';
  patch.stateSecret = Buffer.from('test-state-secret', 'utf8');
  patch.tokenCrypto = { isConfigured: () => true };
  patch.prisma = {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        integrationConnection: {
          findFirst: async () => null,
          create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'conn-1', ...data }),
        },
      }),
  };
  Object.assign(patch, overrides);
  return service;
}

describe('GoogleOAuthService.start', () => {
  test('builds an auth URL carrying access_type=offline, prompt=consent, all six scopes, and a two-segment state', async () => {
    const service = makeOAuthService();
    const result = await service.start(ctx, {});
    const url = new URL(result.authUrl);

    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    // Sourced from the SAME shared constant the app requests -- if
    // google-oauth.service.ts's GOOGLE_SCOPES ever drifted from
    // GOOGLE_WORKSPACE_SCOPES again (the exact class of bug commit 9f685e2b
    // fixed), this assertion would catch it.
    expect(url.searchParams.get('scope')).toBe(GOOGLE_WORKSPACE_SCOPES.join(' '));
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(state!.split('.')).toHaveLength(2);
    expect(result.connectionId).toBe('conn-1');
  });
});

describe('GoogleOAuthService state signing (signState/verifyState)', () => {
  test('rejects a tampered signature', () => {
    const service = asTestable(makeOAuthService());
    const valid = service.signState({
      c: 'conn-1',
      t: 't1',
      n: 'nonce',
      e: Math.floor(Date.now() / 1000) + 600,
    });
    const [body] = valid.split('.');
    expect(() => service.verifyState(`${body}.tamperedsignature`)).toThrow(BadRequestException);
  });

  test('rejects an expired payload', () => {
    const service = asTestable(makeOAuthService());
    const expired = service.signState({
      c: 'conn-1',
      t: 't1',
      n: 'nonce',
      e: Math.floor(Date.now() / 1000) - 10,
    });
    expect(() => service.verifyState(expired)).toThrow(BadRequestException);
  });

  test('accepts a validly signed, unexpired state', () => {
    const service = asTestable(makeOAuthService());
    const valid = service.signState({
      c: 'conn-1',
      t: 't1',
      n: 'nonce',
      e: Math.floor(Date.now() / 1000) + 600,
    });
    expect(service.verifyState(valid)).toEqual({
      c: 'conn-1',
      t: 't1',
      n: 'nonce',
      e: expect.any(Number),
    });
  });
});

describe('GoogleOAuthService.capabilities', () => {
  test('reports configured:false when the client id/secret are missing', () => {
    const service = makeOAuthService({ clientId: undefined, clientSecret: undefined });
    expect(service.capabilities().configured).toBe(false);
  });

  test('reports configured:true when everything required is present', () => {
    const service = makeOAuthService();
    expect(service.capabilities().configured).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(status: number, text: string): Response {
  return { ok: false, status, text: async () => text } as unknown as Response;
}

function makeToken(overrides: Partial<{ expiresAt: Date }> = {}): IntegrationConnectionToken {
  return {
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
    accessTokenCiphertext: 'access-cipher',
    accessTokenIv: 'access-iv',
    accessTokenAuthTag: 'access-tag',
    refreshTokenCiphertext: 'refresh-cipher',
    refreshTokenIv: 'refresh-iv',
    refreshTokenAuthTag: 'refresh-tag',
  } as unknown as IntegrationConnectionToken;
}

function makeTokenService(opts: {
  fetchImpl: () => Promise<Response>;
  decrypt?: () => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock plumbing only
  connectionUpdate?: (args: any) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock plumbing only
  tokenUpdate?: (args: any) => Promise<unknown>;
}) {
  const service = Object.create(GoogleTokenService.prototype) as GoogleTokenService;
  const patch = service as unknown as Record<string, unknown>;
  patch.clientId = 'client-id';
  patch.clientSecret = 'client-secret';
  patch.tokenCrypto = {
    isConfigured: () => true,
    decrypt: opts.decrypt ?? (() => 'decrypted-refresh-token'),
    encrypt: (value: string) => ({ ciphertext: `enc(${value})`, iv: 'iv', authTag: 'tag' }),
    getKeyVersion: () => 1,
  };
  const connectionUpdate = opts.connectionUpdate ?? (async () => undefined);
  const tokenUpdate = opts.tokenUpdate ?? (async () => undefined);
  patch.prisma = {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        integrationConnectionToken: { update: tokenUpdate },
        integrationConnection: { update: connectionUpdate },
      }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = opts.fetchImpl as unknown as typeof fetch;
  return {
    service,
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('GoogleTokenService.getValidAccessToken', () => {
  test('returns the cached access token when expiresAt is beyond the 5-minute refresh skew', async () => {
    const decrypt = jest.fn(() => 'cached-access-token');
    const { service, restoreFetch } = makeTokenService({
      decrypt,
      fetchImpl: async () => {
        throw new Error('fetch must not be called for a still-valid cached token');
      },
    });
    try {
      const token = makeToken({ expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
      const result = await service.getValidAccessToken('t1', 'conn-1', token);
      expect(result).toBe('cached-access-token');
      expect(decrypt).toHaveBeenCalledTimes(1);
    } finally {
      restoreFetch();
    }
  });

  test('refreshes via the network when the cached token is within the skew window', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 }),
    );
    const { service, restoreFetch } = makeTokenService({ fetchImpl });
    try {
      const token = makeToken({ expiresAt: new Date(Date.now() + 60 * 1000) });
      const result = await service.getValidAccessToken('t1', 'conn-1', token);
      expect(result).toBe('fresh-access-token');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      restoreFetch();
    }
  });

  test('a 400 invalid_grant refresh flips the connection to needs_configuration and throws', async () => {
    const fetchImpl = jest.fn(async () =>
      errorResponse(400, 'error=invalid_grant&error_description=Token has been expired or revoked.'),
    );
    const connectionUpdate = jest.fn(async (_args: { data: { status: string } }) => undefined);
    const { service, restoreFetch } = makeTokenService({ fetchImpl, connectionUpdate });
    try {
      const token = makeToken({ expiresAt: new Date(Date.now() + 60 * 1000) });
      await expect(service.getValidAccessToken('t1', 'conn-1', token)).rejects.toThrow(
        BadRequestException,
      );
      expect(connectionUpdate).toHaveBeenCalledTimes(1);
      const call = connectionUpdate.mock.calls[0]![0];
      expect(call.data.status).toBe(EngagementConnectionStatus.needs_configuration);
    } finally {
      restoreFetch();
    }
  });

  test('a non-invalid_grant failure throws ServiceUnavailableException without changing connection status', async () => {
    const fetchImpl = jest.fn(async () => errorResponse(500, 'internal server error'));
    const connectionUpdate = jest.fn(async () => undefined);
    const { service, restoreFetch } = makeTokenService({ fetchImpl, connectionUpdate });
    try {
      const token = makeToken({ expiresAt: new Date(Date.now() + 60 * 1000) });
      await expect(service.getValidAccessToken('t1', 'conn-1', token)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(connectionUpdate).not.toHaveBeenCalled();
    } finally {
      restoreFetch();
    }
  });
});
