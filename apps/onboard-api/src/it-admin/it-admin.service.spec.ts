import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GOOGLE_WORKSPACE_SCOPES } from '@capiro/shared';
import { ItAdminService } from './it-admin.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const RAW_TOKEN = 'a'.repeat(64);
const STATE_SECRET = 'test-state-secret';
const SCOPE_STRING = GOOGLE_WORKSPACE_SCOPES.join(' ');

function mockConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function mockPrisma(invite: Record<string, unknown> | null) {
  const inviteUpdate = jest.fn(
    async (_args: { where: unknown; data: Record<string, unknown> }) => ({}),
  );
  const taskUpdateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
  const prisma = {
    onboardItInvite: {
      findUnique: jest.fn(async () => invite),
      update: inviteUpdate,
    },
    onboardSetupTask: { updateMany: taskUpdateMany },
    withSystem: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ tenant: { findUnique: async () => ({ name: 'Keel Defense' }) } }),
    ),
  } as unknown as PrismaService;
  return { prisma, inviteUpdate, taskUpdateMany };
}

function liveInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    tenantId: 'tenant-1',
    email: 'it@keeldefense.co',
    status: 'sent',
    provider: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

function makeService(
  invite: Record<string, unknown> | null,
  env: Record<string, string | undefined> = {},
) {
  const { prisma, inviteUpdate, taskUpdateMany } = mockPrisma(invite);
  const service = new ItAdminService(
    prisma,
    mockConfig({ OAUTH_STATE_SECRET: STATE_SECRET, ...env }),
  );
  return { service, inviteUpdate, taskUpdateMany };
}

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id-123.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'shh',
  MICROSOFT_CLIENT_ID: 'ms-client-id',
};

