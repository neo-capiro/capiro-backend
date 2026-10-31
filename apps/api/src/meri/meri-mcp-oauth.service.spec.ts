import { createHmac } from 'node:crypto';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({ auth: jest.fn() }));

function make() {
  let nonce: string | null = 'one-use';
  const tx = {
    tenant: { findUnique: jest.fn(async () => ({ slug: 'other-firm', settings: { clioFeatureFlags: { 'notetaker.krisp.enabled': true } } })) },
    clioMcpOAuthCredential: {
      deleteMany: jest.fn(async () => ({ count: 1 })),
      updateMany: jest.fn(async ({ where }: { where: { stateNonce: string } }) => {
        if (where.stateNonce !== nonce) return { count: 0 };
        nonce = null;
        return { count: 1 };
      }),
    },
    clioMcpServer: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => ({ id: 'server', scope: 'user', ownerUserId: 'owner' })),
    },
  };
  const values: Record<string, unknown> = {
    CLIO_MCP_ENABLED: true,
    CLIO_MCP_OAUTH_REDIRECT_URI: 'https://os.capiro.ai/api/clio/mcp-oauth/callback',
    OAUTH_STATE_SECRET: 'test-state-secret',
    OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('hex'),
    OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
  };
  const service = new MeriMcpOAuthService(
    { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) } as never,
    { get: (key: string) => values[key] } as never,
  );
  function state(overrides: Record<string, unknown> = {}) {
    const body = Buffer.from(
      JSON.stringify({
        t: 'tenant',
        s: 'server',
        u: 'owner',
        n: 'one-use',
        e: Math.floor(Date.now() / 1000) + 600,
        ...overrides,
      }),
    ).toString('base64url');
    return body + '.' + createHmac('sha256', 'test-state-secret').update(body).digest('base64url');
  }
  return { service, tx, state, values };
}

describe('managed OAuth scopes and cancellation state', () => {
  test.each([undefined, 'https://wrong.example'])(
    'rejects missing or mismatched required issuer (%s) before code exchange',
    async (issuer) => {
      const { service, tx, state } = make();
      const signed = state({ i: 'https://auth.monday.com/mcp', ir: true });
      await expect(service.handleCallback({ code: 'code', state: signed, issuer })).rejects.toThrow(
        'issuer',
      );
      await expect(service.handleFailure(signed, true, issuer)).rejects.toThrow('issuer');
      expect(tx.clioMcpServer.findFirst).not.toHaveBeenCalled();
      expect(tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
    },
  );

  test.each(['owner', 'tenant'])(
    'Google rejects a revoked %s before OAuth start or callback exchange',
    async (kind) => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        MERI_MCP_GOOGLE_DRIVE_ENABLED: 'true',
        MERI_MCP_GOOGLE_DRIVE_CLIENT_ID: 'id',
        MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: 'secret',
        MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS: kind === 'owner' ? 'someone-else' : 'owner',
        MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS: kind === 'tenant' ? 'somewhere-else' : 'tenant',
      };
      try {
        jest.mocked(auth).mockClear();
        const { service, tx, state } = make();
        tx.clioMcpServer.findFirst.mockResolvedValue({
          id: 'server',
          scope: 'user',
          ownerUserId: 'owner',
          name: 'meriv3-google-drive',
          catalogId: 'meriv3-google-drive',
          enabled: true,
          endpoint: 'https://drivemcp.googleapis.com/mcp/v1',
          authType: 'oauth',
        } as never);
        await expect(
          service.start({ tenantId: 'tenant', userId: 'owner' } as never, 'server'),
        ).rejects.toThrow('unavailable');
        await expect(service.handleCallback({ code: 'code', state: state() })).rejects.toThrow(
          'unavailable',
        );
        expect(auth).not.toHaveBeenCalled();
        expect(tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
      } finally {
        process.env = originalEnv;
      }
    },
  );
  test('Airtable gets all four read scopes from Capiro configuration', () => {
    const { service } = make();
    const provider = service.buildProvider({
      id: 'server',
      tenantId: 'tenant',
      name: 'meriv3-airtable',
      catalogId: 'meriv3-airtable',
    });
    expect(provider.clientMetadata.scope?.split(' ')).toEqual([
      'data.records:read',
      'schema.bases:read',
      'data.recordComments:read',
      'workspacesAndBases:read',
    ]);
  });

  test('Google gets only drive.readonly; HubSpot keeps provider-selected permissions', () => {
    const { service } = make();
    expect(
      service.buildProvider({
        id: 'server',
        tenantId: 'tenant',
        name: 'meriv3-google-drive',
        catalogId: 'meriv3-google-drive',
      }).clientMetadata.scope,
    ).toBe('https://www.googleapis.com/auth/drive.readonly');
    expect(
      service.buildProvider({
        id: 'server',
        tenantId: 'tenant',
        name: 'meriv3-hubspot',
        catalogId: 'meriv3-hubspot',
      }).clientMetadata.scope,
    ).toBeUndefined();
  });

  test('a signed cancellation is one-use and only changes a pending connection', async () => {
    const { service, tx, state } = make();
    const signed = state();
    await expect(service.handleFailure(signed, true)).resolves.toEqual({
      tenantId: 'tenant',
      serverId: 'server',
    });
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'server', tenantId: 'tenant', connectionStatus: 'pending' },
        data: expect.objectContaining({ connectionStatus: 'error' }),
      }),
    );
    await expect(service.handleFailure(signed, true)).rejects.toThrow('already used');
  });

  test('closing a popup deletes only pending credentials and cannot disconnect an already completed connection', async () => {
    const { service, tx } = make();
    const ctx = { tenantId: 'tenant', userId: 'owner', role: 'standard_user' };
    await service.cancelPending(ctx as never, 'server');
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'server', tenantId: 'tenant', connectionStatus: 'pending' },
        data: { connectionStatus: 'disconnected', lastError: null },
      }),
    );
    expect(tx.clioMcpOAuthCredential.deleteMany).toHaveBeenCalledTimes(1);
    tx.clioMcpServer.updateMany.mockResolvedValue({ count: 0 });
    await service.cancelPending(ctx as never, 'server');
    expect(tx.clioMcpOAuthCredential.deleteMany).toHaveBeenCalledTimes(1);
  });

  test.each(['tampered', 'expired', 'missing expiry'])(
    '%s cancellation state cannot change connection state',
    async (kind) => {
      const { service, tx, state } = make();
      const signed =
        kind === 'tampered' ? state() + 'x' : state({ e: kind === 'expired' ? 1 : null });
      await expect(service.handleFailure(signed, true)).rejects.toThrow();
      expect(tx.clioMcpServer.updateMany).not.toHaveBeenCalled();
      expect(tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
    },
  );
});

