/**
 * Phase 8 Session 8 — real HTTPS publisher client.
 *
 * Everything here exists because of something a real publisher actually does:
 *
 *  * **Pacing is per host, and the host may be stricter than we are.** Two
 *    adapters share `comptroller.defense.gov` and three share `www.govinfo.gov`,
 *    so a per-adapter limiter would multiply the real request rate. congress.gov
 *    declares `Crawl-delay: 2` against a registry minimum of 1000 ms, so the
 *    effective interval is the maximum of the two.
 *
 *  * **A refusal is a result, not a crash.** `comptroller.defense.gov`,
 *    `asafm.army.mil` and `www.defense.gov` answer a plain client with an Akamai
 *    403, and `saffm.hq.af.mil` does not connect at all. Those are returned as
 *    outcomes carrying the real status so the audit row can say "the publisher
 *    refused us" instead of "nothing was published".
 *
 *  * **A redirect may not change host.** `redirect: 'manual'` plus an explicit
 *    allowlist check on every hop means a publisher cannot bounce discovery onto
 *    a mirror that is not on the adapter's official host list.
 *
 *  * **robots.txt is fetched once per host and cached**, so evaluating a
 *    thousand candidate paths costs one request.
 */

import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import {
  effectiveRequestIntervalMs,
  evaluateRobots,
  nextHostRequestAt,
  parseRobotsTxt,
  retryAfterMs,
  robotsPolicyFromFetch,
  type RobotsPolicy,
} from '@capiro/defense-domain';

import type { PublisherFetchResult, PublisherHttpPort } from './publisher-http.port.js';

export const DISCOVERY_USER_AGENT =
  'Capiro-Phase8-Session8-SourceDiscovery/1.0 (+official-source-discovery; contact: platform@capiro.ai)';

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpsPublisherHttpOptions {
  readonly timeoutMs?: number;
  /** Registry-declared minimum interval, by adapter id. */
  readonly minRequestIntervalMs: (adapterId: string) => number;
  /**
   * Cross-worker slot reservation. Injected so the in-process limiter can be
   * backed by the atomic database claim in a real run, and by a deterministic
   * stub in tests.
   */
  readonly reserveHostSlot?: (input: {
    host: string;
    intervalMs: number;
    nowIso: string;
  }) => Promise<{ waitMs: number }>;
  /** Overridable so tests never actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Real-time clock used ONLY for pacing decisions — deliberately independent
   * of the `nowIso` a caller passes into `get()`/`robotsFor()`.
   *
   * The job runtime (`job.mjs`) captures its own `nowIso` exactly once at
   * process start and threads that SAME frozen value through every request of
   * a crawl that can run for hours, so that audit/`observedAt` timestamps stay
   * deterministic and reproducible. Pacing, however, has to compare against
   * how much real time has actually elapsed since the last real request. If
   * pacing reuses the frozen `nowIso` while `lastRequestAt` legitimately
   * advances with the real wall clock (as it must, to represent when a
   * request truly went out), `nextHostRequestAt` computes a wait against an
   * origin that never moves — so each wait grows to cover the ENTIRE elapsed
   * real time so far plus one interval, and that produces an exact doubling
   * series (1s, 2s, 4s, 8s, ... ~16384s by the 16th request) instead of a
   * bounded ~`intervalMs` spacing. This is the confirmed root cause of the
   * Phase 10 `govinfo-public-laws` discovery run that took 7h43m of real wall
   * clock for only 16 host-pacing reservations.
   *
   * Defaults to the real `Date.now()`-backed clock; tests inject a fake one so
   * `sleep()` can simulate elapsed time without an actual wait.
   */
  readonly clock?: () => string;
}

interface HostState {
  robots: RobotsPolicy | null;
  lastRequestAt: string | null;
}

@Injectable()
export class HttpsPublisherHttpAdapter implements PublisherHttpPort {
  private readonly logger = new Logger(HttpsPublisherHttpAdapter.name);
  private readonly hosts = new Map<string, HostState>();