function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${payload}.sig`;
}

function mockTokenResponse(body: Record<string, unknown>) {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => body,
  } as unknown as Response);
}

/** Run buildConsentUrl and pull the signed state back out of the URL. */
async function mintGoogleState(service: ItAdminService): Promise<string> {
  const { url } = await service.buildConsentUrl(RAW_TOKEN, 'google');
  return new URL(url).searchParams.get('state')!;
}

/** A validly-signed state for the default invite id, minted by a throwaway
 *  service with a live invite — lets the callback service under test return a
 *  DIFFERENT invite state (null / revoked / expired / already-granted) for the
 *  same id without findByToken rejecting it at mint time. */
async function stateForDefaultInvite(): Promise<string> {
  const { service } = makeService(liveInvite(), GOOGLE_ENV);
  return mintGoogleState(service);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('scope parity', () => {
  it('verify scopes are exactly the shared Google Workspace scope set', () => {
    // If a scope is ever added to the engagement connect, this pins the shared
    // source of truth; a matching apps/api test pins the engagement copy to it.
    expect([...GOOGLE_WORKSPACE_SCOPES]).toEqual([
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ]);
  });
});

describe('getInvite provider availability', () => {
  it('reports google unavailable (and no client id) until both GOOGLE_* are set', async () => {
    const { service } = makeService(liveInvite(), {
      MICROSOFT_CLIENT_ID: 'ms-client-id',
      GOOGLE_CLIENT_ID: 'client-id-123',
      // no secret → fail-closed
    });
    const view = await service.getInvite(RAW_TOKEN);
    expect(view.providers).toEqual({ microsoft: true, google: false });
    expect(view.googleClientId).toBeNull();
  });

  it('reports google available with the public client id once configured', async () => {
    const { service } = makeService(liveInvite(), GOOGLE_ENV);
    const view = await service.getInvite(RAW_TOKEN);
    expect(view.providers).toEqual({ microsoft: true, google: true });
    expect(view.googleClientId).toBe(GOOGLE_ENV.GOOGLE_CLIENT_ID);
  });

  it('reports microsoft unavailable when MICROSOFT_CLIENT_ID is unset (fail-closed)', async () => {
    const { service } = makeService(liveInvite(), {
      GOOGLE_CLIENT_ID: GOOGLE_ENV.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: GOOGLE_ENV.GOOGLE_CLIENT_SECRET,
      // no MICROSOFT_CLIENT_ID
    });
    const view = await service.getInvite(RAW_TOKEN);
    expect(view.providers).toEqual({ microsoft: false, google: true });
  });
});

describe('buildConsentUrl google', () => {
  it('400s when google is not configured', async () => {
    const { service } = makeService(liveInvite());
    await expect(service.buildConsentUrl(RAW_TOKEN, 'google')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('builds the full-scope online test-connect URL', async () => {
    const { service } = makeService(liveInvite(), GOOGLE_ENV);
    const { url } = await service.buildConsentUrl(RAW_TOKEN, 'google');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe(GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.capiro.ai/onboard-api/it/google/callback',
    );
    expect(parsed.searchParams.get('scope')).toBe(SCOPE_STRING);
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('login_hint')).toBe('it@keeldefense.co');
    // Verification only — never mint a refresh token on this path.
    expect(parsed.searchParams.get('access_type')).toBeNull();
    expect(parsed.searchParams.get('state')).toBeTruthy();
  });
});

describe('handleGoogleCallback', () => {
  it('rejects a bad state without touching the invite', async () => {
    const { service, inviteUpdate } = makeService(liveInvite(), GOOGLE_ENV);
    const url = await service.handleGoogleCallback({ state: 'garbage', code: 'x' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=state');
    expect(inviteUpdate).not.toHaveBeenCalled();
  });

  it('redirects reason=missing when the invite row is gone', async () => {
    const state = await stateForDefaultInvite();
    const { service, inviteUpdate } = makeService(null, GOOGLE_ENV);
    const url = await service.handleGoogleCallback({ state, code: 'x' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=missing');
    expect(inviteUpdate).not.toHaveBeenCalled();
  });

  it('does not grant a revoked invite (redirects reason=missing, no write)', async () => {
    const state = await stateForDefaultInvite();
    const { service, inviteUpdate, taskUpdateMany } = makeService(
      liveInvite({ status: 'revoked' }),
      GOOGLE_ENV,
    );
    const url = await service.handleGoogleCallback({ state, code: 'x' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=missing');
    expect(inviteUpdate).not.toHaveBeenCalled();
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it('does not grant an expired invite (redirects reason=expired, no write)', async () => {
    const state = await stateForDefaultInvite();
    const { service, inviteUpdate } = makeService(
      liveInvite({ expiresAt: new Date(Date.now() - 1000) }),
      GOOGLE_ENV,
    );
    const url = await service.handleGoogleCallback({ state, code: 'x' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=expired');
    expect(inviteUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent on replay: an already-granted invite returns /it/done without re-processing', async () => {
    const { service, inviteUpdate, taskUpdateMany } = makeService(
      liveInvite({ status: 'granted' }),
      GOOGLE_ENV,
    );
    const state = await mintGoogleState(service);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const url = await service.handleGoogleCallback({ state, code: 'reused-code' });
    expect(url).toBe('https://onboarding.capiro.ai/it/done');
    // No token exchange, no status flip — the prior grant stands.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inviteUpdate).not.toHaveBeenCalled();
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it('maps admin_policy_enforced to the trusted-app guidance page', async () => {
    const { service, inviteUpdate } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    const url = await service.handleGoogleCallback({ state, error: 'admin_policy_enforced' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=policy');
    expect(inviteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed' } }),
    );
  });

  it('maps access_denied to declined', async () => {
    const { service } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    const url = await service.handleGoogleCallback({ state, error: 'access_denied' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=declined');
  });

  it('treats a bare no-code callback (no error param) as declined', async () => {
    const { service } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    const url = await service.handleGoogleCallback({ state });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=declined');
  });

  it('fails the verify when the admin unchecked a required scope', async () => {
    const { service, taskUpdateMany } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    mockTokenResponse({
      access_token: 'at',
      // gmail.readonly unchecked on the consent screen
      scope:
        'openid email profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events.readonly',
      id_token: idToken({ email: 'admin@keeldefense.co', hd: 'keeldefense.co' }),
    });
    const url = await service.handleGoogleCallback({ state, code: 'auth-code' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=scopes');
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it('redirects to the error page when the code exchange fails', async () => {
    const { service } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    } as unknown as Response);
    const url = await service.handleGoogleCallback({ state, code: 'stale-code' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=exchange');
  });

  it('rejects an account on a different domain than the invite (reason=account)', async () => {
    const { service, taskUpdateMany } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    mockTokenResponse({
      access_token: 'at',
      scope: SCOPE_STRING,
      // invite is @keeldefense.co; admin signed in with a personal account
      id_token: idToken({ email: 'someone@gmail.com' }),
    });
    const url = await service.handleGoogleCallback({ state, code: 'auth-code' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=account');
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects a matching-scope grant from an unrelated Workspace (hd mismatch)', async () => {
    const { service } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    mockTokenResponse({
      access_token: 'at',
      scope: SCOPE_STRING,
      id_token: idToken({ email: 'admin@othercorp.com', hd: 'othercorp.com' }),
    });
    const url = await service.handleGoogleCallback({ state, code: 'auth-code' });
    expect(url).toBe('https://onboarding.capiro.ai/it/error?reason=account');
  });

  it('grants the invite, stores the workspace domain, and flips it_email on success', async () => {
    const { service, inviteUpdate, taskUpdateMany } = makeService(liveInvite(), GOOGLE_ENV);
    const state = await mintGoogleState(service);
    mockTokenResponse({
      access_token: 'at',
      refresh_token: 'must-be-ignored',
      scope: SCOPE_STRING,
      id_token: idToken({ email: 'admin@keeldefense.co', hd: 'keeldefense.co' }),
    });

    const url = await service.handleGoogleCallback({ state, code: 'auth-code' });

    expect(url).toBe('https://onboarding.capiro.ai/it/done');
    expect(inviteUpdate).toHaveBeenCalledTimes(1);
    const updateArg = inviteUpdate.mock.calls[0]![0];
    expect(updateArg.where).toEqual({ id: 'invite-1' });
    // Headline invariant: NO token material is ever persisted on this row.
    expect(Object.keys(updateArg.data).sort()).toEqual([
      'googleWorkspaceDomain',
      'grantedAt',
      'provider',
      'status',
    ]);
    expect(updateArg.data).toMatchObject({
      status: 'granted',
      provider: 'google',
      googleWorkspaceDomain: 'keeldefense.co',
    });
    // Exactly one fetch (the code exchange) — no token revoke call, which would
    // destroy the admin's real user↔client grant.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', task: 'it_email', status: { not: 'done' } },
      }),
    );
  });

  it('accepts a consumer-Gmail grant when the invite itself is on that domain', async () => {
    const { service, inviteUpdate } = makeService(
      liveInvite({ email: 'owner@gmail.com' }),
      GOOGLE_ENV,
    );
    const state = await mintGoogleState(service);
    mockTokenResponse({
      access_token: 'at',
      scope: SCOPE_STRING,
      id_token: idToken({ email: 'owner@gmail.com' }),
    });
    const url = await service.handleGoogleCallback({ state, code: 'auth-code' });
    expect(url).toBe('https://onboarding.capiro.ai/it/done');
    expect(inviteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ googleWorkspaceDomain: null }),
      }),
    );
  });
});

describe('skipGoogleVerification', () => {
  it('marks the invite skipped and flips it_email (not done) to skipped', async () => {
    const { service, inviteUpdate, taskUpdateMany } = makeService(liveInvite(), GOOGLE_ENV);
    const result = await service.skipGoogleVerification(RAW_TOKEN);
    expect(result).toEqual({ ok: true });
    expect(inviteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'invite-1' },
        data: { status: 'skipped', provider: 'google' },
      }),
    );
    expect(taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', task: 'it_email', status: { not: 'done' } },
        data: expect.objectContaining({ status: 'skipped' }),
      }),
    );
  });

  it('does not require Google to be configured (deferring needs no Google credentials)', async () => {
    const { service } = makeService(liveInvite());
    await expect(service.skipGoogleVerification(RAW_TOKEN)).resolves.toEqual({ ok: true });
  });

  it('is a no-op against an already-granted invite (never downgrades a real grant)', async () => {
    const { service, inviteUpdate, taskUpdateMany } = makeService(
      liveInvite({ status: 'granted' }),
      GOOGLE_ENV,
    );
    const result = await service.skipGoogleVerification(RAW_TOKEN);
    expect(result).toEqual({ ok: true });
    expect(inviteUpdate).not.toHaveBeenCalled();
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired invite (findByToken guard applies same as every other action)', async () => {
    const { service } = makeService(liveInvite({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(service.skipGoogleVerification(RAW_TOKEN)).rejects.toThrow();
  });
});
