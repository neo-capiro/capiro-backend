import { createHmac } from 'node:crypto';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';

jest.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({ auth: jest.fn() }));

function make() {
  let nonce: string | null = 'one-use';
  const tx = {
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
    const body = Buffer.from(JSON.stringify({
      t: 'tenant', s: 'server', u: 'owner', n: 'one-use', e: Math.floor(Date.now() / 1000) + 600,
      ...overrides,
    })).toString('base64url');
    return body + '.' + createHmac('sha256', 'test-state-secret').update(body).digest('base64url');
  }
  return { service, tx, state };
}

describe('managed OAuth scopes and cancellation state', () => {
  test('Airtable gets all four read scopes from Capiro configuration', () => {
    const { service } = make();
    const provider = service.buildProvider({ id: 'server', tenantId: 'tenant', name: 'meriv3-airtable', catalogId: 'meriv3-airtable' });
    expect(provider.clientMetadata.scope?.split(' ')).toEqual([
      'data.records:read', 'schema.bases:read', 'data.recordComments:read', 'workspacesAndBases:read',
    ]);
  });

  test('Google gets only drive.readonly; HubSpot keeps provider-selected permissions', () => {
    const { service } = make();
    expect(service.buildProvider({ id: 'server', tenantId: 'tenant', name: 'meriv3-google-drive', catalogId: 'meriv3-google-drive' }).clientMetadata.scope)
      .toBe('https://www.googleapis.com/auth/drive.readonly');
    expect(service.buildProvider({ id: 'server', tenantId: 'tenant', name: 'meriv3-hubspot', catalogId: 'meriv3-hubspot' }).clientMetadata.scope)
      .toBeUndefined();
  });

  test('a signed cancellation is one-use and only changes a pending connection', async () => {
    const { service, tx, state } = make();
    const signed = state();
    await expect(service.handleFailure(signed, true)).resolves.toEqual({ tenantId: 'tenant', serverId: 'server' });
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'server', tenantId: 'tenant', connectionStatus: 'pending' },
      data: expect.objectContaining({ connectionStatus: 'error' }),
    }));
    await expect(service.handleFailure(signed, true)).rejects.toThrow('already used');
  });

  test('closing a popup deletes only pending credentials and cannot disconnect an already completed connection', async () => {
    const { service, tx } = make();
    const ctx = { tenantId: 'tenant', userId: 'owner', role: 'standard_user' };
    await service.cancelPending(ctx as never, 'server');
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'server', tenantId: 'tenant', connectionStatus: 'pending' },
      data: { connectionStatus: 'disconnected', lastError: null },
    }));
    expect(tx.clioMcpOAuthCredential.deleteMany).toHaveBeenCalledTimes(1);
    tx.clioMcpServer.updateMany.mockResolvedValue({ count: 0 });
    await service.cancelPending(ctx as never, 'server');
    expect(tx.clioMcpOAuthCredential.deleteMany).toHaveBeenCalledTimes(1);
  });

  test.each(['tampered', 'expired', 'missing expiry'])('%s cancellation state cannot change connection state', async (kind) => {
    const { service, tx, state } = make();
    const signed = kind === 'tampered' ? state() + 'x' : state({ e: kind === 'expired' ? 1 : null });
    await expect(service.handleFailure(signed, true)).rejects.toThrow();
    expect(tx.clioMcpServer.updateMany).not.toHaveBeenCalled();
    expect(tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
  });
});
