import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Maximum number of X accounts a single user can subscribe to.
 * Enforced on add. Can be overridden via X_FEED_MAX_SOURCES env var.
 */
const MAX_SOURCES = Number.parseInt(process.env.X_FEED_MAX_SOURCES ?? '25', 10);

/** TTL for the in-process account-resolution cache (username → X user data). */
const ACCOUNT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** TTL for the in-process timeline cache (account → posts). */
const TIMELINE_TTL_MS = 5 * 60 * 1000; // 5 min

/** X API base URL. */
const X_API_BASE = (process.env.X_API_BASE_URL ?? 'https://api.x.com/2').replace(/\/$/, '');

/** Request timeout for X API calls. */
const X_API_TIMEOUT_MS = 10_000;

/** First observation only needs enough recent posts to fill the dashboard. */
const INITIAL_TIMELINE_FETCH_COUNT = 10;

/** Incremental refreshes use the largest page to cover bursts efficiently. */
const TIMELINE_FETCH_COUNT = 100;

/**
 * Safety bound for a single incremental refresh. We never advance since_id if X
 * still has a next page after this bound, so high-volume bursts fail visibly
 * instead of permanently skipping posts.
 */
const TIMELINE_MAX_PAGES = 10;

/** Max posts to return per account in the combined feed. */
const FEED_POSTS_PER_ACCOUNT = 5;

/** Max total posts in the combined feed. */
const FEED_MAX_TOTAL = 50;

type JsonRecord = Record<string, unknown>;

export interface XMediaDTO {
  mediaKey: string;
  type: 'photo' | 'video' | 'animated_gif' | string;
  url: string | null;
  previewImageUrl: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
}

interface CachedAccount {
  xUserId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  fetchedAt: number;
}

interface CachedTimeline {
  posts: XPostDTO[];
  fetchedAt: number;
}

export interface XPostDTO {
  id: string;
  xPostId: string;
  text: string;
  createdAtX: string;
  media: XMediaDTO[];
  metrics: Record<string, number>;
  authorUsername: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorVerified: boolean;
  xUrl: string;
}

export interface XFeedDashboardDTO {
  available: boolean;
  reason: string | null;
  subscriptions: Array<{
    id: string;
    accountId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    verified: boolean;
    enabled: boolean;
    sortOrder: number;
  }>;
  posts: XPostDTO[];
  filteredAccount: string | null;
}

export interface XResolveResultDTO {
  accountId: string;
  xUserId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
}

// ── In-process coalescing cache ──────────────────────────────────────────────
// Correctness does NOT depend on this cache — it is an optimization to avoid
// redundant provider calls within a short window. The DB (x_tracked_account,
// x_post_cache) is the durable source of truth. Multiple API replicas each
// maintain their own cache; DB uniqueness prevents duplicate persisted posts,
// but provider-call single-flight is intentionally replica-local.

interface AccountCacheEntry {
  data: CachedAccount;
  expiresAt: number;
}

interface TimelineCacheEntry {
  data: CachedTimeline;
  expiresAt: number;
  pending: Promise<CachedTimeline> | null;
}

const accountCache = new Map<string, AccountCacheEntry>();
const timelineCache = new Map<string, TimelineCacheEntry>();

// In-flight resolve coalescing (same username requested concurrently).
const resolveInFlight = new Map<string, Promise<CachedAccount>>();