describe('generic catalog OAuth current authority', () => {
  beforeEach(() => jest.mocked(auth).mockClear().mockResolvedValue('AUTHORIZED'));
  function generic() {
    const result = make();
    const row = { id: 'server', name: 'notion', scope: 'user', ownerUserId: 'owner',
      catalogId: 'notion', endpoint: 'https://mcp.notion.com/mcp', authType: 'oauth', enabled: true,
      connectionStatus: 'disconnected', updatedAt: new Date('2026-10-31T00:00:00Z') };
    result.tx.clioMcpServer.findFirst.mockResolvedValue(row);
    return { ...result, row };
  }

  test.each(['disabled connection', 'disabled feature', 'foreign owner', 'expired state'])(
    '%s refuses a callback before token exchange', async (change) => {
      const { service, tx, state, values, row } = generic();
      if (change === 'disabled connection') row.enabled = false;
      if (change === 'disabled feature') values.CLIO_MCP_ENABLED = false;
      if (change === 'foreign owner') row.ownerUserId = 'other';
      await expect(service.handleCallback({ code: 'fixture', state: state(change === 'expired state' ? { e: 1 } : {}) })).rejects.toThrow();
      expect(auth).not.toHaveBeenCalled();
      expect(tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
    },
  );

  test('a current personal callback still exchanges once and refuses replay', async () => {
    const { service, state } = generic();
    const signed = state();
    await expect(service.handleCallback({ code: 'fixture', state: signed })).resolves.toMatchObject({ serverId: 'server' });
    await expect(service.handleCallback({ code: 'fixture', state: signed })).rejects.toThrow('already used');
    expect(auth).toHaveBeenCalledTimes(1);
  });

  test('a disabled generic connection cannot start authorization', async () => {
    const { service, tx, row } = generic();
    row.enabled = false;
    await expect(service.start({ tenantId: 'tenant', userId: 'owner', role: 'standard_user' } as never, 'server')).rejects.toThrow('unavailable');
    expect(auth).not.toHaveBeenCalled();
    expect(tx.clioMcpServer.updateMany).not.toHaveBeenCalled();
  });

  test('valid tokens on a no-redirect start leave readiness pending for the receiver', async () => {
    const { service, tx, row } = generic();
    await expect(service.start({ tenantId: 'tenant', userId: 'owner' } as never, 'server'))
      .resolves.toEqual({ authUrl: null, alreadyConnected: true });
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith({
      where: { id: 'server', tenantId: 'tenant', enabled: true,
        connectionStatus: 'disconnected', updatedAt: row.updatedAt },
      data: { connectionStatus: 'pending', lastError: null },
    });
  });

  test.each(['disconnect', 'another start'])('a concurrent %s wins over the admitted start snapshot', async () => {
    const { service, tx } = generic();
    tx.clioMcpServer.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.start({ tenantId: 'tenant', userId: 'owner' } as never, 'server'))
      .rejects.toThrow('no longer active');
    expect(auth).not.toHaveBeenCalled();
  });

  test('REDIRECT without an authorization URL cannot report already connected', async () => {
    const { service, tx } = generic();
    jest.mocked(auth).mockResolvedValue('REDIRECT');
    await expect(service.start({ tenantId: 'tenant', userId: 'owner' } as never, 'server'))
      .rejects.toThrow('Sign-in did not complete');
    expect(tx.clioMcpServer.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { connectionStatus: 'error', lastError: 'Sign-in did not complete.' },
    }));
  });

  test('interactive authorization still returns a signed redirect and stores its nonce', async () => {
    const { service, tx } = generic();
    tx.clioMcpOAuthCredential.updateMany.mockResolvedValue({ count: 1 });
    jest.mocked(auth).mockImplementation(async (provider) => {
      await provider.redirectToAuthorization(new URL('https://auth.example/authorize'));
      return 'REDIRECT';
    });
    const result = await service.start({ tenantId: 'tenant', userId: 'owner' } as never, 'server');
    expect(result.alreadyConnected).not.toBe(true);
    expect(new URL(result.authUrl!).searchParams.get('state')).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(tx.clioMcpOAuthCredential.updateMany).toHaveBeenCalledWith({
      where: { serverId: 'server' }, data: { stateNonce: expect.any(String) },
    });
  });

  test.each(['start', 'callback'])('%s sanitizes provider error status and logs', async (leg) => {
    const { service, tx, state } = generic();
    const sentinel = 'SYNTHETIC_PRIVATE_PROVIDER_ERROR';
    jest.mocked(auth).mockRejectedValue(new Error(sentinel));
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    try {
      if (leg === 'start') {
        await expect(service.start({ tenantId: 'tenant', userId: 'owner' } as never, 'server'))
          .rejects.toThrow('Sign-in could not start');
      } else {
        await expect(service.handleCallback({ code: 'fixture', state: state() }))
          .rejects.toThrow('Sign-in did not complete');
      }
      expect(JSON.stringify(tx.clioMcpServer.updateMany.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[server server]'));
    } finally { warn.mockRestore(); }
  });
});


