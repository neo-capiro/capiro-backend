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

/** Number of posts to fetch per account per timeline call. */
const TIMELINE_FETCH_COUNT = 10;

/** Max posts to return per account in the combined feed. */
const FEED_POSTS_PER_ACCOUNT = 5;

/** Max total posts in the combined feed. */
const FEED_MAX_TOTAL = 50;

// ── In-process cache types ──────────────────────────────────────────────────

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
  media: unknown[];
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
// maintain their own cache; a cache miss falls through to the DB, then to the
// provider. The DB upsert ensures cross-replica consistency.

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

  // ── Dashboard ──────────────────────────────────────────────────────────────

  async getDashboard(
    ctx: TenantContext,
    filterAccountId?: string,
  ): Promise<XFeedDashboardDTO> {
    const token = this.getBearerToken();
    if (!token) {
      // Return subscriptions but no posts — honest unavailable state.
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

    // If filtering by account, only fetch that one.
    const targetSubs = filterAccountId
      ? enabledSubs.filter((s) => s.accountId === filterAccountId)
      : enabledSubs;

    // Fetch posts for each subscribed account (coalesced + cached).
    const timelines = await Promise.allSettled(
      targetSubs.map(async (sub) => {
        const posts = await this.getTimeline(sub.accountId, sub.username);
        return { sub, posts };
      }),
    );

    // Collect successful results; failed accounts surface as a partial state.
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

    // Sort by createdAtX descending (reverse chronological).
    allPosts.sort((a, b) => new Date(b.createdAtX).getTime() - new Date(a.createdAtX).getTime());

    const limited = allPosts.slice(0, filterAccountId ? FEED_POSTS_PER_ACCOUNT * 2 : FEED_MAX_TOTAL);

    return {
      available: true,
      reason: anyFailed && limited.length === 0 ? 'provider_unavailable' : null,
      subscriptions: subs,
      posts: limited,
      filteredAccount: filterAccountId ?? null,
    };
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

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

    // Enforce per-user limit.
    const count = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      return tx.xFeedSubscription.count({ where: { userId: ctx.userId } });
    });
    if (count >= MAX_SOURCES) {
      throw new ConflictException(`You can follow at most ${MAX_SOURCES} X accounts.`);
    }

    // Resolve the handle to an X user (or get from DB cache).
    const resolved = await this.resolveAccount(username);

    // Upsert the tracked account (global).
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

    // Create the subscription (tenant + user scoped).
    const subscription = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      // Check for existing subscription (unique constraint handles race).
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
        // Re-enable if disabled.
        if (!existing.enabled) {
          await tx.xFeedSubscription.update({
            where: { id: existing.id },
            data: { enabled: true },
          });
        }
        return existing;
      }
      // sortOrder = max + 1
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
    });

    // Invalidate timeline cache for this account so the next dashboard load fetches fresh posts.
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

  // ── Resolve ────────────────────────────────────────────────────────────────

  async resolveHandle(ctx: TenantContext, rawUsername: string): Promise<XResolveResultDTO> {
    const username = normalizeHandle(rawUsername);
    if (!username) {
      throw new BadRequestException('A valid X handle is required.');
    }

    // Check DB first (maybe already tracked by someone).
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

    // Resolve via X API.
    const resolved = await this.resolveAccount(username);
    return {
      accountId: '', // Not yet persisted; the upsert happens on addSubscription.
      xUserId: resolved.xUserId,
      username: resolved.username,
      displayName: resolved.displayName,
      avatarUrl: resolved.avatarUrl,
      verified: resolved.verified,
    };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): { configured: boolean; maxSources: number } {
    return {
      configured: Boolean(this.getBearerToken()),
      maxSources: MAX_SOURCES,
    };
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  async refreshDashboard(ctx: TenantContext): Promise<XFeedDashboardDTO> {
    // Invalidate all timeline caches for this user's subscriptions.
    const subs = await this.getSubscriptions(ctx);
    for (const sub of subs) {
      timelineCache.delete(sub.accountId);
    }
    return this.getDashboard(ctx);
  }

  // ── Private: X API integration ─────────────────────────────────────────────

  private getBearerToken(): string | null {
    const token = process.env.X_API_BEARER_TOKEN?.trim();
    if (!token || token === 'REPLACE_ME') return null;
    return token;
  }

  /** Resolve a username to an X user via the X API (with coalescing + caching). */
  private async resolveAccount(username: string): Promise<CachedAccount> {
    // Check in-process cache.
    const cached = accountCache.get(username);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // Coalesce concurrent requests for the same username.
    const inFlight = resolveInFlight.get(username);
    if (inFlight) return inFlight;

    const promise = this.doResolveAccount(username);
    resolveInFlight.set(username, promise);
    try {
      const result = await promise;
      accountCache.set(username, {
        data: result,
        expiresAt: Date.now() + ACCOUNT_TTL_MS,
      });
      return result;
    } finally {
      resolveInFlight.delete(username);
    }
  }

  private async doResolveAccount(username: string): Promise<CachedAccount> {
    const token = this.getBearerToken();
    if (!token) {
      throw new ServiceUnavailableException('X API is not configured.');
    }

    const url = `${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`;
    const data = await this.xApiFetch(url, token);
    const userData = (data.data ?? {}) as Record<string, unknown>;

    return {
      xUserId: String(userData.id ?? ''),
      username: String(userData.username ?? username),
      displayName: (userData.name as string | null) ?? null,
      avatarUrl: (userData.profile_image_url as string | null) ?? null,
      verified: Boolean(userData.verified),
      fetchedAt: Date.now(),
    };
  }

  /** Get cached posts for an account, or fetch from X API. */
  private async getTimeline(accountId: string, username: string): Promise<XPostDTO[]> {
    // Check in-process cache.
    const cached = timelineCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data.posts;
    }

    // Coalesce concurrent requests.
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
      // On failure, don't cache the error — let the next request retry.
      timelineCache.delete(accountId);
      throw err;
    }
  }

  private async doGetTimeline(accountId: string, username: string): Promise<XPostDTO[]> {
    const token = this.getBearerToken();
    if (!token) {
      throw new ServiceUnavailableException('X API is not configured.');
    }

    // Get the tracked account from DB for lastPostId (since_id).
    const account = await this.prisma.withSystem(async (tx) => {
      return tx.xTrackedAccount.findUnique({ where: { id: accountId } });
    });
    if (!account) {
      throw new NotFoundException('Tracked account not found.');
    }

    // Fetch from X API.
    const params = new URLSearchParams({
      max_results: String(TIMELINE_FETCH_COUNT),
      'tweet.fields': 'created_at,public_metrics,entities,referenced_tweets',
      expansions: 'author_id',
    });
    if (account.lastPostId) {
      params.set('since_id', account.lastPostId);
    }

    const url = `${X_API_BASE}/users/${encodeURIComponent(account.xUserId)}/tweets?${params}`;
    const data = await this.xApiFetch(url, token);

    const tweets = Array.isArray(data.data) ? data.data : [];
    if (tweets.length === 0) {
      // No new posts — return cached DB posts.
      return this.getDbPosts(accountId, username, account);
    }

    // Upsert posts into DB cache.
    const newPosts = await this.prisma.withSystem(async (tx) => {
      const posts: XPostDTO[] = [];
      for (const tweet of tweets) {
        const upserted = await tx.xPostCache.upsert({
          where: {
            accountId_xPostId: {
              accountId,
              xPostId: String(tweet.id),
            },
          },
          update: {
            text: String(tweet.text ?? ''),
            createdAtX: new Date(tweet.created_at ?? Date.now()),
            media: JSON.stringify(tweet.entities?.urls ?? []),
            metrics: JSON.stringify(tweet.public_metrics ?? {}),
            rawMeta: JSON.stringify({ referenced_tweets: tweet.referenced_tweets ?? [] }),
            unavailable: false,
            fetchedAt: new Date(),
          },
          create: {
            accountId,
            xPostId: String(tweet.id),
            text: String(tweet.text ?? ''),
            createdAtX: new Date(tweet.created_at ?? Date.now()),
            media: JSON.stringify(tweet.entities?.urls ?? []),
            metrics: JSON.stringify(tweet.public_metrics ?? {}),
            rawMeta: JSON.stringify({ referenced_tweets: tweet.referenced_tweets ?? [] }),
            unavailable: false,
            fetchedAt: new Date(),
          },
        });
        posts.push(this.toDTO(upserted, account));
      }

      // Update lastPostId + lastFetchedAt on the account.
      const newestId = tweets[0]?.id ? String(tweets[0].id) : account.lastPostId;
      if (newestId && newestId !== account.lastPostId) {
        await tx.xTrackedAccount.update({
          where: { id: accountId },
          data: { lastPostId: newestId, lastFetchedAt: new Date() },
        });
      } else {
        await tx.xTrackedAccount.update({
          where: { id: accountId },
          data: { lastFetchedAt: new Date() },
        });
      }

      return posts;
    });

    // Also return any older cached DB posts to fill the feed.
    const dbPosts = await this.getDbPosts(accountId, username, account, FEED_POSTS_PER_ACCOUNT);

    // Merge: new posts first, then older DB posts, deduplicated.
    const seen = new Set(newPosts.map((p) => p.xPostId));
    const merged = [...newPosts, ...dbPosts.filter((p) => !seen.has(p.xPostId))];
    return merged.slice(0, FEED_POSTS_PER_ACCOUNT);
  }

  /** Read cached posts from the DB. */
  private async getDbPosts(
    accountId: string,
    username: string,
    account: { username: string; displayName: string | null; avatarUrl: string | null; verified: boolean },
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

  // ── X API fetch with error handling ────────────────────────────────────────

  private async xApiFetch(url: string, token: string): Promise<Record<string, unknown>> {
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
        throw new ServiceUnavailableException('X API access is forbidden. Check your app entitlements.');
      }
      if (response.status === 404) {
        throw new NotFoundException('X account not found.');
      }
      if (response.status === 429) {
        throw new HttpException('X API rate limit reached. Try again in a few minutes.', HttpStatus.TOO_MANY_REQUESTS);
      }
      if (response.status >= 500) {
        throw new BadGatewayException('X API is experiencing issues. Try again shortly.');
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.warn(`X API ${response.status}: ${body.slice(0, 200)}`);
        throw new BadGatewayException(`X API returned ${response.status}.`);
      }

      return (await response.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new BadGatewayException('X API request timed out.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── DTO mapping ────────────────────────────────────────────────────────────

  private toDTO(
    post: {
      id: string;
      xPostId: string;
      text: string;
      createdAtX: Date;
      media: unknown;
      metrics: unknown;
    },
    account: { username: string; displayName: string | null; avatarUrl: string | null; verified: boolean },
  ): XPostDTO {
    const safeMetrics = (post.metrics ?? {}) as Record<string, number>;
    return {
      id: post.id,
      xPostId: post.xPostId,
      text: post.text,
      createdAtX: post.createdAtX.toISOString(),
      media: Array.isArray(post.media) ? post.media : [],
      metrics: typeof safeMetrics === 'object' && safeMetrics !== null ? safeMetrics : {},
      authorUsername: account.username,
      authorDisplayName: account.displayName,
      authorAvatarUrl: account.avatarUrl,
      authorVerified: account.verified,
      xUrl: `https://x.com/${account.username}/status/${post.xPostId}`,
    };
  }
}

// ── Handle normalization ──────────────────────────────────────────────────────

/**
 * Normalize various X handle input formats to the canonical username.
 *
 * Accepts:
 *   DeptofDefense
 *   @DeptofDefense
 *   https://x.com/DeptofDefense
 *   https://twitter.com/DeptofDefense
 *
 * Returns the lowercase-stripped username, or null if the input is not a valid
 * X handle (1-15 alphanumeric + underscore characters).
 *
 * This function does NOT accept arbitrary URLs — it only extracts the handle
 * from known x.com/twitter.com paths. It never issues a network request.
 */
export function normalizeHandle(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let value = raw.trim();

  // Strip URL prefix if it's a known X/Twitter URL.
  const urlMatch = value.match(
    /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)(?:\/.*)?$/i,
  );
  if (urlMatch) {
    value = urlMatch[1]!;
  }

  // Strip leading @
  value = value.replace(/^@+/, '').trim();

  // Validate: X handles are 1-15 chars, alphanumeric + underscore.
  if (!/^[A-Za-z0-9_]{1,15}$/.test(value)) return null;

  return value;
}
