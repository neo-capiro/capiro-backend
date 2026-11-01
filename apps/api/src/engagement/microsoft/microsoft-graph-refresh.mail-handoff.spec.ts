/**
 * Focused N lower checks for the Microsoft Graph private refresh/reconnect path
 * (SCRUM-190). Real service + real barrier; MSAL, prisma and crypto are inert fakes.
 * No provider, DB, socket, network, bootstrap or real signal.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';

// The canonical claim/admission helpers run real SQL against a Prisma client; the
// focused cases below exercise the refresh composition, so they are inert here.
jest.mock('../mailbox-sync-claim.js', () => ({
  assertMailboxSyncCurrent: jest.fn(async () => undefined),
  mailboxState: jest.fn(() => ({})),
  mergeMailboxSyncState: jest.fn((state: unknown) => state),
  withMailboxSyncClaim: jest.fn(),
}));
jest.mock('../mailbox-oauth-authority.js', () => ({
  admitMailboxRefresh: jest.fn(async () => ({ syncState: 'in-sync' })),
  lockMailboxConnection: jest.fn(async () => undefined),
}));

import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { MICROSOFT_SCOPES } from './microsoft-oauth-constants.js';
import { EngagementMailHandoffBarrier } from '../runtime/engagement-mail-handoff.js';
import { EngagementRuntimePolicyService } from '../runtime/engagement-runtime-policy.service.js';

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
    keyVersion: 3,
    scopes: MICROSOFT_SCOPES,
    homeAccountId: 'home-1',
    expiresAt: EXPIRED(),
    ...overrides,
  } as never;
}

function prisma() {
  const connectionUpdate = jest.fn(async () => ({}));
  const withTenant = jest.fn(async (_tenant: string, run: (tx: unknown) => unknown) =>
    run({ integrationConnection: { update: connectionUpdate } }),
  );
  return { withTenant, connectionUpdate };
}

interface RefreshFacade {
  getValidAccessToken(
    tenantId: string,
    connectionId: string,
    token: unknown,
    scopes?: readonly string[],
  ): Promise<string>;
}

function service(
  prismaFake: ReturnType<typeof prisma>,
  runtimePolicy: EngagementRuntimePolicyService,
  msal: jest.Mock,
  persist: jest.Mock,
) {
  const svc = Object.create(MicrosoftGraphSyncService.prototype) as Record<string, unknown>;
  svc.runtimePolicy = runtimePolicy;
  svc.prisma = prismaFake;
  svc.tokenCrypto = {
    isConfigured: () => true,
    decrypt: jest.fn((envelope: { ciphertext: string }) =>
      envelope.ciphertext === 'rcipher' ? 'refresh-plain' : 'ms-access',
    ),
    encrypt: jest.fn((value: string) => ({
      ciphertext: `enc:${value}`,
      iv: 'iv',
      authTag: 'tag',
    })),
    getKeyVersion: () => 5,
  };
  svc.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  svc.assertTokenRefreshConfigured = (): void => undefined;
  svc.buildMsalClient = () => ({ acquireTokenByRefreshToken: msal });
  svc.persistRefreshedAccessToken = persist;
  return svc as unknown as RefreshFacade;
}

function msalResult() {
  return {
    accessToken: 'ms-access',
    account: { homeAccountId: 'home-1' },
    scopes: [...MICROSOFT_SCOPES],
  };
}

describe('MicrosoftGraphSyncService private refresh admission (N)', () => {
  it('refuses an unowned selected missing-identity refresh before its reconnect write', async () => {
    const { runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const svc = service(db, runtimePolicy, jest.fn(), jest.fn(async () => undefined));

    await expect(
      svc.getValidAccessToken('t1', 'conn-1', token({ homeAccountId: null })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(db.connectionUpdate).not.toHaveBeenCalled();
    expect(db.withTenant).toHaveBeenCalledTimes(1); // the canonical claim read only
  });

  it('keeps the original identity reconnect write and error when the refresh is owned', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const svc = service(db, runtimePolicy, jest.fn(), jest.fn(async () => undefined));

    await expect(
      barrier.runAdmitted('oauth_callback_continue', async () => {
        await svc.getValidAccessToken('t1', 'conn-1', token({ homeAccountId: null }));
      }),
    ).rejects.toThrow(/identity is missing/);

    expect(db.connectionUpdate).toHaveBeenCalledTimes(1);
    expect(barrier.observation()?.settledWork.oauth_callback_continue).toBe(1);
    expect(barrier.observation()?.unknownTotal).toBe(0);
  });

  it('preserves provider scopes and the success path for an owned refresh', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const msal = jest.fn(async () => msalResult());
    const persist = jest.fn(async () => undefined);
    const svc = service(db, runtimePolicy, msal, persist);

    const accessToken = await barrier.runAdmitted('oauth_callback_continue', async () =>
      svc.getValidAccessToken('t1', 'conn-1', token(), ['Teams.ReadBasic.All']),
    );

    expect(accessToken).toBe('ms-access');
    const request = msal.mock.calls[0]?.[0] as { scopes: string[]; refreshToken: string };
    expect(request.refreshToken).toBe('refresh-plain');
    expect(request.scopes).toEqual([...MICROSOFT_SCOPES, 'Teams.ReadBasic.All']);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(barrier.observation()?.settledWork.oauth_callback_continue).toBe(1);
    expect(barrier.observation()?.unknownTotal).toBe(0);
  });

  it('retains unknown when persistence fails inside caught admitted work', async () => {
    const { barrier, runtimePolicy } = policy('initiation_fenced');
    const db = prisma();
    const msal = jest.fn(async () => msalResult());
    const persist = jest.fn(async () => {
      throw new Error('commit failed');
    });
    const svc = service(db, runtimePolicy, msal, persist);

    await barrier.runAdmitted('oauth_callback_continue', async () => {
      try {
        await svc.getValidAccessToken('t1', 'conn-1', token());
      } catch {
        // caught by the owner: the admitted work itself succeeds
      }
    });

    expect(barrier.observation()?.unknownTotal).toBe(1);
    expect(barrier.observation()?.settledWork.oauth_callback_continue).toBeUndefined();
  });
});
