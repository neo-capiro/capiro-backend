import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { XMLParser } from 'fast-xml-parser';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { fetchJson, redactSecrets } from '../../meri/sources/http.js';
import { TokenBucket } from './rate-limiter.js';

const GOVINFO_API_ROOT = 'https://api.govinfo.gov/';
// api.data.gov default ceiling is 1000 requests/hour per key.
const RATE_LIMIT_PER_HOUR = 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 24 * ONE_HOUR_MS;
const S3_PDF_PREFIX = 'pdfs';

// ── Strict public types ───────────────────────────────────────────────────────

export interface BillSummary {
  billId: string;
  congress: number;
  billType: string;
  billNumber: string | null;
  title: string | null;
  dateIssued: string | null;
  lastModified: string | null;
  packageLink: string | null;
}

export interface BillSection {
  number: string | null;
  heading: string | null;
  text: string;
}

export interface BillText {
  xml: string;
  sections: BillSection[];
}

export interface ReportSummary {
  reportId: string;
  congress: number;
  chamber: string;
  kind: string;
  title: string | null;
  dateIssued: string | null;
  lastModified: string | null;
  packageLink: string | null;
}

export interface CommitteeReport {
  url: string;
  pdfBuffer: Buffer;
  metadata: GovInfoPackageSummary;
}

export interface PublicLaw {
  url: string;
  pdfBuffer: Buffer;
}

export interface HearingSummary {
  hearingId: string; // GovInfo packageId, e.g. "CHRG-119shrg58001"
  congress: number;
  title: string | null;
  dateIssued: string | null; // ISO date the transcript was published
  lastModified: string | null;
  packageLink: string | null;
}

export interface HearingText {
  packageId: string;
  text: string;
  format: 'txt' | 'htm';
  sourceUrl: string;
  dateIssued: string | null;
  title: string | null;
  raw?: string;
  lastModified?: string | null;
  heldDates?: string[];
  committees?: Array<{ authorityId: string; chamber: string; congress: string }>;
}

// ── Internal GovInfo API shapes (only the fields we read) ─────────────────────

interface GovInfoCollectionResponse {
  count?: number;
  nextPage?: string | null;
  packages?: GovInfoPackageRow[];
}

interface GovInfoPackageRow {
  packageId: string;
  title?: string;
  congress?: string | number;
  dateIssued?: string;
  lastModified?: string;
  packageLink?: string;
  docClass?: string;
}

interface GovInfoDownloadLinks {
  txtLink?: string;
  xmlLink?: string;
  pdfLink?: string;
  modsLink?: string;
  htmLink?: string;
}

export interface GovInfoPackageSummary {
  packageId: string;
  title?: string;
  collectionCode?: string;
  congress?: string | number;
  dateIssued?: string;
  lastModified?: string;
  download?: GovInfoDownloadLinks;
  [key: string]: unknown;
}

/**
 * Shared GovInfo (api.data.gov) client for congressional bills (BILLS), committee
 * reports (CRPT), public laws (PLAW), and hearings (CHRG).
 *
 * - Key from Secrets Manager (injected as GOVINFO_API_KEY env by CDK). Fails
 *   closed with 503 when unset.
 * - Token-bucket rate limiter (1000 req/hour/key).
 * - 24h pg cache (govinfo_cache) for JSON API responses, keyed by api_key-stripped URL.
 * - S3 cache for fetched PDFs under {GOVINFO_CACHE_BUCKET}/pdfs/.
 * - Retry/backoff on 429/5xx is handled by the shared fetchJson helper.
 */
