import {
  GOOGLE_SCOPES,
  GOOGLE_USERINFO_URL,
  GoogleOAuthService,
} from './google/google-oauth.service.js';
import { MicrosoftOAuthService } from './microsoft/microsoft-oauth.service.js';
import { MICROSOFT_SCOPES } from './microsoft/microsoft-oauth-constants.js';

/** The fetch this test file had before any substitution, so the fixture's own
 *  provider stub can leave every other URL on its previous implementation. */
const originalFetch = globalThis.fetch;

export const tenant = '00000000-0000-4000-8000-000000000001';
export const actor = '00000000-0000-4000-8000-000000000002';
export const ctx = { tenantId: tenant, userId: actor } as any;
const encrypt = (value: string) => ({ ciphertext: value, iv: 'fake-iv', authTag: 'fake-tag' });
export const freshToken = (account = 'account-A') => ({
  id: `token-${account}`,
  homeAccountId: account,
  accessTokenCiphertext: `access-${account}`,
  accessTokenIv: 'fake-iv',
  accessTokenAuthTag: 'fake-tag',
  refreshTokenCiphertext: `refresh-${account}`,
  refreshTokenIv: 'fake-iv',
  refreshTokenAuthTag: 'fake-tag',
  expiresAt: new Date(0),
  scopes: MICROSOFT_SCOPES,
});

