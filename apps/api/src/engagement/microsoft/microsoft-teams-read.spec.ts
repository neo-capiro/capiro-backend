import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { createHash } from 'node:crypto';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { MICROSOFT_SCOPES } from './microsoft-oauth-constants.js';
import { TEAMS_READ_INPUT_SCHEMAS } from './microsoft-teams-contract.js';
import { guardMicrosoftGraphSyncService } from '../runtime/engagement-integration-runtime.boundary.js';
import type { EngagementRuntimePolicyService } from '../runtime/engagement-runtime-policy.service.js';

const id = (n: number) => `75000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-user',
  role: 'standard_user',
} as TenantContext;
const input = { connectionId: id(3), teamId: id(4) };
const channelId = '19:synthetic@thread.tacv2';
const channel = {
  id: channelId,
  displayName: 'Synthetic channel',
  description: null,
  membershipType: 'private',
};
const message = {
  id: '123456789',
  replyToId: null,
  etag: 'revision-1',
  subject: null,
  createdDateTime: '2026-10-26T10:00:00Z',
  lastModifiedDateTime: '2026-10-26T10:01:00Z',
  deletedDateTime: null,
  body: { contentType: 'html', content: '<p>Synthetic message</p>' },
  from: { user: { id: id(2), displayName: 'Synthetic actor' } },
  attachments: [{ content: 'not part of this read' }],
  replies: [{ id: 'not included' }],
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

function fixture() {
  let active = true;
  const token = {
    id: id(5),
    tenantId: ctx.tenantId,
    connectionId: input.connectionId,
    homeAccountId: 'synthetic.home',
    accessTokenCiphertext: 'synthetic-access',
    accessTokenIv: 'iv',
    accessTokenAuthTag: 'tag',
    refreshTokenCiphertext: 'synthetic-refresh',
    refreshTokenIv: 'iv',
    refreshTokenAuthTag: 'tag',
    scopes: [...MICROSOFT_SCOPES, 'Channel.ReadBasic.All', 'ChannelMessage.Read.All'],
    expiresAt: new Date(Date.now() + 3600000),
  };
  const connection = {
    id: input.connectionId,
    tenantId: ctx.tenantId,
    createdByUserId: ctx.userId,
    provider: 'microsoft_365',
    status: 'connected',
    token,
    scopes: [...token.scopes],
    syncState: {},
  };
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('tenant_memberships') ? (active ? [{ id: id(6) }] : []) : [],
    ),
    integrationConnection: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
        where.id === connection.id && where.tenantId === connection.tenantId
          ? structuredClone(connection)
          : null,
      ),
      findUnique: jest.fn(async () => structuredClone(connection)),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (tenantId: string, run: (value: typeof tx) => unknown) => {
      expect(tenantId).toBe(ctx.tenantId);
      return run(tx);
    }),
  };
  const decrypt = jest.fn(({ ciphertext }: { ciphertext: string }) => ciphertext);
  const service = Object.assign(Object.create(MicrosoftGraphSyncService.prototype), {
    prisma,
    tokenCrypto: { decrypt },
  }) as MicrosoftGraphSyncService;
  const fetcher = jest
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ value: [channel] }), { status: 200 }));
  globalThis.fetch = fetcher;
  return {
    service,
    prisma,
    connection,
    token,
    tx,
    decrypt,
    fetcher,
    revoke: () => {
      active = false;
    },
  };
}

describe('fixed Teams reads through the Microsoft connection owner', () => {
  test('authorized channels have exact source evidence and no content outside the selected projection', async () => {
    const f = fixture();
    const result = await f.service.readTeams(ctx, 'list_teams_channels', input);
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') throw new Error('Expected page');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.data).toEqual(channel);
    expect(result.items[0]!.source).toEqual({
      resource: `/teams/${input.teamId}/channels/${encodeURIComponent(channelId)}`,
      revision: null,
      contentSha256: createHash('sha256').update(JSON.stringify(channel)).digest('hex'),
    });
    expect(result).toMatchObject({
      coverage: 'channels',
      incomplete: false,
      omittedItems: 0,
      nextContinuation: null,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls[0]![0]).toBe(
      `https://graph.microsoft.com/v1.0/teams/${input.teamId}/channels?$select=id,displayName,description,membershipType`,
    );
    expect(f.fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
    expect(TEAMS_READ_INPUT_SCHEMAS.list_teams_channels.required).toEqual([
      'connectionId',
      'teamId',
    ]);
  });

  test('message history follows only the same resource continuation and never claims replies or attachments', async () => {
    const f = fixture();
    const path = `https://graph.microsoft.com/v1.0/teams/${input.teamId}/channels/${channelId}/messages`;
    const next = path + '?$skiptoken=opaque%2Btoken&$top=50';
    f.fetcher
      .mockReset()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [message], '@odata.nextLink': next })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
    const first = await f.service.readTeams(ctx, 'get_teams_channel_messages', {
      ...input,
      channelId,
    });
    if (first.kind !== 'page') throw new Error('Expected page');
    expect(first).toMatchObject({
      coverage: 'root_messages_only',
      repliesIncluded: false,
      attachmentsIncluded: false,
      nextContinuation: next,
      incomplete: false,
    });
    expect(first.items[0]!.data).not.toHaveProperty('attachments');
    expect(first.items[0]!.data).not.toHaveProperty('replies');
    expect(first.items[0]!.source.revision).toBe('revision-1');
    expect(first.items[0]!.data).toMatchObject({ body: message.body });
    const second = await f.service.readTeams(ctx, 'get_teams_channel_messages', {
      ...input,
      channelId,
      continuation: first.nextContinuation,
    });
    expect(second).toMatchObject({
      kind: 'page',
      items: [],
      incomplete: false,
      nextContinuation: null,
    });
    expect(f.fetcher.mock.calls[1]![0]).toBe(next);
  });

  test('malformed or duplicate provider items produce explicit partial coverage', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response(JSON.stringify({ value: [channel, { id: 'missing fields' }, channel] })),
    );
    expect(await f.service.readTeams(ctx, 'list_teams_channels', input)).toMatchObject({
      kind: 'page',
      incomplete: true,
      omittedItems: 2,
      items: [expect.objectContaining({ id: channelId })],
    });
  });

  test('a requested scope catalog cannot substitute for an actual grant', async () => {
    const f = fixture();
    f.token.scopes = [...MICROSOFT_SCOPES];
    expect(await f.service.readTeams(ctx, 'list_teams_channels', input)).toEqual({
      kind: 'unavailable',
      operation: 'list_teams_channels',
      reason: 'permission_required',
      requiredPermission: 'Channel.ReadBasic.All',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  test('existing full-URI delegated grants are recognized', async () => {
    const f = fixture();
    f.token.scopes = [...MICROSOFT_SCOPES, 'https://graph.microsoft.com/Channel.ReadBasic.All'];
    expect(await f.service.readTeams(ctx, 'list_teams_channels', input)).toMatchObject({
      kind: 'page',
    });
  });

  test('Teams cannot use refresh to add a missing existing Outlook grant', async () => {
    const f = fixture();
    f.token.expiresAt = new Date(0);
    f.token.scopes = ['Channel.ReadBasic.All'];
    expect(await f.service.readTeams(ctx, 'list_teams_channels', input)).toMatchObject({
      kind: 'unavailable',
      reason: 'reconnect_required',
    });
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test('a foreign tenant token cannot be used through an owned connection', async () => {
    const f = fixture();
    f.token.tenantId = id(9);
    await expect(f.service.readTeams(ctx, 'list_teams_channels', input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test.each(['disconnected', 'needs_configuration'])(
    'connection %s never reaches Graph',
    async (status) => {
      const f = fixture();
      f.connection.status = status;
      expect(await f.service.readTeams(ctx, 'list_teams_channels', input)).toMatchObject({
        kind: 'unavailable',
        reason: 'disconnected',
      });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  test('unmapped selected-client scope is explicitly unavailable with zero provider reads', async () => {
    const f = fixture();
    expect(
      await f.service.readTeams(ctx, 'list_teams_channels', { ...input, clientId: id(9) }),
    ).toMatchObject({ kind: 'unavailable', reason: 'client_scope_unavailable' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test.each(['tenantId', 'createdByUserId'])(
    'another %s cannot select this connection',
    async (key) => {
      const f = fixture();
      f.connection[key as 'tenantId' | 'createdByUserId'] = id(9);
      await expect(f.service.readTeams(ctx, 'list_teams_channels', input)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  test('revoked membership is checked before provider work', async () => {
    const f = fixture();
    f.revoke();
    await expect(f.service.readTeams(ctx, 'list_teams_channels', input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test('revocation while Graph is in flight prevents releasing its content', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => {
      f.revoke();
      return new Response(JSON.stringify({ value: [channel] }));
    });
    await expect(f.service.readTeams(ctx, 'list_teams_channels', input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test.each(['disconnect', 'reconnect', 'permission'])(
    '%s while Graph is in flight withholds the page',
    async (change) => {
      const f = fixture();
      f.fetcher.mockImplementation(async () => {
        if (change === 'disconnect') f.connection.status = 'disconnected';
        if (change === 'reconnect') f.token.homeAccountId = 'new.synthetic.account';
        if (change === 'permission') f.token.scopes = [...MICROSOFT_SCOPES];
        return new Response(JSON.stringify({ value: [channel] }));
      });
      const result = await f.service.readTeams(ctx, 'list_teams_channels', input);
      expect(result).toMatchObject({
        kind: 'unavailable',
        reason:
          change === 'disconnect'
            ? 'disconnected'
            : change === 'permission'
              ? 'permission_required'
              : 'source_changed',
      });
      expect(result).not.toHaveProperty('items');
    },
  );

  test.each([
    'https://example.invalid/v1.0/teams/x/channels?$skiptoken=x',
    `https://graph.microsoft.com/v1.0/teams/${id(9)}/channels?$skiptoken=x`,
    `https://graph.microsoft.com/v1.0/teams/${input.teamId}/channels?$skiptoken=x&$expand=members`,
  ])('a foreign or expanded continuation is refused before token access', async (continuation) => {
    const f = fixture();
    await expect(
      f.service.readTeams(ctx, 'list_teams_channels', { ...input, continuation }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
  });

  test('malformed provider continuation never becomes a fetch capability or a false completed page', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({ value: [channel], '@odata.nextLink': 'https://example.invalid/secret' }),
      ),
    );
    expect(await f.service.readTeams(ctx, 'list_teams_channels', input)).toMatchObject({
      kind: 'unavailable',
      reason: 'invalid_provider_response',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  test.each<[number, string]>([
    [401, 'reconnect_required'],
    [403, 'permission_required'],
    [404, 'provider_unavailable'],
    [429, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('Graph %s is truthful and excludes raw provider error content', async (status, reason) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response('private-provider-error', { status }));
    const result = await f.service.readTeams(ctx, 'list_teams_channels', input);
    expect(result).toMatchObject({ kind: 'unavailable', reason });
    expect(JSON.stringify(result)).not.toContain('private-provider-error');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  test.each([true, false])(
    'refresh retains only actual grants; returned Teams grant present=%s',
    async (retainsGrant) => {
      const f = fixture();
      f.token.expiresAt = new Date(0);
      const privateService = f.service as unknown as Record<string, unknown>;
      const acquire = jest.fn(async () => ({
        accessToken: 'refreshed',
        scopes: [...MICROSOFT_SCOPES, ...(retainsGrant ? ['Channel.ReadBasic.All'] : [])],
        account: { homeAccountId: f.token.homeAccountId },
      }));
      privateService.assertTokenRefreshConfigured = () => {};
      privateService.buildMsalClient = () => ({ acquireTokenByRefreshToken: acquire });
      privateService.persistRefreshedAccessToken = async (
        _tenant: unknown,
        _connection: unknown,
        result: { accessToken: string; scopes: string[] },
      ) => {
        f.token.accessTokenCiphertext = result.accessToken;
        f.token.scopes = result.scopes;
        f.token.expiresAt = new Date(Date.now() + 3600000);
      };
      expect(await f.service.readTeams(ctx, 'list_teams_channels', input)).toMatchObject({
        kind: retainsGrant ? 'page' : 'unavailable',
        ...(!retainsGrant ? { reason: 'permission_required' } : {}),
      });
      expect(acquire).toHaveBeenCalledWith({
        refreshToken: 'synthetic-refresh',
        scopes: [...MICROSOFT_SCOPES, 'Channel.ReadBasic.All'],
      });
      expect(MICROSOFT_SCOPES).not.toContain('Channel.ReadBasic.All');
      if (retainsGrant)
        expect(f.fetcher.mock.calls[0]![1]).toMatchObject({
          headers: expect.objectContaining({ Authorization: 'Bearer refreshed' }),
        });
      else expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  test('runtime-held integration mode blocks Teams before the existing owner executes', async () => {
    const f = fixture();
    const policy = {
      assertExternalAction: jest.fn(() => {
        throw new ServiceUnavailableException('held');
      }),
    };
    const guarded = guardMicrosoftGraphSyncService(
      f.service,
      policy as unknown as EngagementRuntimePolicyService,
    );
    expect(() => guarded.readTeams(ctx, 'list_teams_channels', input)).toThrow('held');
    expect(policy.assertExternalAction).toHaveBeenCalledWith('integration_sync', {
      testMode: false,
    });
    expect(f.prisma.withTenant).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
