import {
  BadGatewayException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  XFeedService,
  normalizeCachedMedia,
  normalizeCachedMetrics,
  normalizeHandle,
  type XPostDTO,
} from './x-feed.service.js';

const originalToken = process.env.X_API_BEARER_TOKEN;

afterEach(() => {
  jest.restoreAllMocks();
  if (originalToken === undefined) {
    delete process.env.X_API_BEARER_TOKEN;
  } else {
    process.env.X_API_BEARER_TOKEN = originalToken;
  }
});

describe('normalizeHandle', () => {
  it('accepts a plain username', () => {
    expect(normalizeHandle('DeptofDefense')).toBe('DeptofDefense');
  });

  it('strips a leading @', () => {
    expect(normalizeHandle('@DeptofDefense')).toBe('DeptofDefense');
  });

  it('strips multiple leading @', () => {
    expect(normalizeHandle('@@@DeptofDefense')).toBe('DeptofDefense');
  });

  it('extracts from an x.com URL', () => {
    expect(normalizeHandle('https://x.com/DeptofDefense')).toBe('DeptofDefense');
  });

  it('extracts from a twitter.com URL', () => {
    expect(normalizeHandle('https://twitter.com/DeptofDefense')).toBe('DeptofDefense');
  });

  it('extracts from an x.com URL with path suffix', () => {
    expect(normalizeHandle('https://x.com/DeptofDefense/status/123')).toBe('DeptofDefense');
  });

  it('extracts from www prefix', () => {
    expect(normalizeHandle('https://www.x.com/HASCDemocrats')).toBe('HASCDemocrats');
  });

  it('trims whitespace', () => {
    expect(normalizeHandle('  DeptofDefense  ')).toBe('DeptofDefense');
  });

  it('rejects empty input', () => {
    expect(normalizeHandle('')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(normalizeHandle('   ')).toBeNull();
  });

  it('rejects handles longer than 15 characters', () => {
    expect(normalizeHandle('ThisHandleIsTooLong123')).toBeNull();
  });

  it('rejects handles with special characters', () => {
    expect(normalizeHandle('handle!')).toBeNull();
    expect(normalizeHandle('handle.space')).toBeNull();
    expect(normalizeHandle('handle-dash')).toBeNull();
  });

  it('accepts underscores', () => {
    expect(normalizeHandle('HASCDemocrats')).toBe('HASCDemocrats');
    expect(normalizeHandle('_underscore')).toBe('_underscore');
  });

  it('accepts the minimum 1-character handle', () => {
    expect(normalizeHandle('a')).toBe('a');
  });

  it('rejects arbitrary URLs', () => {
    expect(normalizeHandle('https://evil.com/DeptofDefense')).toBeNull();
    expect(normalizeHandle('https://api.x.com/2/users')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalizeHandle(null as unknown as string)).toBeNull();
    expect(normalizeHandle(undefined as unknown as string)).toBeNull();
  });
});

describe('cached JSON compatibility', () => {
  it('keeps metrics as a real object and repairs legacy JSON-string rows', () => {
    expect(
      normalizeCachedMetrics({
        reply_count: 3,
        retweet_count: 4,
        like_count: 12,
        ignored: 'not-a-number',
      }),
    ).toEqual({
      reply_count: 3,
      retweet_count: 4,
      like_count: 12,
    });

    expect(
      normalizeCachedMetrics(
        JSON.stringify({
          reply_count: 7,
          quote_count: 2,
        }),
      ),
    ).toEqual({
      reply_count: 7,
      quote_count: 2,
    });
  });

  it('keeps media as a real array and repairs legacy JSON-string rows', () => {
    const media = [
      {
        media_key: '3_photo',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/example.jpg',
        width: 1200,
        height: 800,
        alt_text: 'Capitol building',
      },
    ];

    expect(normalizeCachedMedia(media)).toEqual([
      {
        mediaKey: '3_photo',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/example.jpg',
        previewImageUrl: null,
        width: 1200,
        height: 800,
        altText: 'Capitol building',
      },
    ]);
    expect(normalizeCachedMedia(JSON.stringify(media))).toHaveLength(1);
  });

  it('does not mislabel legacy URL entities as attached media', () => {
    expect(
      normalizeCachedMedia([
        {
          url: 'https://t.co/abc',
          expanded_url: 'https://example.com',
        },
      ]),
    ).toEqual([]);
  });
});

describe('X API requests', () => {
  it('requests avatar and verification fields during handle resolution', async () => {
    process.env.X_API_BEARER_TOKEN = 'test-token';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: '123',
            username: 'DeptofDefense',
            name: 'Department of Defense',
            profile_image_url: 'https://pbs.twimg.com/profile_images/example.jpg',
            verified: true,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const service = new XFeedService({} as PrismaService);
    const result = await (
      service as unknown as {
        doResolveAccount(username: string): Promise<{
          avatarUrl: string | null;
          verified: boolean;
        }>;
      }
    ).doResolveAccount('DeptofDefense');

    expect(result.avatarUrl).toContain('profile_images');
    expect(result.verified).toBe(true);

    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/users/by/username/DeptofDefense?');
    expect(decodeURIComponent(url)).toContain(
      'user.fields=profile_image_url,verified',
    );
  });

  it('paginates incremental timelines and requests attached media expansions', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: '200',
                text: 'newer',
                created_at: '2026-08-13T20:00:00.000Z',
                attachments: { media_keys: ['3_photo'] },
              },
            ],
            includes: {
              media: [
                {
                  media_key: '3_photo',
                  type: 'photo',
                  url: 'https://pbs.twimg.com/media/example.jpg',
                },
              ],
            },
            meta: { next_token: 'next-page' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: '199',
                text: 'older',
                created_at: '2026-08-13T19:00:00.000Z',
              },
            ],
            meta: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const service = new XFeedService({} as PrismaService);
    const result = await (
      service as unknown as {
        fetchTimelineWindow(
          xUserId: string,
          sinceId: string | null,
          token: string,
        ): Promise<{
          tweets: Array<Record<string, unknown>>;
          mediaByKey: Map<string, unknown>;
        }>;
      }
    ).fetchTimelineWindow('123', '150', 'test-token');

    expect(result.tweets.map((tweet) => tweet.id)).toEqual(['200', '199']);
    expect(result.mediaByKey.has('3_photo')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0] ?? ''));
    const secondUrl = decodeURIComponent(String(fetchMock.mock.calls[1]?.[0] ?? ''));
    expect(firstUrl).toContain('max_results=100');
    expect(firstUrl).toContain('expansions=author_id,attachments.media_keys');
    expect(firstUrl).toContain(
      'media.fields=alt_text,height,media_key,preview_image_url,type,url,width',
    );
    expect(firstUrl).toContain('since_id=150');
    expect(secondUrl).toContain('pagination_token=next-page');
  });

  it('seeds a new source from one newest page even when older history exists', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: '300',
              text: 'latest',
              created_at: '2026-08-13T21:00:00.000Z',
            },
          ],
          meta: { next_token: 'older-history' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const service = new XFeedService({} as PrismaService);
    const result = await (
      service as unknown as {
        fetchTimelineWindow(
          xUserId: string,
          sinceId: string | null,
          token: string,
        ): Promise<{ tweets: Array<Record<string, unknown>> }>;
      }
    ).fetchTimelineWindow('123', null, 'test-token');

    expect(result.tweets.map((tweet) => tweet.id)).toEqual(['300']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0] ?? ''))).toContain(
      'max_results=10',
    );
  });

  it.each([
    [401, ServiceUnavailableException],
    [403, ServiceUnavailableException],
    [404, NotFoundException],
    [429, HttpException],
    [500, BadGatewayException],
  ])('maps provider HTTP %i to a controlled exception', async (status, ExceptionType) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const service = new XFeedService({} as PrismaService);

    await expect(
      (
        service as unknown as {
          xApiFetch(url: string, token: string): Promise<Record<string, unknown>>;
        }
      ).xApiFetch('https://api.x.com/2/test', 'test-token'),
    ).rejects.toBeInstanceOf(ExceptionType);
  });
});

