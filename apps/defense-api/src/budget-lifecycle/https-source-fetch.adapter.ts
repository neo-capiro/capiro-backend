/**
 * Real HTTPS source fetcher.
 *
 * Downloads authoritative bytes, hashes them, and — where the publisher offers a
 * text rendition — fetches that too for classification corroboration.
 *
 * Two real GovInfo behaviours are handled explicitly because both were observed
 * against live packages while building Session 7:
 *
 *  1. GovInfo serves `Last-Modified` but NO `ETag` on its PDF packages. A design
 *     that relied on validators would be blind on the most important sources,
 *     which is why the content SHA is the authoritative identity.
 *  2. GovInfo answers a missing `.htm` rendition with HTTP **200** and an HTML
 *     "Page Not Found | GovInfo" body. Treating that as document text would feed
 *     the classifier a boilerplate error page, so it is detected and reported as
 *     "no rendition available" rather than as content.
 */

import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import type { FetchedSource, SourceFetchPort } from './lifecycle-ports.js';

const USER_AGENT = 'Capiro-Phase8-Session7-LifecycleWatcher/1.0 (+source-grounded-ingestion)';
const EXCERPT_CHARS = 8_000;

/** Publisher error pages that arrive with a 200 status. */
const SOFT_404_PATTERNS: readonly RegExp[] = Object.freeze([
  /Page Not Found \| GovInfo/i,
  /<title>\s*404\b/i,
]);

export interface HttpsSourceFetchOptions {
  /** Maps a document URL to its official text rendition, when one exists. */
  readonly textRenditionUrl?: (url: string) => string | null;
  readonly timeoutMs?: number;
}

@Injectable()
export class HttpsSourceFetchAdapter implements SourceFetchPort {
  private readonly logger = new Logger(HttpsSourceFetchAdapter.name);

  constructor(private readonly options: HttpsSourceFetchOptions = {}) {}

  async fetch(input: {
    url: string;
    conditionalHeaders: Readonly<Record<string, string>>;
  }): Promise<FetchedSource> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;

    let response: Response;
    try {
      response = await fetch(input.url, {
        headers: { 'user-agent': USER_AGENT, ...input.conditionalHeaders },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return this.blocked(error instanceof Error ? error.message : String(error));
    }

    if (response.status === 304) {
      return Object.freeze({
        notModified: true,
        contentSha256: null,
        byteSize: null,
        httpEtag: response.headers.get('etag'),
        httpLastModified: response.headers.get('last-modified'),
        contentExcerpt: null,
        contentExcerptAvailable: false,
      });
    }

    if (!response.ok) {
      return this.blocked(`HTTP ${response.status} for ${input.url}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return this.blocked(`empty body for ${input.url}`);

    const rendition = await this.fetchTextRendition(input.url);

    return Object.freeze({
      notModified: false,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      httpEtag: response.headers.get('etag'),
      httpLastModified: response.headers.get('last-modified'),
      contentExcerpt: rendition,
      contentExcerptAvailable: rendition !== null,
    });
  }

  private async fetchTextRendition(documentUrl: string): Promise<string | null> {
    const renditionUrl = this.options.textRenditionUrl?.(documentUrl) ?? null;
    if (!renditionUrl) return null;
    try {
      const response = await fetch(renditionUrl, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
      if (!response.ok) return null;
      const raw = await response.text();
      if (SOFT_404_PATTERNS.some((pattern) => pattern.test(raw))) {
        this.logger.debug(`No text rendition for ${documentUrl} (publisher soft-404)`);
        return null;
      }
      return stripMarkup(raw).slice(0, EXCERPT_CHARS);
    } catch {
      return null;
    }
  }

  private blocked(reason: string): FetchedSource {
    return Object.freeze({
      notModified: false,
      contentSha256: null,
      byteSize: null,
      httpEtag: null,
      httpLastModified: null,
      contentExcerpt: null,
      contentExcerptAvailable: false,
      blocked: true,
      blockedReason: reason,
    });
  }
}

export function stripMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * GovInfo text-rendition resolver. `.../pkg/<ID>/pdf/<ID>.pdf` has a sibling
 * `.../pkg/<ID>/html/<ID>.htm` for CRPT, BILLS and PLAW packages. BUDGET
 * packages have none, and the soft-404 detection above handles that.
 */
export function govinfoTextRenditionUrl(url: string): string | null {
  const match = /^(https:\/\/(?:www\.)?govinfo\.gov\/content\/pkg\/([^/]+))\/pdf\/\2\.pdf$/.exec(url);
  if (!match) return null;
  return `${match[1]}/html/${match[2]}.htm`;
}
