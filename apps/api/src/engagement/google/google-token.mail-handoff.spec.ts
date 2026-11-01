/**
 * Focused N lower checks for GoogleTokenService mail-handoff composition
 * (SCRUM-190). Real service + real barrier/policy; fetch, prisma, crypto and the
 * mailbox claim/transport collaborators are inert fakes. No provider, DB, socket,
 * network, bootstrap or real signal.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';

jest.mock('../mailbox-sync-claim.js', () => ({
  assertMailboxSyncCurrent: jest.fn(async () => undefined),
}));
jest.mock('../mailbox-oauth-authority.js', () => ({
  admitMailboxRefresh: jest.fn(async () => ({ syncState: 'in-sync', cursor: 'c1' })),
}));
jest.mock('../mailbox-provider-transport.js', () => ({
  mailboxProviderRequest: jest.fn(async (run: (signal: unknown) => Promise<unknown>) =>
    run(new AbortController().signal),
  ),
}));
jest.mock('../integration-health.js', () => ({
  verifiedScopeState: jest.fn((state: string) => `verified:${state}`),
}));
jest.mock('../mail-sync-failure.js', () => ({
  MailboxReconnectRequiredError: class MailboxReconnectRequiredError extends Error {},
  mailSyncFailureData: jest.fn(() => ({ status: 'needs_configuration', lastError: 'reconnect' })),
}));
jest.mock('./google-oauth.service.js', () => ({
  missingGoogleGrants: jest.fn(() => []),
}));

import { GoogleTokenService } from './google-token.service.js';
import { EngagementMailHandoffBarrier } from '../runtime/engagement-mail-handoff.js';
import { EngagementRuntimePolicyService } from '../runtime/engagement-runtime-policy.service.js';

const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000);
const EXPIRED = () => new Date(Date.now() - 60 * 1000);

function policy(phase: 'off' | 'initiation_fenced') {
  const barrier = new EngagementMailHandoffBarrier();
  barrier.bind({
    serviceName: 'api',
    processMode: 'shadow',
    backgroundOwner: 'disabled',
    externalActions: 'enabled',
    callbacksEnabled: true,
    recallWebhookEnabled: false,
    mailHandoff: phase === 'off' ? undefined : { phase, generation: 'g1', fenceUtc: null },
  } as never);
  const runtimePolicy = new EngagementRuntimePolicyService(
    {
      serviceName: 'api',
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'enabled',
      callbacksEnabled: true,
      recallWebhookEnabled: false,
    } as never,
    barrier,
  );
  return { barrier, runtimePolicy };
}

function token(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'conn-1',
    accessTokenCiphertext: 'acipher',
    accessTokenIv: 'aiv',
    accessTokenAuthTag: 'atag',
    refreshTokenCiphertext: 'rcipher',
    refreshTokenIv: 'riv',
    refreshTokenAuthTag: 'rtag',
    keyVersion: 4,
    scopes: ['gmail.readonly'],
    expiresAt: EXPIRED(),
    ...overrides,
  } as never;
}

function crypto() {
  return {
    isConfigured: () => true,
    decrypt: jest.fn((envelope: { ciphertext: string }) =>
      envelope.ciphertext === 'rcipher' ? 'refresh-plain' : 'cached-access-plain',
    ),
    encrypt: jest.fn((value: string) => ({
      ciphertext: `enc:${value}`,
      iv: 'iv',
      authTag: 'tag',
    })),
    getKeyVersion: () => 7,
  };
}

function prisma(failOn?: 'token' | 'connection') {
  const tokenUpdate = jest.fn(async () => {
    if (failOn === 'token') throw new Error('commit failed');
    return {};
  });
  const connectionUpdate = jest.fn(async () => {
    if (failOn === 'connection') throw new Error('commit failed');
    return {};
  });
  const withTenant = jest.fn(async (_tenant: string, run: (tx: unknown) => unknown) =>
    run({
      integrationConnectionToken: { update: tokenUpdate },
      integrationConnection: { update: connectionUpdate, findUnique: jest.fn(async () => null) },
    }),
  );
  return { withTenant, tokenUpdate, connectionUpdate };
}

function service(
  prismaFake: ReturnType<typeof prisma>,
  runtimePolicy: EngagementRuntimePolicyService,
) {
  const config = {
    get: (key: string) =>
      key === 'GOOGLE_CLIENT_ID'
        ? 'client-id'
        : key === 'GOOGLE_CLIENT_SECRET'
          ? 'client-secret'
          : undefined,
  };
  return new GoogleTokenService(
    prismaFake as never,
    crypto() as never,
    config as never,
    runtimePolicy,
  );
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
    text: async () => '',
  } as unknown as Response;
}

describe('GoogleTokenService mail-handoff composition (N)', () => {
  it('serves a valid cached token through the canonical precheck with no write', async () => {
    const { runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch must not be called'));
    const svc = service(db, runtimePolicy);

    const accessToken = await svc.getValidAccessToken('t1', 'conn-1', token({ expiresAt: FUTURE() }));

    expect(accessToken).toBe('cached-access-plain');
    // The canonical current-claim read still ran, before any admission.
    expect(db.withTenant).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.tokenUpdate).not.toHaveBeenCalled();
    expect(db.connectionUpdate).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses a new unowned refresh before any provider call or write', async () => {
    const { runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch must not be called'));
    const svc = service(db, runtimePolicy);

    await expect(svc.getValidAccessToken('t1', 'conn-1', token())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.tokenUpdate).not.toHaveBeenCalled();
    expect(db.connectionUpdate).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('keeps N reconnect behavior for a missing envelope inside an owned refresh', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch must not be called'));
    const svc = service(db, runtimePolicy);

    await expect(
      barrier.runAdmitted('oauth_callback_continue', async () => {
        await svc.getValidAccessToken(
          't1',
          'conn-1',
          token({ refreshTokenCiphertext: null, refreshTokenIv: null, refreshTokenAuthTag: null }),
        );
      }),
    ).rejects.toThrow(/refresh token is missing/);

    // N's reconnect write happened (not C/E's no-write behavior), once, and no
    // provider call was made.
    expect(db.connectionUpdate).toHaveBeenCalledTimes(1);
    expect(db.tokenUpdate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(barrier.observation()?.settledTotal).toBe(1);
    fetchSpy.mockRestore();
  });

  it('persists both envelopes, one keyVersion and the current snapshot on an owned refresh', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse() as never);
    const svc = service(db, runtimePolicy);

    const accessToken = await barrier.runAdmitted('oauth_callback_continue', async () =>
      svc.getValidAccessToken('t1', 'conn-1', token()),
    );

    expect(accessToken).toBe('new-access');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const data = (db.tokenUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.accessTokenCiphertext).toBe('enc:new-access');
    expect(data.refreshTokenCiphertext).toBe('enc:refresh-plain');
    expect(data.keyVersion).toBe(7);
    expect(db.connectionUpdate).toHaveBeenCalledTimes(1);
    // Precheck + transaction snapshot check both ran.
    expect(db.withTenant).toHaveBeenCalledTimes(2);
    expect(barrier.observation()?.settledTotal).toBe(1);
    expect(barrier.observation()?.unknownTotal).toBe(0);
    fetchSpy.mockRestore();
  });

  it('retains unknown when the durable write fails inside caught admitted work', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const db = prisma('token');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse() as never);
    const svc = service(db, runtimePolicy);

    await barrier.runAdmitted('oauth_callback_continue', async () => {
      try {
        await svc.getValidAccessToken('t1', 'conn-1', token());
      } catch {
        // caught by the owner: the admitted work itself succeeds
      }
    });

    expect(barrier.observation()?.unknownTotal).toBe(1);
    expect(barrier.observation()?.settledWork.oauth_callback_continue).toBeUndefined();
    fetchSpy.mockRestore();
  });
});