  constructor(private readonly options: HttpsPublisherHttpOptions) {}

  /** Exposed so a crawl can record which robots policy governed its decisions. */
  async robotsFor(input: {
    host: string;
    adapterId: string;
    nowIso: string;
  }): Promise<RobotsPolicy> {
    const state = this.hostState(input.host);
    if (state.robots) return state.robots;

    const result = await this.rawGet({
      url: `https://${input.host}/robots.txt`,
      adapterId: input.adapterId,
      allowedHosts: [input.host],
      nowIso: input.nowIso,
      // robots.txt itself is never gated on robots.txt.
      skipRobots: true,
    });

    const policy = robotsPolicyFromFetch({
      statusCode: result.statusCode,
      body: result.body,
    });
    state.robots = policy;
    return policy;
  }

  async get(input: {
    url: string;
    adapterId: string;
    allowedHosts: readonly string[];
    nowIso: string;
    conditionalHeaders?: Readonly<Record<string, string>>;
  }): Promise<PublisherFetchResult> {
    return this.rawGet({ ...input, skipRobots: false });
  }

  private hostState(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { robots: null, lastRequestAt: null };
      this.hosts.set(host, state);
    }
    return state;
  }

  private async rawGet(input: {
    url: string;
    adapterId: string;
    allowedHosts: readonly string[];
    nowIso: string;
    conditionalHeaders?: Readonly<Record<string, string>>;
    skipRobots: boolean;
  }): Promise<PublisherFetchResult> {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return failure(`malformed url: ${input.url}`);
    }
    if (parsed.protocol !== 'https:') return failure(`refusing non-https url: ${input.url}`);
    if (!input.allowedHosts.includes(parsed.hostname)) {
      return failure(`refusing host outside the adapter allowlist: ${parsed.hostname}`);
    }

    const state = this.hostState(parsed.hostname);
    let crawlDelaySeconds: number | null = null;

    if (!input.skipRobots) {
      const policy = await this.robotsFor({
        host: parsed.hostname,
        adapterId: input.adapterId,
        nowIso: input.nowIso,
      });
      const decision = evaluateRobots({
        policy,
        userAgent: DISCOVERY_USER_AGENT,
        pathAndQuery: `${parsed.pathname}${parsed.search}`,
      });
      crawlDelaySeconds = decision.crawlDelaySeconds;
      if (!decision.allowed) {
        // robots.txt said no. That is a legitimate, recordable outcome.
        return Object.freeze({
          statusCode: null,
          body: null,
          retryAfter: null,
          lastModified: null,
          etag: null,
          ok: false,
          failureReason: `robots.txt disallows ${parsed.pathname}: ${decision.reason}`,
          byteSize: null,
        });
      }
    }

    const intervalMs = effectiveRequestIntervalMs({
      registryMinRequestIntervalMs: this.options.minRequestIntervalMs(input.adapterId),
      robotsCrawlDelaySeconds: crawlDelaySeconds,
    });

    await this.pace({
      host: parsed.hostname,
      intervalMs,
      lastRequestAt: state.lastRequestAt,
    });
    state.lastRequestAt = this.realNowIso();

    return this.follow({
      url: parsed,
      allowedHosts: input.allowedHosts,
      conditionalHeaders: input.conditionalHeaders ?? {},
      nowIso: input.nowIso,
      hops: 0,
    });
  }

  private async pace(input: {
    host: string;
    intervalMs: number;
    lastRequestAt: string | null;
  }): Promise<void> {
    // Pacing MUST use real elapsed time, never the caller's `nowIso` — that
    // value is captured once at job start and held frozen for the lifetime of
    // a crawl (deliberately, so audit/observedAt timestamps stay
    // deterministic). `state.lastRequestAt` and the DB's own row timestamps
    // are genuinely real wall-clock; comparing a frozen origin against a
    // really-advancing one made every wait grow to cover the entire elapsed
    // run so far, doubling on each request (root cause of the Phase 10
    // govinfo-public-laws 7h43m/16-reservation hang). Both the cross-worker
    // DB reservation and the local same-process check must use this same
    // real clock so neither one silently reintroduces the bug.
    const paceNowIso = this.realNowIso();

    // Cross-worker reservation first: two workers on adapters that share a host
    // must not both conclude they may issue immediately.
    const reserved = await this.options.reserveHostSlot?.({
      host: input.host,
      intervalMs: input.intervalMs,
      nowIso: paceNowIso,
    });

    const local = nextHostRequestAt({
      nowIso: paceNowIso,
      lastRequestAt: input.lastRequestAt,
      intervalMs: input.intervalMs,
    });

    const waitMs = Math.max(reserved?.waitMs ?? 0, local.waitMs);
    if (waitMs > 0) await this.sleep(waitMs);
  }

  private realNowIso(): string {
    return this.options.clock ? this.options.clock() : new Date().toISOString();
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms);
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async follow(input: {
    url: URL;
    allowedHosts: readonly string[];
    conditionalHeaders: Readonly<Record<string, string>>;
    nowIso: string;
    hops: number;
  }): Promise<PublisherFetchResult> {
    if (input.hops > MAX_REDIRECTS) return failure(`too many redirects for ${input.url.toString()}`);

    let response: Response;
    try {
      response = await fetch(input.url, {
        headers: {
          'user-agent': DISCOVERY_USER_AGENT,
          accept: '*/*',
          ...input.conditionalHeaders,
        },
        // Manual, so every hop is host-checked rather than trusted.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return failure(`redirect without location from ${input.url.toString()}`);
      let next: URL;
      try {
        next = new URL(location, input.url);
      } catch {
        return failure(`malformed redirect target: ${location}`);
      }
      if (next.protocol !== 'https:' || !input.allowedHosts.includes(next.hostname)) {
        return failure(
          `redirect leaves the adapter allowlist: ${input.url.hostname} -> ${next.hostname}`,
        );
      }
      return this.follow({ ...input, url: next, hops: input.hops + 1 });
    }

    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) {
      const waitMs = retryAfterMs({ headerValue: retryAfter, nowIso: input.nowIso });
      if (waitMs !== null) {
        this.logger.warn(
          `${input.url.hostname} asked us to retry after ${Math.round(waitMs / 1_000)}s`,
        );
      }
    }

    if (response.status === 304) {
      return Object.freeze({
        statusCode: 304,
        body: null,
        retryAfter,
        lastModified: response.headers.get('last-modified'),
        etag: response.headers.get('etag'),
        ok: true,
        failureReason: null,
        byteSize: null,
      });
    }

    if (!response.ok) {
      return Object.freeze({
        statusCode: response.status,
        body: null,
        retryAfter,
        lastModified: response.headers.get('last-modified'),
        etag: response.headers.get('etag'),
        ok: false,
        failureReason: `HTTP ${response.status} from ${input.url.hostname}`,
        byteSize: null,
      });
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
    if (bytes.length > MAX_BODY_BYTES) {
      return failure(`response exceeds ${MAX_BODY_BYTES} bytes: ${input.url.toString()}`);
    }

    return Object.freeze({
      statusCode: response.status,
      body: bytes.toString('utf8'),
      retryAfter,
      lastModified: response.headers.get('last-modified'),
      etag: response.headers.get('etag'),
      ok: true,
      failureReason: null,
      byteSize: bytes.length,
    });
  }
}

function failure(reason: string): PublisherFetchResult {
  return Object.freeze({
    statusCode: null,
    body: null,
    retryAfter: null,
    lastModified: null,
    etag: null,
    ok: false,
    failureReason: reason,
    byteSize: null,
  });
}

export function sha256Of(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Re-exported so a caller can pre-seed a policy in a test without a network. */
export { parseRobotsTxt };
