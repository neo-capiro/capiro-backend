import { DbOAuthClientProvider } from './meri-mcp-oauth.provider.js';
import { decryptSecret } from '../common/secret-crypto.js';

function make(managed = true) {
  const key = Buffer.alloc(32, 7);
  const tx = {
    clioMcpServer: { updateMany: jest.fn(async () => ({ count: 1 })) },
    clioMcpOAuthCredential: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const provider = new DbOAuthClientProvider({
    prisma: {
      withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx),
    } as never,
    encryptionKey: key,
    keyVersion: 'v1',
    tenantId: 'tenant',
    serverId: 'server',
    redirectUri: 'https://os.capiro.ai/api/clio/mcp-oauth/callback',
    clientName: 'Capiro Meri',
    requestedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    managed,
    offlineAccess: true,
  });
  return { provider, tx, key };
}

describe('managed OAuth credential lifecycle', () => {
  test('token storage is encrypted and leaves readiness pending until discovery', async () => {
    const { provider, tx, key } = make();
    await provider.saveTokens({
      access_token: 'access-fixture',
      refresh_token: 'refresh-fixture',
      token_type: 'Bearer',
      scope: 'a b',
      expires_in: 3600,
    });
    const serverCall = tx.clioMcpServer.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(serverCall[0].data).not.toHaveProperty('connectionStatus');
    const call = tx.clioMcpOAuthCredential.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, any> },
    ];
    const data = call[0].data;
    expect(data.scopes).toEqual(['a', 'b']);
    expect(JSON.stringify(data)).not.toContain('access-fixture');
    expect(
      decryptSecret(key, {
        ciphertext: data.accessTokenCiphertext,
        iv: data.accessTokenIv,
        authTag: data.accessTokenAuthTag,
      }),
    ).toBe('access-fixture');
    expect(
      decryptSecret(key, {
        ciphertext: data.refreshTokenCiphertext,
        iv: data.refreshTokenIv,
        authTag: data.refreshTokenAuthTag,
      }),
    ).toBe('refresh-fixture');
  });

  test('a refresh response without a replacement refresh token preserves the existing token', async () => {
    const { provider, tx } = make();
    await provider.saveTokens({ access_token: 'new-access', token_type: 'Bearer', expires_in: 0 });
    const call = tx.clioMcpOAuthCredential.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(call[0].data).not.toHaveProperty('refreshTokenCiphertext');
    expect(call[0].data).not.toHaveProperty('scopes');
    expect(call[0].data.tokenExpiresAt).toBeInstanceOf(Date);
  });

  test('an in-flight refresh cannot resurrect a disconnected server', async () => {
    const { provider, tx } = make();
    tx.clioMcpServer.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      provider.saveTokens({ access_token: 'late', token_type: 'Bearer' }),
    ).rejects.toThrow('no longer active');
    expect(tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
  });

  test('deleted credentials cannot be recreated by token refresh', async () => {
    const { provider, tx } = make();
    tx.clioMcpOAuthCredential.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      provider.saveTokens({ access_token: 'late', token_type: 'Bearer' }),
    ).rejects.toThrow('no longer active');
  });

  test('Google authorization requests consent, offline access and only the read scope', async () => {
    const { provider } = make();
    await provider.redirectToAuthorization(
      new URL('https://accounts.google.com/o/oauth2/v2/auth?code_challenge=pkce'),
    );
    expect(provider.capturedAuthorizationUrl?.searchParams.get('access_type')).toBe('offline');
    expect(provider.capturedAuthorizationUrl?.searchParams.get('prompt')).toBe('consent');
    expect(provider.capturedAuthorizationUrl?.searchParams.get('code_challenge')).toBe('pkce');
    expect(provider.clientMetadata.scope).toBe('https://www.googleapis.com/auth/drive.readonly');
  });
});
