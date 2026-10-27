import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { GoogleOAuthService, GOOGLE_SCOPES } from './google/google-oauth.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { GoogleTokenService } from './google/google-token.service.js';
import { MicrosoftOAuthService } from './microsoft/microsoft-oauth.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { MICROSOFT_SCOPES } from './microsoft/microsoft-oauth-constants.js';

export const NATIVE_MAIL_FLOWS = ['graph', 'gmail-backfill', 'gmail-incremental'] as const;
export type NativeMailFlow = (typeof NATIVE_MAIL_FLOWS)[number];

// These are test-only provider values; no real credential or provider is used.
const cryptoPort = {
  isConfigured: () => true,
  encrypt: (value: string) => ({ ciphertext: value, iv: 'fixture-iv', authTag: 'fixture-tag' }),
  decrypt: ({ ciphertext }: { ciphertext: string }) => ciphertext,
  getKeyVersion: () => 'fixture-v1',
};

/** Only OAuth transport/crypto ports are substituted. State, admission, row locks,
 * token persistence, disconnect and its FK effects execute production code. */
function oauth(
  prisma: PrismaService, flow: NativeMailFlow, accountEmail: string,
): MicrosoftOAuthService | GoogleOAuthService {
  const common = {
    prisma, tokenCrypto: cryptoPort,
    logger: { warn: jest.fn(), error: jest.fn() },
    clientId: 'fixture-client', clientSecret: 'fixture-secret', tenantId: 'fixture-tenant',
    thumbprint: 'fixture-thumbprint', privateKey: 'fixture-private-key',
    stateSecret: Buffer.from('native-mail-collision-fixture-state-secret'),
    redirectUri: 'https://fixture.invalid/callback',
  };
  if (flow === 'graph') {
    return Object.assign(Object.create(MicrosoftOAuthService.prototype) as MicrosoftOAuthService, common, {
      graphSync: { deleteSubscriptionsByTenant: jest.fn().mockResolvedValue(0) },
      getMsal: () => ({
        getAuthCodeUrl: async ({ state }: { state: string }) =>
          `https://fixture.invalid/authorize?state=${encodeURIComponent(state)}`,
      }),
      buildMsalClient: () => ({
        acquireTokenByCode: async () => ({
          accessToken: 'fixture-access',
          account: { homeAccountId: 'same-provider-account', username: accountEmail },
          scopes: MICROSOFT_SCOPES,
          expiresOn: new Date(Date.now() + 3_600_000),
        }),
        getTokenCache: () => ({ serialize: () => JSON.stringify({ RefreshToken: {
          fixture: { home_account_id: 'same-provider-account', secret: 'fixture-refresh' },
        } }) }),
      }),
    });
  }
  return Object.assign(Object.create(GoogleOAuthService.prototype) as GoogleOAuthService, common, {
    revokeGoogleGrant: jest.fn().mockResolvedValue(undefined),
    exchangeCode: async () => ({
      access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
      scope: GOOGLE_SCOPES.join(' '),
    }),
    // Identity now comes from Google's verified UserInfo lookup. This lineage test
    // substitutes that port with the same synthetic account as before; the
    // request/claim contract itself is covered by the OAuth identity spec.
    lookupVerifiedGoogleIdentity: async () => ({
      sub: 'same-provider-account', email: accountEmail, name: null,
    }),
  });
}

function initialState(flow: NativeMailFlow): Prisma.InputJsonObject {
  if (flow === 'graph') return { mail: { captureVersion: 1, folders: {
    inbox: { deltaLink: 'inbox-before', syncMode: 'incremental' },
    sentitems: { deltaLink: 'sent-before', syncMode: 'incremental' },
  } } };
  if (flow === 'gmail-incremental') return { mail: {
    captureVersion: 1, historyId: 'history-before', labels: { ALL: { backfillDone: true } },
  } };
  return { mail: { captureVersion: 1, labels: { ALL: {
    backfillDone: false, backfillPageToken: 'page-before', backfillQuery: 'fixture-query',
  } } } };
}