@Injectable()
export class GovInfoService {
  private readonly logger = new Logger(GovInfoService.name);
  private readonly apiKey: string | undefined;
  private readonly cacheBucket: string | undefined;
  private readonly s3: S3Client;
  private readonly limiter: TokenBucket;
  private readonly xml: XMLParser;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    // Injectable for tests; defaults to a real client in the given region.
    // @Optional so Nest can instantiate GovInfoService (these aren't providers) —
    // without it, importing GovInfoModule into AppModule fails app boot.
    @Optional() s3?: S3Client,
    @Optional() limiter?: TokenBucket,
  ) {
    this.apiKey = config.get('GOVINFO_API_KEY', { infer: true });
    this.cacheBucket = config.get('GOVINFO_CACHE_BUCKET', { infer: true });
    const region = config.get('AWS_REGION_DEFAULT', { infer: true });
    this.s3 = s3 ?? new S3Client({ region });
    this.limiter =
      limiter ?? new TokenBucket({ capacity: RATE_LIMIT_PER_HOUR, refillWindowMs: ONE_HOUR_MS });
    this.xml = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
    });
  }

  // ── Bills ───────────────────────────────────────────────────────────────────

  async listBills(
    congress: number,
    billType: string,
    updatedSince?: string,
  ): Promise<BillSummary[]> {
    const rows = await this.listCollection('BILLS', congress, { docClass: billType, updatedSince });
    return rows.map((r) => ({
      billId: r.packageId,
      congress: this.toCongress(r.congress, congress),
      billType,
      billNumber: this.billNumberFromPackageId(r.packageId),
      title: r.title ?? null,
      dateIssued: r.dateIssued ?? null,
      lastModified: r.lastModified ?? null,
      packageLink: r.packageLink ?? null,
    }));
  }

  async getBillText(billId: string): Promise<BillText> {
    const summary = await this.getPackageSummary(billId);
    const xmlLink = summary.download?.xmlLink;
    if (!xmlLink) {
      throw new ServiceUnavailableException(`No XML available for bill ${billId}`);
    }
    const xml = await this.fetchText(xmlLink);
    return { xml, sections: this.parseBillSections(xml) };
  }

  // ── Committee reports ─────────────────────────────────────────────────────────

  async listCommitteeReports(
    congress: number,
    chamber: string,
    kind: string,
    updatedSince?: string,
  ): Promise<ReportSummary[]> {
    const rows = await this.listCollection('CRPT', congress, { updatedSince });
    return rows.map((r) => ({
      reportId: r.packageId,
      congress: this.toCongress(r.congress, congress),
      chamber,
      kind,
      title: r.title ?? null,
      dateIssued: r.dateIssued ?? null,
      lastModified: r.lastModified ?? null,
      packageLink: r.packageLink ?? null,
    }));
  }

  async getCommitteeReport(reportId: string): Promise<CommitteeReport> {
    const metadata = await this.getPackageSummary(reportId);
    const pdfLink = metadata.download?.pdfLink;
    if (!pdfLink) throw new ServiceUnavailableException(`No PDF available for report ${reportId}`);
    const pdfBuffer = await this.fetchPdfCached(reportId, pdfLink);
    return { url: pdfLink, pdfBuffer, metadata };
  }

  // ── Public laws ───────────────────────────────────────────────────────────────

  async getPublicLaw(plawId: string): Promise<PublicLaw> {
    const summary = await this.getPackageSummary(plawId);
    const pdfLink = summary.download?.pdfLink;
    if (!pdfLink)
      throw new ServiceUnavailableException(`No PDF available for public law ${plawId}`);
    const pdfBuffer = await this.fetchPdfCached(plawId, pdfLink);
    return { url: pdfLink, pdfBuffer };
  }

  // ── Congressional hearings (CHRG) — Track B official transcripts (H2) ─────────

  /** List CHRG (Congressional Hearings) packages for a congress. */
  async listHearings(congress: number, updatedSince?: string): Promise<HearingSummary[]> {
    const rows = await this.listCollection('CHRG', congress, { updatedSince });
    return rows.map((r) => ({
      hearingId: r.packageId,
      congress: this.toCongress(r.congress, congress),
      title: r.title ?? null,
      dateIssued: r.dateIssued ?? null,
      lastModified: r.lastModified ?? null,
      packageLink: r.packageLink ?? null,
    }));
  }

  /** Bounded source page, with a frozen window and credential-free continuation. */
  async listHearingsPage(congress: number, since: string, until: string, next?: string | null) {
    const start = since.replace(/\.\d+Z$/, 'Z'),
      end = until.replace(/\.\d+Z$/, 'Z');
    const initial = new URL(
      `collections/CHRG/${encodeURIComponent(start)}/${encodeURIComponent(end)}`,
      GOVINFO_API_ROOT,
    );
    initial.searchParams.set('congress', String(congress));
    initial.searchParams.set('pageSize', '100');
    initial.searchParams.set('offsetMark', '*');
    const clean = (value: string) => {
      const url = new URL(value, GOVINFO_API_ROOT);
      if (
        url.origin !== new URL(GOVINFO_API_ROOT).origin ||
        decodeURIComponent(url.pathname) !== decodeURIComponent(initial.pathname) ||
        url.username ||
        url.password ||
        (url.searchParams.has('congress') && url.searchParams.get('congress') !== String(congress))
      )
        throw new ServiceUnavailableException('GOVINFO_CONTINUATION_SCOPE_MISMATCH');
      url.pathname = initial.pathname;
      url.searchParams.delete('api_key');
      url.searchParams.set('congress', String(congress));
      url.searchParams.set('pageSize', '100');
      return url;
    };
    const page = clean(next ?? initial.href);
    const data = await this.getJsonCached<GovInfoCollectionResponse>(page.href, {});
    return {
      packages: data.packages ?? [],
      nextPage: data.nextPage ? clean(data.nextPage).href : null,
      count: data.count ?? null,
      window: { since: start, until: end },
    };
  }

  /**
   * Fetch a hearing's OFFICIAL transcript as plain text. CHRG packages publish a
   * `txtLink` (plain text) — preferred; falls back to `htmLink` (tags stripped).
   * Throws 503 when neither exists (e.g. scan-only PDF hearings). Text runs
   * through the same 24h JSON cache (for the summary) + rate limiter as the rest.
   */
  async getHearingText(packageId: string): Promise<HearingText> {
    const summary = await this.getPackageSummary(packageId);
    // CHRG package summaries don't populate download.txtLink/htmLink, but the
    // rendered transcript lives at a deterministic content path. Prefer any
    // summary links; otherwise fall back to /content/pkg/{id}/html/{id}.htm.
    // (No plain-.txt is published for CHRG, so htm + tag-strip is the path.)
    const txt = summary.download?.txtLink;
    const htm =
      summary.download?.htmLink ??
      `https://www.govinfo.gov/content/pkg/${encodeURIComponent(packageId)}/html/${encodeURIComponent(packageId)}.htm`;
    const link = txt ?? htm;
    const raw = await this.fetchText(link);
    const format: 'txt' | 'htm' = txt ? 'txt' : 'htm';
    const text = format === 'htm' ? stripHtmlTags(raw) : raw;
    if (!text.trim()) {
      throw new ServiceUnavailableException(
        `No text transcript available for hearing ${packageId}`,
      );
    }
    const mods = summary.download?.modsLink ? await this.fetchText(summary.download.modsLink) : '';
    return {
      packageId,
      text,
      format,
      sourceUrl: link,
      dateIssued: summary.dateIssued ?? null,
      title: summary.title ?? null,
      raw,
      lastModified: summary.lastModified ?? null,
      heldDates: [...mods.matchAll(/<heldDate>([\d-]+)<\/heldDate>/g)].map((m) => m[1]!),
      committees: [
        ...mods.matchAll(
          /<congCommittee authorityId="([a-z0-9]+)" chamber="([HSJ])" congress="(\d+)"/g,
        ),
      ].map((m) => ({ authorityId: m[1]!, chamber: m[2]!, congress: m[3]! })),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private requireKey(): string {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('GovInfo is not configured (GOVINFO_API_KEY unset)');
    }
    return this.apiKey;
  }

  /**
   * List a collection's packages, walking GovInfo's published-collection endpoint.
   * Uses a wide lastModified window when `updatedSince` is omitted.
   */
  private async listCollection(
    collection: string,
    congress: number,
    opts: { docClass?: string; updatedSince?: string },
  ): Promise<GovInfoPackageRow[]> {
    // GovInfo's collections endpoint requires yyyy-MM-dd'T'HH:mm:ss'Z' (NO
    // milliseconds); toISOString() emits ".sssZ", which returns 400 Bad Request.
    const noMs = (iso: string) => iso.replace(/\.\d+Z$/, 'Z');
    const start = noMs(opts.updatedSince ?? '1970-01-01T00:00:00Z');
    const end = noMs(new Date().toISOString());
    const path = `collections/${collection}/${encodeURIComponent(start)}/${encodeURIComponent(end)}`;
    const params: Record<string, string> = {
      congress: String(congress),
      pageSize: '100',
      offsetMark: '*',
    };
    if (opts.docClass) params.docClass = opts.docClass;

    const data = await this.getJsonCached<GovInfoCollectionResponse>(path, params);
    return data.packages ?? [];
  }

  private async getPackageSummary(packageId: string): Promise<GovInfoPackageSummary> {
    const path = `packages/${encodeURIComponent(packageId.trim())}/summary`;
    return this.getJsonCached<GovInfoPackageSummary>(path, {});
  }

  /**
   * GET a GovInfo JSON endpoint with a 24h pg cache. Cache key is the request URL
   * with the api_key stripped, so the secret never lands in the DB.
   */
  private async getJsonCached<T>(path: string, params: Record<string, string>): Promise<T> {
    const key = this.requireKey();
    const url = new URL(path, GOVINFO_API_ROOT);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const cacheUrl = url.toString(); // api_key NOT yet appended → safe cache key
    url.searchParams.set('api_key', key);

    const cached = await this.prisma.govInfoCache.findUnique({ where: { url: cacheUrl } });
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
      return cached.response as T;
    }

    await this.limiter.acquire();
    const response = await fetchJson<T>(url, { secrets: [key] });
    // Some source continuations include credentials. They are not evidence and
    // must never be persisted inside the cached JSON body either.
    const sanitized = JSON.parse(JSON.stringify(response).split(key).join('[redacted]')) as T;

    await this.prisma.govInfoCache.upsert({
      where: { url: cacheUrl },
      create: { url: cacheUrl, response: sanitized as object, fetchedAt: new Date() },
      update: { response: sanitized as object, fetchedAt: new Date() },
    });
    return sanitized;
  }

  /** Fetch raw text (e.g. bill XML) through the rate limiter, with api_key auth. */
  private async fetchText(link: string): Promise<string> {
    const key = this.requireKey();
    const url = new URL(link);
    if (
      url.protocol !== 'https:' ||
      !['www.govinfo.gov', 'api.govinfo.gov', 'govinfo.gov'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new ServiceUnavailableException('Unqualified GovInfo text URL');
    url.searchParams.set('api_key', key);
    await this.limiter.acquire();
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `GovInfo text fetch failed (${res.status}) for ${redactSecrets(url.toString(), [key])}`,
      );
    }
    if (Number(res.headers?.get('content-length') ?? 0) > 30000000)
      throw new ServiceUnavailableException('GovInfo text exceeds qualified size');
    const content = await res.text();
    if (content.length > 30000000)
      throw new ServiceUnavailableException('GovInfo text exceeds qualified size');
    return content;
  }

  /**
   * Fetch a PDF, caching it in S3 under {bucket}/pdfs/{packageId}.pdf. A cache hit
   * skips the upstream HTTP request entirely.
   */
  private async fetchPdfCached(packageId: string, link: string): Promise<Buffer> {
    const s3Key = `${S3_PDF_PREFIX}/${packageId}.pdf`;
    if (this.cacheBucket) {
      const hit = await this.s3
        .send(new GetObjectCommand({ Bucket: this.cacheBucket, Key: s3Key }))
        .catch(() => null);
      if (hit?.Body) {
        const bytes = await hit.Body.transformToByteArray();
        return Buffer.from(bytes);
      }
    }

    const key = this.requireKey();
    const url = new URL(link);
    url.searchParams.set('api_key', key);
    await this.limiter.acquire();
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `GovInfo PDF fetch failed (${res.status}) for ${redactSecrets(url.toString(), [key])}`,
      );
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    if (this.cacheBucket) {
      await this.s3
        .send(
          new PutObjectCommand({
            Bucket: this.cacheBucket,
            Key: s3Key,
            Body: buffer,
            ContentType: 'application/pdf',
            ServerSideEncryption: 'AES256',
          }),
        )
        .catch((err: unknown) =>
          this.logger.warn(`S3 cache write failed for ${s3Key}: ${String(err)}`),
        );
    }
    return buffer;
  }

  /** Extract <section> elements from USLM/GovInfo bill XML into a flat list. */
  private parseBillSections(xml: string): BillSection[] {
    let parsed: unknown;
    try {
      parsed = this.xml.parse(xml);
    } catch (err) {
      this.logger.warn(`Bill XML parse failed: ${String(err)}`);
      return [];
    }
    const sections: BillSection[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      for (const [tag, value] of Object.entries(obj)) {
        if (tag.toLowerCase() === 'section') {
          for (const sec of Array.isArray(value) ? value : [value]) {
            const s = sec as Record<string, unknown>;
            sections.push({
              number: this.text(s.num ?? s.enum ?? s['@_id']) || null,
              heading: this.text(s.heading ?? s.header) || null,
              text: this.text(s).trim(),
            });
            visit(sec);
          }
        } else {
          visit(value);
        }
      }
    };
    visit(parsed);
    return sections;
  }

  /** Flatten a parsed-XML node to plain text. */
  private text(node: unknown): string {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map((n) => this.text(n)).join(' ');
    if (typeof node === 'object') {
      return Object.entries(node as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('@_'))
        .map(([, v]) => this.text(v))
        .join(' ');
    }
    return '';
  }

  private toCongress(raw: string | number | undefined, fallback: number): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private billNumberFromPackageId(packageId: string): string | null {
    // e.g. BILLS-118hr3935ih -> "3935"
    const m = packageId.match(/[a-z]+(\d+)[a-z]*$/i);
    return m ? m[1]! : null;
  }
}

/** Minimal HTML→text for the GovInfo HTM transcript fallback (txt is preferred):
 *  drop script/style + tags, decode a few entities, collapse whitespace. */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}