@Injectable()
export class XFeedService {
  private readonly logger = new Logger(XFeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(
    ctx: TenantContext,
    filterAccountId?: string,
  ): Promise<XFeedDashboardDTO> {
    const token = this.getBearerToken();
    if (!token) {
      const subs = await this.getSubscriptions(ctx);
      return {
        available: false,
        reason: 'not_configured',
        subscriptions: subs,
        posts: [],
        filteredAccount: filterAccountId ?? null,
      };
    }

    const subs = await this.getSubscriptions(ctx);
    const enabledSubs = subs.filter((s) => s.enabled);

    if (enabledSubs.length === 0) {
      return {
        available: true,
        reason: null,
        subscriptions: subs,
        posts: [],
        filteredAccount: filterAccountId ?? null,
      };
    }

    const targetSubs = filterAccountId
      ? enabledSubs.filter((s) => s.accountId === filterAccountId)
      : enabledSubs;

    const timelines = await Promise.allSettled(
      targetSubs.map(async (sub) => {
        const posts = await this.getTimeline(sub.accountId, sub.username);
        return { sub, posts };
      }),
    );

    const allPosts: XPostDTO[] = [];
    let anyFailed = false;
    for (const result of timelines) {
      if (result.status === 'fulfilled') {
        allPosts.push(...result.value.posts);
      } else {
        anyFailed = true;
        this.logger.warn(
          `Failed to fetch timeline: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }

    allPosts.sort(
      (a, b) => new Date(b.createdAtX).getTime() - new Date(a.createdAtX).getTime(),
    );

    const limited = allPosts.slice(
      0,
      filterAccountId ? FEED_POSTS_PER_ACCOUNT * 2 : FEED_MAX_TOTAL,
    );

    return {
      available: true,
      reason: anyFailed
        ? limited.length === 0
          ? 'provider_unavailable'
          : 'partial_provider_failure'
        : null,
      subscriptions: subs,
      posts: limited,
      filteredAccount: filterAccountId ?? null,
    };
  }

  async getSubscriptions(ctx: TenantContext): Promise<
    Array<{
      id: string;
      accountId: string;
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
      verified: boolean;
      enabled: boolean;
      sortOrder: number;
    }>
  > {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const subs = await tx.xFeedSubscription.findMany({
        where: { userId: ctx.userId },
        orderBy: { sortOrder: 'asc' },
        include: { account: true },
      });
      return subs.map((s) => ({
        id: s.id,
        accountId: s.accountId,
        username: s.account.username,
        displayName: s.account.displayName,
        avatarUrl: s.account.avatarUrl,
        verified: s.account.verified,
        enabled: s.enabled,
        sortOrder: s.sortOrder,
      }));
    });
  }

  async addSubscription(
    ctx: TenantContext,
    rawUsername: string,
  ): Promise<{ subscriptionId: string; accountId: string; username: string }> {
    const username = normalizeHandle(rawUsername);
    if (!username) {
      throw new BadRequestException('A valid X handle is required.');
    }

    const count = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      return tx.xFeedSubscription.count({ where: { userId: ctx.userId } });
    });
    if (count >= MAX_SOURCES) {
      throw new ConflictException(`You can follow at most ${MAX_SOURCES} X accounts.`);
    }

    const resolved = await this.resolveAccount(username);

    const account = await this.prisma.withSystem(async (tx) => {
      return tx.xTrackedAccount.upsert({
        where: { xUserId: resolved.xUserId },
        update: {
          username: resolved.username,
          displayName: resolved.displayName,
          avatarUrl: resolved.avatarUrl,
          verified: resolved.verified,
        },
        create: {
          xUserId: resolved.xUserId,
          username: resolved.username,
          displayName: resolved.displayName,
          avatarUrl: resolved.avatarUrl,
          verified: resolved.verified,
        },
      });
    });

    const subscription = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const existing = await tx.xFeedSubscription.findUnique({
          where: {
            tenantId_userId_accountId: {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              accountId: account.id,
            },
          },
        });
        if (existing) {
          if (!existing.enabled) {
            return tx.xFeedSubscription.update({
              where: { id: existing.id },
              data: { enabled: true },
            });
          }
          return existing;
        }

        const maxOrder = await tx.xFeedSubscription.aggregate({
          where: { userId: ctx.userId },
          _max: { sortOrder: true },
        });
        return tx.xFeedSubscription.create({
          data: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            accountId: account.id,
            sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
          },
        });
      },
    );

    timelineCache.delete(account.id);

    return {
      subscriptionId: subscription.id,
      accountId: account.id,
      username: account.username,
    };
  }

  async removeSubscription(ctx: TenantContext, subscriptionId: string): Promise<void> {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const sub = await tx.xFeedSubscription.findUnique({
        where: { id: subscriptionId },
      });
      if (!sub) {
        throw new NotFoundException('Subscription not found.');
      }
      if (sub.userId !== ctx.userId) {
        throw new ForbiddenException('You can only remove your own subscriptions.');
      }
      await tx.xFeedSubscription.delete({ where: { id: subscriptionId } });
    });
  }

  async resolveHandle(_ctx: TenantContext, rawUsername: string): Promise<XResolveResultDTO> {
    const username = normalizeHandle(rawUsername);
    if (!username) {
      throw new BadRequestException('A valid X handle is required.');
    }

    const existing = await this.prisma.withSystem(async (tx) => {
      return tx.xTrackedAccount.findUnique({
        where: { username },
      });
    });
    if (existing) {
      return {
        accountId: existing.id,
        xUserId: existing.xUserId,
        username: existing.username,
        displayName: existing.displayName,
        avatarUrl: existing.avatarUrl,
        verified: existing.verified,
      };
    }

    const resolved = await this.resolveAccount(username);
    return {
      accountId: '',
      xUserId: resolved.xUserId,
      username: resolved.username,
      displayName: resolved.displayName,
      avatarUrl: resolved.avatarUrl,
      verified: resolved.verified,
    };
  }

  getStatus(): { configured: boolean; maxSources: number } {
    return {
      configured: Boolean(this.getBearerToken()),
      maxSources: MAX_SOURCES,
    };
  }

  async refreshDashboard(ctx: TenantContext): Promise<XFeedDashboardDTO> {
    const subs = await this.getSubscriptions(ctx);
    for (const sub of subs) {
      timelineCache.delete(sub.accountId);
    }
    return this.getDashboard(ctx);
  }

  private getBearerToken(): string | null {
    const token = process.env.X_API_BEARER_TOKEN?.trim();
    if (!token || token === 'REPLACE_ME') return null;
    return token;
  }

  private async resolveAccount(username: string): Promise<CachedAccount> {
    const cacheKey = username.toLowerCase();
    const cached = accountCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const inFlight = resolveInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = this.doResolveAccount(username);
    resolveInFlight.set(cacheKey, promise);
    try {
      const result = await promise;
      accountCache.set(cacheKey, {
        data: result,
        expiresAt: Date.now() + ACCOUNT_TTL_MS,
      });
      return result;
    } finally {
      resolveInFlight.delete(cacheKey);
    }
  }

  private async doResolveAccount(username: string): Promise<CachedAccount> {
    const token = this.getBearerToken();
    if (!token) {
      throw new ServiceUnavailableException('X API is not configured.');
    }

    const params = new URLSearchParams({
      'user.fields': 'profile_image_url,verified',
    });
    const url =
      `${X_API_BASE}/users/by/username/${encodeURIComponent(username)}?${params.toString()}`;
    const data = await this.xApiFetch(url, token);
    const userData = asRecord(data.data);

    const xUserId = stringOrNull(userData.id);
    if (!xUserId) {
      throw new NotFoundException('X account not found.');
    }

    return {
      xUserId,
      username: stringOrNull(userData.username) ?? username,
      displayName: stringOrNull(userData.name),
      avatarUrl: stringOrNull(userData.profile_image_url),
      verified: Boolean(userData.verified),
      fetchedAt: Date.now(),
    };
  }

  private async getTimeline(accountId: string, username: string): Promise<XPostDTO[]> {
    const cached = timelineCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data.posts;
    }

    if (cached?.pending) {
      const result = await cached.pending;
      return result.posts;
    }

    const promise = this.doGetTimeline(accountId, username);
    const coalesced: Promise<CachedTimeline> = promise.then((posts) => ({
      posts,
      fetchedAt: Date.now(),
    }));
    timelineCache.set(accountId, {
      data: { posts: [], fetchedAt: 0 },
      expiresAt: 0,
      pending: coalesced,
    });

    try {
      const result = await coalesced;
      timelineCache.set(accountId, {
        data: result,
        expiresAt: Date.now() + TIMELINE_TTL_MS,
        pending: null,
      });
      return result.posts;
    } catch (err) {
      timelineCache.delete(accountId);
      throw err;
    }
  }

  private async doGetTimeline(accountId: string, username: string): Promise<XPostDTO[]> {
    const token = this.getBearerToken();
    if (!token) {
      throw new ServiceUnavailableException('X API is not configured.');
    }

    let account = await this.prisma.withSystem(async (tx) => {
      return tx.xTrackedAccount.findUnique({ where: { id: accountId } });
    });
    if (!account) {
      throw new NotFoundException('Tracked account not found.');
    }

    // Rows created before user.fields were requested can have a permanently
    // empty avatar/verification snapshot. Repair those legacy rows once on the
    // next real timeline refresh instead of forcing users to remove/re-add the
    // source. Failure to enrich identity does not block the post timeline.
    if (!account.avatarUrl) {
      try {
        const resolved = await this.resolveAccount(account.username);
        account = await this.prisma.withSystem(async (tx) =>
          tx.xTrackedAccount.update({
            where: { id: accountId },
            data: {
              username: resolved.username,
              displayName: resolved.displayName,
              avatarUrl: resolved.avatarUrl,
              verified: resolved.verified,
            },
          }),
        );
      } catch (error) {
        this.logger.warn(
          `Could not refresh X profile @${account.username}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const { tweets, mediaByKey } = await this.fetchTimelineWindow(
      account.xUserId,
      account.lastPostId,
      token,
    );

    if (tweets.length === 0) {
      return this.getDbPosts(accountId, username, account);
    }

    const newPosts = await this.prisma.withSystem(async (tx) => {
      const posts: XPostDTO[] = [];
      for (const tweet of tweets) {
        const xPostId = stringOrNull(tweet.id);
        if (!xPostId) continue;

        const media = mediaForTweet(tweet, mediaByKey);
        const metrics = normalizeCachedMetrics(tweet.public_metrics);
        const rawMeta = {
          referenced_tweets: Array.isArray(tweet.referenced_tweets)
            ? tweet.referenced_tweets
            : [],
        };
        const mediaJson = media as unknown as Prisma.InputJsonValue;
        const metricsJson = metrics as Prisma.InputJsonValue;
        const rawMetaJson = rawMeta as Prisma.InputJsonValue;

        const upserted = await tx.xPostCache.upsert({
          where: {
            accountId_xPostId: {
              accountId,
              xPostId,
            },
          },
          update: {
            text: String(tweet.text ?? ''),
            createdAtX: dateFromUnknown(tweet.created_at),
            media: mediaJson,
            metrics: metricsJson,
            rawMeta: rawMetaJson,
            unavailable: false,
            fetchedAt: new Date(),
          },
          create: {
            accountId,
            xPostId,
            text: String(tweet.text ?? ''),
            createdAtX: dateFromUnknown(tweet.created_at),
            media: mediaJson,
            metrics: metricsJson,
            rawMeta: rawMetaJson,
            unavailable: false,
            fetchedAt: new Date(),
          },
        });
        posts.push(this.toDTO(upserted, account));
      }

      const newestId = tweets
        .map((tweet) => stringOrNull(tweet.id))
        .find((id): id is string => Boolean(id));

      await tx.xTrackedAccount.update({
        where: { id: accountId },
        data: {
          ...(newestId ? { lastPostId: newestId } : {}),
          lastFetchedAt: new Date(),
        },
      });

      return posts;
    });

    const dbPosts = await this.getDbPosts(
      accountId,
      username,
      account,
      FEED_POSTS_PER_ACCOUNT,
    );

    const seen = new Set(newPosts.map((p) => p.xPostId));
    const merged = [
      ...newPosts,
      ...dbPosts.filter((p) => !seen.has(p.xPostId)),
    ].sort(
      (a, b) => new Date(b.createdAtX).getTime() - new Date(a.createdAtX).getTime(),
    );
    return merged.slice(0, FEED_POSTS_PER_ACCOUNT);
  }

  private async fetchTimelineWindow(
    xUserId: string,
    sinceId: string | null,
    token: string,
  ): Promise<{ tweets: JsonRecord[]; mediaByKey: Map<string, XMediaDTO> }> {
    const tweetsById = new Map<string, JsonRecord>();
    const mediaByKey = new Map<string, XMediaDTO>();
    let paginationToken: string | null = null;

    for (let page = 0; page < TIMELINE_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        max_results: String(
          sinceId ? TIMELINE_FETCH_COUNT : INITIAL_TIMELINE_FETCH_COUNT,
        ),
        'tweet.fields':
          'attachments,author_id,created_at,entities,public_metrics,referenced_tweets',
        expansions: 'author_id,attachments.media_keys',
        'media.fields':
          'alt_text,height,media_key,preview_image_url,type,url,width',
      });
      if (sinceId) {
        params.set('since_id', sinceId);
      }
      if (paginationToken) {
        params.set('pagination_token', paginationToken);
      }

      const url =
        `${X_API_BASE}/users/${encodeURIComponent(xUserId)}/tweets?${params.toString()}`;
      const data = await this.xApiFetch(url, token);

      const pageTweets = Array.isArray(data.data) ? data.data : [];
      for (const rawTweet of pageTweets) {
        const tweet = asRecord(rawTweet);
        const id = stringOrNull(tweet.id);
        if (id) tweetsById.set(id, tweet);
      }

      const includes = asRecord(data.includes);
      const includedMedia = Array.isArray(includes.media) ? includes.media : [];
      for (const rawMedia of includedMedia) {
        const media = normalizeMediaItem(rawMedia);
        if (media) mediaByKey.set(media.mediaKey, media);
      }

      const meta = asRecord(data.meta);
      paginationToken = stringOrNull(meta.next_token);

      // First observation deliberately seeds only the newest page. Historical
      // backfill is not useful for a dashboard feed, and walking an account's
      // entire timeline here would burn provider reads and could hit the safety
      // bound before persisting anything. Once we have a cursor, refreshes walk
      // every page after since_id so no newly-published posts are skipped.
      if (!sinceId || !paginationToken) {
        return { tweets: [...tweetsById.values()], mediaByKey };
      }
    }

    throw new BadGatewayException(
      `X timeline exceeded the safe ${TIMELINE_MAX_PAGES}-page refresh bound. ` +
        'No cursor was advanced; retry later.',
    );
  }

  private async getDbPosts(
    accountId: string,
    _username: string,
    account: {
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
      verified: boolean;
    },
    limit = FEED_POSTS_PER_ACCOUNT,
  ): Promise<XPostDTO[]> {
    const posts = await this.prisma.withSystem(async (tx) => {
      return tx.xPostCache.findMany({
        where: { accountId, unavailable: false },
        orderBy: { createdAtX: 'desc' },
        take: limit,
      });
    });
    return posts.map((p) => this.toDTO(p, account));
  }

  private async xApiFetch(url: string, token: string): Promise<JsonRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), X_API_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw new ServiceUnavailableException('X API credentials are invalid.');
      }
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'X API access is forbidden. Check your app entitlements.',
        );
      }
      if (response.status === 404) {
        throw new NotFoundException('X account not found.');
      }
      if (response.status === 429) {
        throw new HttpException(
          'X API rate limit reached. Try again in a few minutes.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (response.status >= 500) {
        throw new BadGatewayException(
          'X API is experiencing issues. Try again shortly.',
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.warn(`X API ${response.status}: ${body.slice(0, 200)}`);
        throw new BadGatewayException(`X API returned ${response.status}.`);
      }

      return (await response.json()) as JsonRecord;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new BadGatewayException('X API request timed out.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toDTO(
    post: {
      id: string;
      xPostId: string;
      text: string;
      createdAtX: Date;
      media: unknown;
      metrics: unknown;
    },
    account: {
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
      verified: boolean;
    },
  ): XPostDTO {
    return {
      id: post.id,
      xPostId: post.xPostId,
      text: post.text,
      createdAtX: post.createdAtX.toISOString(),
      media: normalizeCachedMedia(post.media),
      metrics: normalizeCachedMetrics(post.metrics),
      authorUsername: account.username,
      authorDisplayName: account.displayName,
      authorAvatarUrl: account.avatarUrl,
      authorVerified: account.verified,
      xUrl: `https://x.com/${account.username}/status/${post.xPostId}`,
    };
  }
}

function parseLegacyJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): JsonRecord {
  const parsed = parseLegacyJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as JsonRecord;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateFromUnknown(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function normalizeCachedMetrics(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const result: Record<string, number> = {};
  for (const [key, metric] of Object.entries(record)) {
    if (typeof metric === 'number' && Number.isFinite(metric)) {
      result[key] = metric;
    }
  }
  return result;
}

function normalizeMediaItem(value: unknown): XMediaDTO | null {
  const item = asRecord(value);
  const mediaKey = stringOrNull(item.mediaKey) ?? stringOrNull(item.media_key);
  const type = stringOrNull(item.type);
  if (!mediaKey || !type) return null;

  return {
    mediaKey,
    type,
    url: stringOrNull(item.url),
    previewImageUrl:
      stringOrNull(item.previewImageUrl) ?? stringOrNull(item.preview_image_url),
    width: numberOrNull(item.width),
    height: numberOrNull(item.height),
    altText: stringOrNull(item.altText) ?? stringOrNull(item.alt_text),
  };
}

export function normalizeCachedMedia(value: unknown): XMediaDTO[] {
  const parsed = parseLegacyJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => normalizeMediaItem(item))
    .filter((item): item is XMediaDTO => item !== null);
}

function mediaForTweet(
  tweet: JsonRecord,
  mediaByKey: ReadonlyMap<string, XMediaDTO>,
): XMediaDTO[] {
  const attachments = asRecord(tweet.attachments);
  const keys = Array.isArray(attachments.media_keys)
    ? attachments.media_keys.filter(
        (key): key is string => typeof key === 'string' && key.length > 0,
      )
    : [];

  return keys
    .map((key) => mediaByKey.get(key))
    .filter((media): media is XMediaDTO => Boolean(media));
}

export function normalizeHandle(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let value = raw.trim();

  const urlMatch = value.match(
    /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)(?:\/.*)?$/i,
  );
  if (urlMatch) {
    value = urlMatch[1]!;
  }

  value = value.replace(/^@+/, '').trim();

  if (!/^[A-Za-z0-9_]{1,15}$/.test(value)) return null;

  return value;
}