export function harness(provider: 'microsoft_365' | 'google_workspace' = 'microsoft_365') {
  const rows = new Map<string, any>();
  let active = true;
  rows.set('connection-A', {
    id: 'connection-A',
    tenantId: tenant,
    createdByUserId: actor,
    provider,
    status: 'connected',
    accountEmail: 'a@example.invalid',
    token: freshToken(),
    syncState: {
      mail: { cursor: 'A-cursor', historyId: 'A-history' },
      calendar: { cursor: 'A-calendar' },
    },
  });
  const tx: any = {
    meeting: { count: jest.fn().mockResolvedValue(0) },
    mailThread: { count: jest.fn().mockResolvedValue(0) },
    mailMessage: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const query = sql.join('');
      if (query.includes('clock_timestamp() AS now')) return [{ now: new Date(Date.now()) }];
      if (query.includes('tenant_memberships')) return active ? [{ id: 'member-A' }] : [];
      if (query.includes("sync_state_jsonb->'syncClaim'")) {
        const row = rows.get(String(values[0]));
        return row &&
          row.tenantId === values[1] &&
          ['connected', 'error'].includes(row.status) &&
          row.syncState.syncClaim?.token === values[2] &&
          Date.parse(row.syncState.syncClaim.expiresAt) > Date.now()
          ? [{ id: row.id }]
          : [];
      }
      return [];
    }),
    integrationConnection: {
      findUnique: jest.fn(async ({ where }: any) => structuredClone(rows.get(where.id) ?? null)),
      deleteMany: jest.fn(async ({ where }: any) => ({ count: rows.delete(where.id) ? 1 : 0 })),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        const candidates = [...rows.values()].filter(
          (row) =>
            row.tenantId === where.tenantId &&
            row.createdByUserId === where.createdByUserId &&
            row.provider === where.provider &&
            row.status === where.status &&
            !row.token,
        );
        if (orderBy?.[0]?.createdAt === 'desc') candidates.reverse();
        return candidates.map(({ id }) => ({ id }));
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        if (typeof where.id === 'string') {
          const row = rows.get(where.id);
          return !where.tenantId || row?.tenantId === where.tenantId ? row : null;
        }
        return (
          [...rows.values()].find(
            (row) =>
              row.tenantId === where.tenantId &&
              row.provider === where.provider &&
              row.id !== where.id.not &&
              (row.accountEmail === where.OR[0].accountEmail ||
                row.token?.homeAccountId === where.OR[1].token.is.homeAccountId),
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: `connection-${rows.size + 1}`, token: null };
        rows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row) throw new Error('connection deleted');
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          const row = rows.get(where.id);
          // This harness has one tenant; model the scoped Prisma predicate as
          // well as the explicit row/status filters used by sync-error cleanup.
          if (
            !row ||
            row.tenantId !== tenant ||
            (where.status && !where.status.in.includes(row.status))
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    integrationConnectionToken: {
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const row = rows.get(where.connectionId);
        row.token = row.token ? { ...row.token, ...update } : { id: `new-${row.id}`, ...create };
        return row.token;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.connectionId);
        row.token = { ...row.token, ...data };
        return row.token;
      }),
    },
  };
  const prisma = {
    withTenant: async (tenantId: string, run: any) => {
      if (tenantId !== tenant) throw new Error('Unexpected fixture tenant');
      return run(tx);
    },
  };
  const crypto = {
    isConfigured: () => true,
    encrypt,
    decrypt: ({ ciphertext }: any) => ciphertext,
    getKeyVersion: () => 'fake-v1',
  };
  const service: any = Object.create(
    (provider === 'microsoft_365' ? MicrosoftOAuthService : GoogleOAuthService).prototype,
  );
  Object.assign(service, {
    prisma,
    tokenCrypto: crypto,
    logger: { warn: jest.fn(), error: jest.fn() },
    clientId: 'client',
    clientSecret: 'client-secret',
    tenantId: tenant,
    thumbprint: 'fake',
    privateKey: 'fake',
    stateSecret: Buffer.from('fake-state-secret'),
    redirectUri: 'https://app.invalid/callback',
  });
  service.getMsal = () => ({
    getAuthCodeUrl: async ({ state }: any) => `https://mock.invalid?state=${state}`,
  });
  let returned = {
    id: 'account-A',
    email: 'a@example.invalid',
    refresh: undefined as string | undefined,
  };
  // Models a provider that withholds verification of the returned address.
  let emailVerified = true;
  let afterExchange: (() => void | Promise<void>) | undefined;
  const exchange = jest.fn(async () => {
    await afterExchange?.();
    return returned;
  });
  service.buildMsalClient = () => ({
    acquireTokenByCode: async () => {
      const account = await exchange();
      return {
        accessToken: 'returned-access',
        account: { homeAccountId: account.id, username: account.email },
        scopes: MICROSOFT_SCOPES,
      };
    },
    getTokenCache: () => ({
      serialize: () =>
        JSON.stringify({
          RefreshToken: returned.refresh
            ? { entry: { home_account_id: returned.id, secret: returned.refresh } }
            : {},
        }),
    }),
  });
  service.exchangeCode = async () => {
    const account = await exchange();
    return {
      access_token: 'returned-access',
      refresh_token: account.refresh,
      scope: GOOGLE_SCOPES.join(' '),
      // Google also returns an id_token. Its payload is unsigned text, so it must
      // never influence binding; this decoy is deliberately unmatchable.
      id_token: `decoy.${Buffer.from(
        JSON.stringify({ sub: 'decoy-account', email: 'decoy@example.invalid' }),
      ).toString('base64url')}.decoy`,
    };
  };
  if (provider === 'google_workspace') {
    // Mailbox identity is bound from Google's verified UserInfo lookup, so the
    // bounded provider transport is the one call substituted here: the real request,
    // its claim checks and its refusals all run in these tests. Every other URL keeps
    // whatever implementation was already installed (a spec's own loopback calls).
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        if (String(input) !== GOOGLE_USERINFO_URL) return originalFetch(input, init);
        return new Response(
          JSON.stringify({
            sub: returned.id,
            email: returned.email,
            email_verified: emailVerified,
            name: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
  }
  service.revokeGoogleGrant = jest.fn();
  const start = async (input: any = { connectionId: 'connection-A' }) => {
    const result = await service.start(ctx, input);
    return { ...result, state: new URL(result.authUrl).searchParams.get('state')! };
  };
  const callback = (state: string) => service.handleCallback({ code: 'fake-code', state });
  return {
    rows,
    tx,
    prisma,
    crypto,
    service,
    start,
    callback,
    exchange,
    setActive: (value: boolean) => {
      active = value;
    },
    setReturned: (value: typeof returned) => {
      returned = value;
    },
    setEmailVerified: (value: boolean) => {
      emailVerified = value;
    },
    afterExchange: (hook: () => void | Promise<void>) => {
      afterExchange = hook;
    },
  };
}
