import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { DbOAuthClientProvider } from './meri-mcp-oauth.provider.js';
import { managedAppAvailable, MANAGED_MCP_APPS } from './meri-managed-mcp.helpers.js';

const issuer = 'https://auth.monday.com/mcp';
const serverUrl = 'https://mcp.monday.com/mcp';
const callback = 'https://app.capiro.ai/api/clio/mcp-oauth/callback';
const metadata = {
  issuer, authorization_endpoint: 'https://auth.monday.com/oauth2/authorize',
  registration_endpoint: 'https://auth.monday.com/oauth_ms/oauth/register',
  token_endpoint: 'https://auth.monday.com/oauth_ms/oauth/token',
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  authorization_response_iss_parameter_supported: true,
};

function setup() {
  const rows = new Map<string, Record<string, any>>();
  const registrations: Record<string, unknown>[] = [];
  const exchanges: URLSearchParams[] = [];
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = 'header.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.signature';
  const fetchFn = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('oauth-protected-resource'))
      return Response.json({ resource: serverUrl, authorization_servers: [issuer] });
    if (url.includes('.well-known')) return Response.json(metadata);
    if (url === metadata.registration_endpoint) {
      const body = JSON.parse(String(init?.body));
      registrations.push(body);
      // Actual monday DCR response omits grant_types and auth method, and issues a secret.
      return Response.json({ client_id: 'dcr-' + registrations.length, client_secret: 'secret-fixture',
        redirect_uris: body.redirect_uris, client_name: body.client_name }, { status: 201 });
    }
    if (url === metadata.token_endpoint) {
      expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Basic /);
      exchanges.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: accessToken, refresh_token: 'refresh-' + exchanges.length, token_type: 'Bearer' });
    }
    throw new Error('Unexpected test endpoint: ' + url);
  });
  function provider(tenantId: string, expectedIssuer?: string) {
    return new DbOAuthClientProvider({
      prisma: { withTenant: async (tenant: string, fn: (tx: any) => unknown) => fn({
        clioMcpServer: { updateMany: async () => ({ count: 1 }) },
        clioMcpOAuthCredential: {
          findUnique: async () => rows.get(tenant) ?? null,
          upsert: async ({ create, update }: any) => {
            rows.set(tenant, rows.has(tenant) ? { ...rows.get(tenant), ...update } : create);
          },
          updateMany: async ({ data }: any) => {
            if (!rows.has(tenant)) return { count: 0 };
            rows.set(tenant, { ...rows.get(tenant), ...data });
            return { count: 1 };
          },
        },
      }) } as never,
      encryptionKey: Buffer.alloc(32, 7), keyVersion: 'v1', tenantId, serverId: 'personal-server',
      redirectUri: callback, clientName: 'Capiro Meri', signedState: 'signed-state',
      managed: true, tokenExpiryFromJwt: true, expectedIssuer,
    });
  }
  return { rows, registrations, exchanges, fetchFn, provider, exp };
}

describe('monday dynamic client registration', () => {
  test('registers, authorizes with PKCE, exchanges and rotates encrypted per-user tokens', async () => {
    const f = setup();
    const first = f.provider('tenant-one');
    expect(await first.clientInformation()).toBeUndefined();
    await expect(auth(first, { serverUrl, fetchFn: f.fetchFn })).resolves.toBe('REDIRECT');
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0]).toMatchObject({ client_name: 'Capiro Meri', redirect_uris: [callback] });
    const url = first.capturedAuthorizationUrl!;
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(serverUrl);
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(first.authorizationResponseRequirements).toEqual({ issuer, required: true });
    const verifier = await first.codeVerifier();
    const returned = f.provider('tenant-one', issuer);
    await expect(auth(returned, { serverUrl, authorizationCode: 'code-fixture', fetchFn: f.fetchFn })).resolves.toBe('AUTHORIZED');
    expect(f.exchanges[0]!.get('code_verifier')).toBe(verifier);
    expect(f.exchanges[0]!.get('redirect_uri')).toBe(callback);
    expect(f.rows.get('tenant-one')!.tokenExpiresAt).toEqual(new Date(f.exp * 1000));
    expect(JSON.stringify(f.rows.get('tenant-one'))).not.toContain('secret-fixture');
    expect(JSON.stringify(f.rows.get('tenant-one'))).not.toContain('refresh-1');
    await expect(auth(f.provider('tenant-one'), { serverUrl, fetchFn: f.fetchFn })).resolves.toBe('AUTHORIZED');
    expect(f.exchanges[1]!.get('grant_type')).toBe('refresh_token');
    expect(f.exchanges[1]!.get('refresh_token')).toBe('refresh-1');
    expect((await f.provider('tenant-one').tokens())?.refresh_token).toBe('refresh-2');
    expect(await f.provider('tenant-two').tokens()).toBeUndefined();
    expect(await f.provider('tenant-two').clientInformation()).toBeUndefined();
    expect(f.registrations).toHaveLength(1);
  });

  test('rejects issuer discovery drift before sending an authorization code', async () => {
    const f = setup();
    await expect(auth(f.provider('tenant-one', 'https://other.example'), {
      serverUrl, authorizationCode: 'code-fixture', fetchFn: f.fetchFn,
    })).rejects.toThrow('Authorization server changed');
    expect(f.exchanges).toHaveLength(0);
  });

  test('public DCR needs no static credentials, and a canary cannot leak to other identities', () => {
    expect(MANAGED_MCP_APPS.monday.clientIdEnv).toBeUndefined();
    const enabled = { MERI_MCP_MONDAY_ENABLED: 'true' };
    expect(managedAppAvailable('monday', { tenantId: 'customer', userId: 'customer-user' }, enabled)).toBe(true);
    const canary = { ...enabled, MERI_MCP_MONDAY_ALLOWED_USER_IDS: 'neo', MERI_MCP_MONDAY_ALLOWED_TENANT_IDS: 'internal' };
    expect(managedAppAvailable('monday', { tenantId: 'internal', userId: 'neo' }, canary)).toBe(true);
    expect(managedAppAvailable('monday', { tenantId: 'customer', userId: 'neo' }, canary)).toBe(false);
    expect(managedAppAvailable('monday', { tenantId: 'internal', userId: 'other' }, canary)).toBe(false);
    expect(managedAppAvailable('monday', { tenantId: 'internal', userId: 'neo' }, { ...canary, MERI_MCP_MONDAY_ALLOWED_USER_IDS: undefined })).toBe(false);
  });
});