function graphMessage(id: string, removal: boolean) {
  return removal ? { id, '@removed': { reason: 'deleted' } } : {
    id, conversationId: id === 'old-message' ? 'old-thread' : 'fresh-thread',
    subject: 'Fixture message', bodyPreview: 'Fixture body',
    body: { contentType: 'text', content: 'Fixture body' },
    from: { emailAddress: { address: 'fixture-sender@example.invalid' } },
    receivedDateTime: '2026-10-20T12:00:00.000Z',
  };
}

function gmailMessage(id: string, removal: boolean) {
  return {
    id, threadId: id === 'old-message' ? 'old-thread' : 'fresh-thread',
    labelIds: removal ? ['TRASH'] : ['INBOX'], internalDate: '1792497600000',
    snippet: 'Fixture body', payload: {
      mimeType: 'text/plain', body: { data: Buffer.from('Fixture body').toString('base64url') },
      headers: [
        { name: 'From', value: 'fixture-sender@example.invalid' },
        { name: 'Subject', value: 'Fixture message' },
      ],
    },
  };
}

/** Every persistence/read/transaction port remains real PrismaService. */
function nativeLogger() {
  return { warn: jest.fn((_message: string) => {}), log: jest.fn(), error: jest.fn() };
}

function syncService(
  prisma: PrismaService, flow: NativeMailFlow, removal: boolean,
): { service: MicrosoftGraphSyncService | GoogleSyncService; logger: ReturnType<typeof nativeLogger> } {
  const logger = nativeLogger();
  const common = {
    prisma, logger, tokenCrypto: cryptoPort,
    // Association scoring is outside this mailbox-lineage test; the message is
    // deliberately owner-scoped and unassociated. No authorization is replaced.
    association: { associate: jest.fn().mockResolvedValue({
      clientId: null, score: 0, reason: null, signals: {},
    }) },
  };
  if (flow === 'graph') {
    const service = Object.assign(
      Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService, common, {
        listSyncableMailFolders: jest.fn().mockResolvedValue({
          folders: [], enumerated: true, coverageComplete: true,
        }),
        graphGet: jest.fn(async (url: string) => {
          if (url === 'inbox-before') return {
            value: [graphMessage('old-message', removal), graphMessage('fresh-message', false)],
            '@odata.deltaLink': 'inbox-after',
          };
          if (url === 'sent-before') return { value: [], '@odata.deltaLink': 'sent-after' };
          throw new Error('Unexpected fixture Graph request');
        }),
      },
    );
    return { service, logger };
  }
  const googleToken = Object.assign(Object.create(GoogleTokenService.prototype) as GoogleTokenService, {
    prisma, tokenCrypto: cryptoPort,
  });
  const service = Object.assign(Object.create(GoogleSyncService.prototype) as GoogleSyncService, common, {
    googleToken,
    gmailGet: jest.fn(async (_token: string, id: string) =>
      gmailMessage(id, id === 'old-message' && removal)),
    gmailList: jest.fn().mockResolvedValue({
      messages: [{ id: 'old-message' }, { id: 'fresh-message' }],
    }),
    gmailProfile: jest.fn().mockResolvedValue({ historyId: 'history-after' }),
    gmailHistory: jest.fn().mockResolvedValue({ historyId: 'history-after', history: [
      removal ? { messagesDeleted: [{ message: { id: 'old-message' } }] }
        : { messagesAdded: [{ message: { id: 'old-message' } }] },
      { messagesAdded: [{ message: { id: 'fresh-message' } }] },
    ] }),
  });
  return { service, logger };
}

