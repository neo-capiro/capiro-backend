import type { PrismaService } from '../prisma/prisma.service.js';

const REGULATIONS_GOV_COMMENTS_BASE_URL = 'https://api.regulations.gov/v4/comments';
const REGULATIONS_GOV_TIMEOUT_MS = 15_000;
export const REGULATORY_COMMENT_SEARCH_PAGE_SIZE = 10;

export interface RegulatoryCommentDetail {
  commentId: string;
  docketId: string | null;
  agencyId: string | null;
  commentText: string | null;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  city: string | null;
  stateProvince: string | null;
  country: string | null;
  postedDate: Date | null;
  sourceUrl: string | null;
}

interface RegulatoryCommentAttributes {
  docketId?: string | null;
  agencyId?: string | null;
  title?: string | null;
  comment?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  organization?: string | null;
  city?: string | null;
  stateProvinceRegion?: string | null;
  country?: string | null;
  postedDate?: string | null;
}

interface RetrievedComment {
  attrs: RegulatoryCommentAttributes;
  title: string;
  sourceUrl: string;
  postedDate: Date | null;
}

export interface RegulatoryCommentReporter {
  warn(message: string): void;
  safeError(error: unknown): string;
}

/** Source HTTP access and authoritative global comment detail cache. */
export class ClientProfileFillRegulatoryCommentSource {
  constructor(
    private readonly prisma: Pick<PrismaService, 'regulatoryComment'>,
    private readonly reporter: RegulatoryCommentReporter,
  ) {}

  async searchComments(apiKey: string, clientName: string, pageNumber: number) {
    const params = new URLSearchParams({
      api_key: apiKey,
      'filter[searchTerm]': `"${clientName}"`,
      'page[size]': String(REGULATORY_COMMENT_SEARCH_PAGE_SIZE),
      'page[number]': String(pageNumber),
      sort: '-postedDate',
    });
    const res = await fetch(`${REGULATIONS_GOV_COMMENTS_BASE_URL}?${params}`, {
      signal: AbortSignal.timeout(REGULATIONS_GOV_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Regulations.gov comments search HTTP ${res.status}`);
    }
    return (await res.json()) as {
      data?: Array<{ id: string }>;
      meta?: { totalElements?: number; totalPages?: number };
    };
  }

  async getDetail(commentId: string, apiKey: string): Promise<RegulatoryCommentDetail | null> {
    // This cache is global, as before. Read failures propagate; only the
    // subsequent HTTP/detail persistence operation degrades to unavailable.
    const cached = await this.prisma.regulatoryComment.findUnique({
      where: { commentId },
    });
    if (cached) return this.cachedDetail(cached);
    try {
      const detail = await this.readDetail(commentId, apiKey);
      if (!detail) return null;
      await this.cacheDetail(commentId, detail);
      return this.attributeDetail(commentId, detail);
    } catch (error) {
      this.reporter.warn(
        `Regulatory comment detail fetch unavailable for ${commentId}: ${this.reporter.safeError(error)}`,
      );
      return null;
    }
  }

  private cachedDetail(cached: RegulatoryCommentDetail): RegulatoryCommentDetail {
    return {
      commentId: cached.commentId,
      docketId: cached.docketId,
      agencyId: cached.agencyId,
      commentText: cached.commentText,
      firstName: cached.firstName,
      lastName: cached.lastName,
      organization: cached.organization,
      city: cached.city,
      stateProvince: cached.stateProvince,
      country: cached.country,
      postedDate: cached.postedDate,
      sourceUrl: cached.sourceUrl,
    };
  }

  private async readDetail(commentId: string, apiKey: string): Promise<RetrievedComment | null> {
    const params = new URLSearchParams({ api_key: apiKey });
    const res = await fetch(
      `${REGULATIONS_GOV_COMMENTS_BASE_URL}/${encodeURIComponent(commentId)}?${params}`,
      { signal: AbortSignal.timeout(REGULATIONS_GOV_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { id: string; attributes?: RegulatoryCommentAttributes };
    };
    const attrs = body.data?.attributes;
    if (!attrs) return null;
    const title = attrs.title ?? `Comment ${commentId}`;
    const sourceUrl = `${REGULATIONS_GOV_COMMENTS_BASE_URL}/${encodeURIComponent(commentId)}`;
    const postedDate = attrs.postedDate ? new Date(attrs.postedDate) : null;
    return { attrs, title, sourceUrl, postedDate };
  }

  private async cacheDetail(commentId: string, detail: RetrievedComment): Promise<void> {
    const { attrs, title, sourceUrl, postedDate } = detail;
    await this.prisma.regulatoryComment.upsert({
      where: { commentId },
      create: {
        commentId,
        docketId: attrs.docketId ?? null,
        agencyId: attrs.agencyId ?? null,
        title,
        commentText: attrs.comment ?? null,
        firstName: attrs.firstName ?? null,
        lastName: attrs.lastName ?? null,
        organization: attrs.organization ?? null,
        city: attrs.city ?? null,
        stateProvince: attrs.stateProvinceRegion ?? null,
        country: attrs.country ?? null,
        postedDate,
        sourceUrl,
      },
      update: {
        title,
        commentText: attrs.comment ?? null,
        organization: attrs.organization ?? null,
        syncedAt: new Date(),
      },
    });
  }

  private attributeDetail(commentId: string, detail: RetrievedComment): RegulatoryCommentDetail {
    const { attrs, sourceUrl, postedDate } = detail;
    return {
      commentId,
      docketId: attrs.docketId ?? null,
      agencyId: attrs.agencyId ?? null,
      commentText: attrs.comment ?? null,
      firstName: attrs.firstName ?? null,
      lastName: attrs.lastName ?? null,
      organization: attrs.organization ?? null,
      city: attrs.city ?? null,
      stateProvince: attrs.stateProvinceRegion ?? null,
      country: attrs.country ?? null,
      postedDate,
      sourceUrl,
    };
  }
}
