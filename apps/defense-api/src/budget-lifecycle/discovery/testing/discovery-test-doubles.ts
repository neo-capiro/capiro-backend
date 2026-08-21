/**
 * Phase 8 Session 8 — test doubles for live discovery.
 *
 * A recorded-response HTTP port and an in-memory audit store, so the crawl logic
 * can be driven against real captured publisher bytes with no network and no
 * database. Same reason Session 7 shipped fixture ports: the parts that can fail
 * silently — resolution, cursor advance, budget exhaustion, host pacing — must be
 * testable deterministically.
 */

import {
  effectiveRequestIntervalMs,
  nextHostRequestAt,
  type CandidateResolutionOutcome,
} from '@capiro/defense-domain';

import type {
  DiscoveryAuditStore,
  NewDiscoveryCandidate,
  NewDiscoveryCrawl,
} from '../discovery-audit.port.js';
import type { PublisherFetchResult, PublisherHttpPort } from '../publisher-http.port.js';

export interface RecordedResponse {
  readonly statusCode: number | null;
  readonly body: string | null;
  readonly failureReason?: string | null;
  readonly lastModified?: string | null;
  readonly etag?: string | null;
}

/**
 * Serves recorded responses by exact URL.
 *
 * A URL with no recording is a hard failure rather than an empty body: a test
 * that silently reads nothing would pass for the wrong reason.
 */
export class RecordedPublisherHttp implements PublisherHttpPort {
  readonly requested: string[] = [];

  constructor(private readonly responses: Map<string, RecordedResponse>) {}

  async get(input: {
    url: string;
    adapterId: string;
    allowedHosts: readonly string[];
    nowIso: string;
  }): Promise<PublisherFetchResult> {
    this.requested.push(input.url);

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return frozen({ statusCode: null, body: null, failureReason: `malformed url: ${input.url}` });
    }
    if (!input.allowedHosts.includes(parsed.hostname)) {
      return frozen({
        statusCode: null,
        body: null,
        failureReason: `refusing host outside the adapter allowlist: ${parsed.hostname}`,
      });
    }

    const recorded = this.responses.get(input.url);
    if (!recorded) {
      return frozen({
        statusCode: null,
        body: null,
        failureReason: `no recorded response for ${input.url}`,
      });
    }
    return frozen(recorded);
  }
}

function frozen(recorded: RecordedResponse): PublisherFetchResult {
  const ok =
    recorded.statusCode !== null && recorded.statusCode >= 200 && recorded.statusCode < 300;
  return Object.freeze({
    statusCode: recorded.statusCode,
    body: ok ? recorded.body : null,
    retryAfter: null,
    lastModified: recorded.lastModified ?? null,
    etag: recorded.etag ?? null,
    ok,
    failureReason: ok
      ? null
      : (recorded.failureReason ??
        (recorded.statusCode === null
          ? 'no response'
          : `HTTP ${recorded.statusCode}`)),
    byteSize: recorded.body === null ? null : Buffer.byteLength(recorded.body, 'utf8'),
  });
}

export class InMemoryDiscoveryAuditStore implements DiscoveryAuditStore {
  readonly crawls: NewDiscoveryCrawl[] = [];
  readonly candidates: NewDiscoveryCandidate[] = [];
  readonly hostReservations: { host: string; intervalMs: number; nowIso: string }[] = [];

  private sequence = 0;
  private readonly lastReservedByHost = new Map<string, string>();
  private readonly seenCandidateKeys = new Set<string>();

  constructor(private readonly registeredKeys: ReadonlySet<string> = new Set()) {}

  async recordCrawl(crawl: NewDiscoveryCrawl): Promise<{ id: string }> {
    this.crawls.push(crawl);
    this.sequence += 1;
    return { id: `crawl-${this.sequence}` };
  }

  async recordCandidates(input: {
    crawlId: string;
    candidates: readonly NewDiscoveryCandidate[];
  }): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const candidate of input.candidates) {
      // Mirrors the real unique index so a retry cannot duplicate the trail.
      const key = `${candidate.adapterId}|${candidate.runKey}|${candidate.candidateUrl}`;
      if (this.seenCandidateKeys.has(key)) continue;

      // Mirrors the database CHECK: resolved <=> carries a dedup key.
      const resolved = candidate.resolution === ('resolved' as CandidateResolutionOutcome);
      if (resolved !== (candidate.expectedSourceDedupKey !== null)) {
        throw new Error(
          `discovery candidate violates the resolved/dedup-key invariant: ${candidate.candidateUrl}`,
        );
      }
      if (candidate.emitted && !resolved) {
        throw new Error(`unresolved candidate marked emitted: ${candidate.candidateUrl}`);
      }

      this.seenCandidateKeys.add(key);
      this.candidates.push(candidate);
      inserted += 1;
    }
    return { inserted };
  }

  async reserveHostSlot(input: {
    host: string;
    intervalMs: number;
    nowIso: string;
  }): Promise<{ waitMs: number; reservedAt: string }> {
    this.hostReservations.push(input);
    const decision = nextHostRequestAt({
      nowIso: input.nowIso,
      lastRequestAt: this.lastReservedByHost.get(input.host) ?? null,
      intervalMs: input.intervalMs,
    });
    this.lastReservedByHost.set(input.host, decision.earliestNextRequestAt);
    return { waitMs: decision.waitMs, reservedAt: decision.earliestNextRequestAt };
  }

  async loadRegisteredExpectedSourceKeys(): Promise<ReadonlySet<string>> {
    return this.registeredKeys;
  }
}

/** Re-exported so a pacing test does not need to import the domain directly. */
export { effectiveRequestIntervalMs };