describe('Krisp OAuth tenant flag', () => {
  test('Krisp requests confidential registration and read-only scopes', () => {
    const { service } = make();
    const provider = service.buildProvider({ id: 'server', tenantId: 'tenant', name: 'Krisp', catalogId: 'meriv3-krisp' });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
    expect(provider.clientMetadata.scope).toContain('user::meetings:transcripts::read');
    expect(provider.clientMetadata.scope).not.toMatch(/write|import/);
  });
  test('any enabled tenant can exchange a Krisp OAuth callback', async () => {
    const { service, tx, state } = make();
    tx.clioMcpServer.findFirst.mockResolvedValue({ id: 'server', scope: 'user', ownerUserId: 'owner',
      name: 'meriv3-krisp', catalogId: 'meriv3-krisp', endpoint: 'https://mcp.krisp.ai/mcp', authType: 'oauth', enabled: true } as never);
    jest.mocked(auth).mockClear().mockResolvedValue('AUTHORIZED');
    await service.handleCallback({ code: 'code', state: state() });
    expect(auth).toHaveBeenCalledTimes(1);
  });
  test('a disabled tenant cannot exchange a Krisp OAuth callback', async () => {
    const { service, tx, state } = make();
    tx.tenant.findUnique.mockResolvedValue({ slug: 'other-firm', settings: { clioFeatureFlags: { 'notetaker.krisp.enabled': false } } });
    tx.clioMcpServer.findFirst.mockResolvedValue({ id: 'server', scope: 'user', ownerUserId: 'owner',
      name: 'meriv3-krisp', catalogId: 'meriv3-krisp', endpoint: 'https://mcp.krisp.ai/mcp', authType: 'oauth', enabled: true } as never);
    jest.mocked(auth).mockClear();
    await expect(service.handleCallback({ code: 'code', state: state() })).rejects.toThrow('not enabled');
    expect(auth).not.toHaveBeenCalled();
  });
});