export async function createNativeMailScenario(
  prisma: PrismaService, flow: NativeMailFlow, removal: boolean,
) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const oldConnectionId = randomUUID();
  const accountEmail = `mailbox-${tenantId}@example.invalid`;
  const provider = flow === 'graph' ? 'microsoft_365' : 'google_workspace';
  const source = flow === 'graph' ? 'outlook' : 'google';
  const scopes = flow === 'graph' ? MICROSOFT_SCOPES : GOOGLE_SCOPES;
  const ctx: TenantContext = {
    tenantId, userId, tenantSlug: `mail-${tenantId}`,
    clerkUserId: `fixture-${userId}`, role: 'standard_user',
  };
  const old = await prisma.withSystem(async (tx) => {
    await tx.tenant.create({ data: { id: tenantId, slug: ctx.tenantSlug, name: 'Disposable mail', status: 'active' } });
    await tx.user.create({ data: { id: userId, clerkUserId: ctx.clerkUserId, email: accountEmail } });
    await tx.tenantMembership.create({ data: { tenantId, userId, role: 'standard_user', status: 'active' } });
    await tx.integrationConnection.create({ data: {
      id: oldConnectionId, tenantId, provider, accountEmail,
      createdByUserId: userId, status: 'connected', scopes,
      token: { create: {
        tenantId, accessTokenCiphertext: 'old-fixture-access', accessTokenIv: 'fixture-iv',
        accessTokenAuthTag: 'fixture-tag', refreshTokenCiphertext: 'old-fixture-refresh',
        refreshTokenIv: 'fixture-iv', refreshTokenAuthTag: 'fixture-tag', keyVersion: 'fixture-v1',
        scopes, homeAccountId: 'same-provider-account', expiresAt: new Date(Date.now() + 3_600_000),
      } },
    } });
    const thread = await tx.mailThread.create({ data: {
      tenantId, connectionId: oldConnectionId, source, externalId: 'old-thread',
      subject: 'Retained old subject', snippet: 'Retained old snippet', metadata: { retained: true },
    } });
    const message = await tx.mailMessage.create({ data: {
      tenantId, threadId: thread.id, connectionId: oldConnectionId, source, externalId: 'old-message',
      subject: 'Retained old subject', bodyText: 'Retained old body', metadata: { retained: true },
    } });
    return { thread, message };
  });
  const readOld = () => prisma.withTenant(tenantId, async (tx) => ({
    thread: await tx.mailThread.findUniqueOrThrow({ where: { id: old.thread.id } }),
    message: await tx.mailMessage.findUniqueOrThrow({ where: { id: old.message.id } }),
  }));
  const oauthService = oauth(prisma, flow, accountEmail);
  await oauthService.disconnect(ctx, oldConnectionId);
  const afterDisconnect = await readOld();
  const started = await oauthService.start(ctx, {});
  const state = new URL(started.authUrl).searchParams.get('state');
  if (!state) throw new Error('Fixture OAuth did not return signed state');
  await oauthService.handleCallback({ code: 'fixture-code', state });
  // Model an already-established provider cursor on the new connection. The
  // actual re-add used production start/callback; cursor contents are fixtures.
  await prisma.withTenant(tenantId, (tx) => tx.integrationConnection.update({
    where: { id: started.connectionId }, data: { syncState: initialState(flow) },
  }));
  const { service, logger } = syncService(prisma, flow, removal);
  return {
    old, afterDisconnect, oldConnectionId, connectionId: started.connectionId, tenantId, source, logger,
    run: () => service.syncConnectionByTenant(tenantId, started.connectionId, { calendar: false, mail: true }),
    readOld,
    readResult: () => prisma.withTenant(tenantId, async (tx) => ({
      connection: await tx.integrationConnection.findUniqueOrThrow({ where: { id: started.connectionId }, include: { token: true } }),
      deletedConnection: await tx.integrationConnection.findUnique({ where: { id: oldConnectionId } }),
      fresh: await tx.mailMessage.findUniqueOrThrow({ where: {
        tenantId_source_externalId: { tenantId, source, externalId: 'fresh-message' },
      }, include: { thread: true } }),
      messages: await tx.mailMessage.count({ where: { tenantId } }),
      threads: await tx.mailThread.count({ where: { tenantId } }),
    })),
  };
}