describe('dashboard merge behavior', () => {
  function post(id: string, createdAtX: string): XPostDTO {
    return {
      id,
      xPostId: id,
      text: id,
      createdAtX,
      media: [],
      metrics: {},
      authorUsername: 'source',
      authorDisplayName: 'Source',
      authorAvatarUrl: null,
      authorVerified: false,
      xUrl: `https://x.com/source/status/${id}`,
    };
  }

  it('sorts successful sources newest-first and marks a partial provider failure', async () => {
    process.env.X_API_BEARER_TOKEN = 'test-token';

    const subscriptions = [
      {
        id: 'sub-a',
        accountId: 'account-a',
        userId: 'user-a',
        enabled: true,
        sortOrder: 0,
        account: {
          username: 'SourceA',
          displayName: 'Source A',
          avatarUrl: null,
          verified: false,
        },
      },
      {
        id: 'sub-b',
        accountId: 'account-b',
        userId: 'user-a',
        enabled: true,
        sortOrder: 1,
        account: {
          username: 'SourceB',
          displayName: 'Source B',
          avatarUrl: null,
          verified: false,
        },
      },
    ];

    const prisma = {
      withTenantUser: async (
        _tenantId: string,
        _userId: string,
        fn: (tx: unknown) => unknown,
      ) =>
        fn({
          xFeedSubscription: {
            findMany: async () => subscriptions,
          },
        }),
    } as unknown as PrismaService;

    const service = new XFeedService(prisma);
    (
      service as unknown as {
        getTimeline(accountId: string, username: string): Promise<XPostDTO[]>;
      }
    ).getTimeline = jest.fn(async (accountId: string) => {
      if (accountId === 'account-b') {
        throw new Error('provider failure');
      }
      return [
        post('older', '2026-08-13T18:00:00.000Z'),
        post('newer', '2026-08-13T20:00:00.000Z'),
      ];
    });

    const result = await service.getDashboard({
      tenantId: 'tenant-a',
      userId: 'user-a',
    } as TenantContext);

    expect(result.posts.map((item) => item.xPostId)).toEqual(['newer', 'older']);
    expect(result.available).toBe(true);
    expect(result.reason).toBe('partial_provider_failure');
  });
});
