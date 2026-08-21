/**
 * Phase 8 Session 8 — publisher HTTP port.
 *
 * Live crawling is behind an interface for the same reason Session 7 put byte
 * retrieval behind one: the crawl logic — which collections to walk, which
 * candidates resolve, what the cursor becomes — has to be testable against real
 * recorded publisher responses without a network.
 *
 * A retrieval that fails is a first-class outcome, not an exception. Four of the
 * fourteen registered publishers were verified unreachable from a plain client
 * (`comptroller.defense.gov`, `asafm.army.mil` and `www.defense.gov` answer
 * Akamai 403; `saffm.hq.af.mil` does not connect at all), so "the publisher
 * refused us" is a normal, recordable state that must never be reported as
 * "there was nothing to find".
 */

export interface PublisherFetchResult {
  /** HTTP status, or `null` when the request never produced a response. */
  readonly statusCode: number | null;
  readonly body: string | null;
  /** Publisher-declared retry hint, verbatim. */
  readonly retryAfter: string | null;
  readonly lastModified: string | null;
  readonly etag: string | null;
  readonly ok: boolean;
  /** Transport-level explanation when `statusCode` is null. */
  readonly failureReason: string | null;
  /** Bytes actually read, for the audit row. */
  readonly byteSize: number | null;
}

export interface PublisherHttpPort {
  /**
   * Retrieve a text resource (robots.txt, sitemap, listing page, feed, MODS).
   *
   * Implementations must apply per-host pacing and must not follow a redirect to
   * a host outside `allowedHosts`.
   */
  get(input: {
    url: string;
    adapterId: string;
    allowedHosts: readonly string[];
    nowIso: string;
    /** Conditional headers, purely a bandwidth optimisation. */
    conditionalHeaders?: Readonly<Record<string, string>>;
  }): Promise<PublisherFetchResult>;
}

export const PUBLISHER_HTTP_PORT = Symbol('PUBLISHER_HTTP_PORT');
