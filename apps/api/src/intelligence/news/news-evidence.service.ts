import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalNewsUrl, compileNewsQuery } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

export const newsHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};
export type NewsObservationInput = {
  provider: string;
  providerId?: string;
  url: string;
  publisher: string;
  /**
   * Canonical `intel_article.source` slug for the shared news corpus (e.g.
   * `the_hill`, `politico_congress`, `dod`) — the vocabulary the Dashboard
   * Wire / Data Explorer source facets, saved user filters and outlet marks
   * are keyed on. `publisher` stays the article hostname for the LegiWatch
   * observation ledger. When omitted, `publisher` is used as before.
   */
  source?: string;
  title: string;
  summary?: string | null;
  body?: string | null;
  bodyComplete?: boolean;
  publishedAt?: string | null;
  /** A publisher calendar day; stored as a UTC date bucket, never an instant claim. */
  publicationPrecision?: 'day' | 'instant';
  language?: string | null;
  publisherCountry?: string | null;
  rights: 'headline_link' | 'excerpt' | 'full_text';
  author?: string | null;
  feedUrl?: string;
  categories?: string[];
  providerParsedAt?: string | null;
};
@Injectable()
export class NewsEvidenceService {
  constructor(readonly prisma: PrismaService) {}
  async retain(input: NewsObservationInput) {
    const canonical = canonicalNewsUrl(input.url);
    if (
      !input.title?.trim() ||
      input.title.length > 2000 ||
      !input.publisher ||
      !['headline_link', 'excerpt', 'full_text'].includes(input.rights)
    )
      throw new BadRequestException('INVALID_NEWS_OBSERVATION');
    const publishedAt =
      input.publishedAt && Number.isFinite(Date.parse(input.publishedAt))
        ? new Date(input.publishedAt)
        : null;
    if (
      input.publicationPrecision === 'day' &&
      (!input.publishedAt ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.publishedAt) ||
        !publishedAt ||
        publishedAt.toISOString().slice(0, 10) !== input.publishedAt)
    )
      throw new BadRequestException('INVALID_PUBLICATION_DAY');
    const publicationPrecision = publishedAt
      ? (input.publicationPrecision ?? 'instant')
      : 'unknown';
    const summary =
      input.rights === 'headline_link' ? null : (input.summary?.slice(0, 10000) ?? null);
    const body = input.rights === 'full_text' ? (input.body?.slice(0, 2_000_000) ?? null) : null;
    const complete = !!body && input.bodyComplete === true && body.length === input.body?.length;
    const revision = newsHash({
      title: input.title,
      summary,
      body,
      publishedAt,
      publisher: input.publisher,
      rights: input.rights,
      author: input.author ?? null,
      ...(publicationPrecision === 'day' ? { publicationPrecision } : {}),
    });
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${canonical},0))`;
      const article = await tx.intelArticle.upsert({
        where: { url: canonical },
        create: {
          url: canonical,
          // Shared-corpus slug first. Writing the raw hostname here (2026-09-04
          // → 2026-09-16) silently orphaned every saved Dashboard source
          // filter, which is keyed on the feed slug — see sync-rss-intel.ts.
          source: input.source?.trim() || input.publisher,
          title: input.title,
          summary,
          publishedAt: publishedAt ?? new Date(),
          author: input.author?.slice(0, 200),
          feedUrl: input.feedUrl,
          categories: input.categories ?? [],
        },
        update: { syncedAt: new Date() },
      });
      const id = newsHash([article.id, revision]);
      const known = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM legiwatch_news_observation WHERE id=${id}`;
      await tx.$executeRaw`INSERT INTO legiwatch_news_observation(id,article_id,revision,provider,provider_id,original_url,canonical_url,publisher,author,provider_parsed_at,title,summary,body,body_complete,language,publisher_country,published_at,publication_precision,source_url,rights) VALUES(${id},${article.id},${revision},${input.provider},${input.providerId ?? null},${input.url},${canonical},${input.publisher},${input.author?.slice(0, 200) ?? null},${input.providerParsedAt && Number.isFinite(Date.parse(input.providerParsedAt)) ? new Date(input.providerParsedAt) : null},${input.title},${summary},${body},${complete},${input.language ?? null},${input.publisherCountry ?? null},${publishedAt},${publicationPrecision},${input.url},${input.rights}) ON CONFLICT(article_id,revision) DO NOTHING`;
      // Replaying a known older revision cannot roll back the current article.
      if (!known.length) {
        await tx.$executeRaw`INSERT INTO legiwatch_news_current(article_id,observation_id) VALUES(${article.id},${id}) ON CONFLICT(article_id) DO UPDATE SET observation_id=EXCLUDED.observation_id`;
        await tx.intelArticle.update({
          where: { id: article.id },
          data: {
            title: input.title,
            summary,
            ...(publishedAt ? { publishedAt } : {}),
            ...(input.author ? { author: input.author.slice(0, 200) } : {}),
          },
        });
      }
      await tx.$executeRaw`UPDATE legiwatch_news_current SET last_observed_at=now() WHERE article_id=${article.id}`;
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM legiwatch_news_observation WHERE id=${id}`;
      return rows[0]!;
    });
  }
  /**
   * Data Explorer rows are intel_article ids; LegiWatch evidence tracking needs a
   * news observation id. Ensure one exists without re-upserting the article row
   * (its stored URL may predate canonicalization and would fork a duplicate).
   */
  async ensureObservationForArticle(articleId: string): Promise<{ observationId: string } | null> {
    const current = await this.prisma.$queryRaw<Array<{ observationId: string }>>`
      SELECT observation_id AS "observationId" FROM legiwatch_news_current WHERE article_id=${articleId}`;
    if (current[0]) return current[0];
    const article = await this.prisma.intelArticle.findUnique({ where: { id: articleId } });
    if (!article) return null;
    const canonical = canonicalNewsUrl(article.url);
    const publisher = hostOf(article.url) ?? article.source;
    const title = article.title.slice(0, 2000);
    const author = article.author?.slice(0, 200) ?? null;
    const revision = newsHash({
      title,
      summary: null,
      body: null,
      publishedAt: article.publishedAt,
      publisher,
      rights: 'headline_link',
      author,
    });
    const id = newsHash([article.id, revision]);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${canonical},0))`;
      await tx.$executeRaw`INSERT INTO legiwatch_news_observation(id,article_id,revision,provider,provider_id,original_url,canonical_url,publisher,author,provider_parsed_at,title,summary,body,body_complete,language,publisher_country,published_at,publication_precision,source_url,rights) VALUES(${id},${article.id},${revision},'intel_article',${article.id},${article.url},${canonical},${publisher},${author},NULL,${title},NULL,NULL,false,NULL,NULL,${article.publishedAt},'instant',${article.url},'headline_link') ON CONFLICT(article_id,revision) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO legiwatch_news_current(article_id,observation_id) VALUES(${article.id},${id}) ON CONFLICT(article_id) DO NOTHING`;
      const rows = await tx.$queryRaw<Array<{ observationId: string }>>`
        SELECT observation_id AS "observationId" FROM legiwatch_news_current WHERE article_id=${article.id}`;
      return rows[0] ?? { observationId: id };
    });
  }

  async chargeProviderRequest() {
    const cap = Math.min(
      1000,
      Math.max(0, Number(process.env.LEGIWATCH_NEWS_DAILY_REQUEST_CAP ?? 0)),
    );
    if (!Number.isInteger(cap) || !cap) return false;
    const charged = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO legiwatch_provider_budget(provider,day) VALUES('newscatcher',CURRENT_DATE) ON CONFLICT DO NOTHING`;
      return tx.$queryRaw<
        Array<{ requests: number }>
      >`UPDATE legiwatch_provider_budget SET requests=requests+1 WHERE provider='newscatcher' AND day=CURRENT_DATE AND requests<${cap} RETURNING requests`;
    });
    return charged.length > 0;
  }
  /** Shared account budget charged before every monitoring provider request.
   * Definitions/pages are private; public observations never retain their query. */
  async monitoringPage(input: Record<string, unknown>) {
    if (process.env.LEGIWATCH_NEWS_INGEST_ENABLED !== 'true')
      throw new ForbiddenException('NEWS_SOURCE_NOT_ENABLED');
    const tenantId = String(input.tenantId ?? ''),
      actor = String(input.ownerId ?? '');
    if (!/^[a-f0-9-]{36}$/i.test(tenantId) || !actor)
      throw new BadRequestException('ACTOR_REQUIRED');
    const allowed = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id=${tenantId}::uuid AND u.clerk_user_id=${actor} AND m.status::text='active'`,
    );
    if (!allowed.length) throw new ForbiddenException('ACTIVE_MEMBER_REQUIRED');
    const compiled = compileNewsQuery(String(input.query ?? ''));
    const from = new Date(String(input.from)),
      to = new Date(String(input.to)),
      page = Number(input.page);
    const sources = Array.isArray(input.sources) ? input.sources.map(String) : [];
    if (
      !compiled.providerQuery ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 10 ||
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 14 * 86400000 ||
      sources.length > 74 ||
      sources.some((s) => !/^[a-z0-9.-]+$/i.test(s))
    )
      throw new BadRequestException('BOUNDED_NEWS_WINDOW_REQUIRED');
    const key = process.env.NEWSCATCHER_API_KEY;
    if (!key) return { articles: [], complete: false, reason: 'provider_not_configured', page };
    const cap = Math.min(
      1000,
      Math.max(0, Number(process.env.LEGIWATCH_NEWS_DAILY_REQUEST_CAP ?? 0)),
    );
    if (!Number.isInteger(cap) || !cap)
      return { articles: [], complete: false, reason: 'provider_budget_not_configured', page };
    if (!(await this.chargeProviderRequest()))
      return { articles: [], complete: false, reason: 'account_request_cap', page };
    const url = new URL(
      `${(process.env.NEWSCATCHER_API_BASE_URL ?? 'https://v3-api.newscatcherapi.com/api').replace(/\/$/, '')}/search`,
    );
    Object.entries({
      q: compiled.providerQuery,
      from_: from.toISOString(),
      to_: to.toISOString(),
      by_parse_date: 'true',
      sort_by: 'date',
      page: String(page),
      page_size: '100',
      lang: 'en',
      ranked_only: 'false',
      exclude_duplicates: 'false',
      robots_compliant: 'true',
      search_in: 'title_content,summary',
      ...(sources.length ? { sources: sources.join(',') } : {}),
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    try {
      const response = await fetch(url, {
        headers: { 'x-api-token': key },
        signal: AbortSignal.timeout(25000),
        redirect: 'error',
      });
      if (!response.ok)
        return { articles: [], complete: false, reason: `provider_http_${response.status}`, page };
      const result = (await response.json()) as {
        articles?: Array<Record<string, unknown>>;
        page?: number;
        total_pages?: number;
        total_hits?: number;
      };
      if (
        !Array.isArray(result.articles) ||
        result.articles.length > 100 ||
        result.page !== page ||
        !Number.isInteger(result.total_pages) ||
        !Number.isInteger(result.total_hits) ||
        result.total_pages! < 0 ||
        result.total_hits! < 0 ||
        result.total_hits! < result.articles.length
      )
        return { articles: [], complete: false, reason: 'provider_pagination_unqualified', page };
      const articles = [];
      let rejected = 0;
      for (const row of result.articles) {
        try {
          articles.push(
            await this.retain({
              provider: 'newscatcher-v3',
              providerId: String(row._id ?? row.id ?? ''),
              url: String(row.link ?? ''),
              publisher: String(row.clean_url ?? row.name_source ?? ''),
              title: String(row.title ?? ''),
              publishedAt: typeof row.published_date === 'string' ? row.published_date : null,
              language: typeof row.language === 'string' ? row.language : null,
              publisherCountry: typeof row.country === 'string' ? row.country : null,
              rights: 'headline_link',
              author: typeof row.author === 'string' ? row.author : null,
              providerParsedAt: typeof row.parse_date === 'string' ? row.parse_date : null,
            }),
          );
        } catch {
          rejected++;
        }
      }
      return {
        articles,
        page,
        totalPages: result.total_pages,
        totalHits: result.total_hits,
        observedCount: result.articles.length,
        rejected,
        complete: rejected === 0 && page >= result.total_pages!,
        reason: rejected
          ? 'invalid_provider_records'
          : page < result.total_pages!
            ? 'more_pages'
            : null,
        textCoverage: 'headline_only',
        parserVersion: compiled.adapterVersion,
      };
    } catch {
      return { articles: [], complete: false, reason: 'provider_unavailable', page };
    }
  }
}
