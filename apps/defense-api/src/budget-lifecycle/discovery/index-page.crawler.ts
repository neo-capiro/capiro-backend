/**
 * Phase 8 Session 8 — index-page and feed crawler.
 *
 * Covers the ten adapters that publish neither a sitemap nor a key-free API: the
 * comptroller and the three service comptrollers, HASC, SASC, both appropriations
 * committees, the reprogramming page, and the contract-announcement feed.
 *
 * Measured reality, recorded rather than wished away: four of those hosts refuse a
 * plain client outright (Akamai 403 on `comptroller.defense.gov`,
 * `asafm.army.mil` and `www.defense.gov`; no connection at all to
 * `saffm.hq.af.mil`), and the committee pages that do answer are largely
 * script-rendered and expose few direct document links. This crawler is therefore
 * correct rather than productive: it extracts what is genuinely linked, records a
 * refusal as a refusal, and never converts "we were turned away" into "nothing was
 * published". Making these publishers yield more is an egress/allowlisting
 * question for the deployment session, not something code can assert.
 *
 * Anchor text is the only title-like evidence these publishers offer — there is no
 * MODS record behind a service comptroller exhibit — so it is passed to resolution
 * as the title. If it is insufficient, resolution fails closed exactly as it does
 * for a GovInfo package with an unhelpful record.
 */

import { Injectable, Logger } from '@nestjs/common';

import {
  budgetExhausted,
  extractDocumentLinks,
  extractFeedItems,
  resolveDiscoveredCandidate,
  spendRequest,
  type RequestBudget,
} from '@capiro/defense-domain';

import type { DiscoveredCandidate } from '../lifecycle-ports.js';
import { sha256Of } from './https-publisher-http.adapter.js';
import type { PublisherHttpPort } from './publisher-http.port.js';
import type { NewDiscoveryCandidate, NewDiscoveryCrawl } from './discovery-audit.port.js';
import {
  entryPointsFor,
  type CrawlContext,
  type CrawlProduct,
  type PublisherCrawler,
} from './publisher-crawler.js';

@Injectable()
export class IndexPageCrawler implements PublisherCrawler {
  private readonly logger = new Logger(IndexPageCrawler.name);

  constructor(private readonly http: PublisherHttpPort) {}

  async crawl(context: CrawlContext): Promise<CrawlProduct> {
    const isFeed = context.adapter.discoveryMode === 'feed';
    const candidates: DiscoveredCandidate[] = [];
    const auditCandidates: NewDiscoveryCandidate[] = [];
    const crawls: NewDiscoveryCrawl[] = [];
    let budget: RequestBudget = context.budget;

    const entryPoints = entryPointsFor(context.adapter.adapterId, context.horizonFiscalYears);
    if (entryPoints.length === 0) {
      this.logger.warn(
        `${context.adapter.adapterId}: no published entry point is registered; discovery ` +
          'produced no candidates and recorded no crawl.',
      );
    }

    for (const entryPoint of entryPoints) {
      if (budgetExhausted(budget)) {
        this.logger.warn(
          `${context.adapter.adapterId}: request budget exhausted before ${entryPoint}; ` +
            `${entryPoints.length} entry points were in scope.`,
        );
        break;
      }

      const startedAt = new Date().toISOString();
      const result = await this.http.get({
        url: entryPoint,
        adapterId: context.adapter.adapterId,
        allowedHosts: context.adapter.officialHosts,
        nowIso: context.nowIso,
      });
      budget = spendRequest(budget);

      const items = !result.body
        ? []
        : isFeed
          ? extractFeedItems({
              xml: result.body,
              officialHosts: context.adapter.officialHosts,
            }).map((item) => ({ url: item.url, text: item.title }))
          : extractDocumentLinks({
              html: result.body,
              pageUrl: entryPoint,
              officialHosts: context.adapter.officialHosts,
              // SASC's official library now publishes same-host download aliases.
              extensionlessDocumentPathPrefixes:
                context.adapter.adapterId === 'sasc' ? ['/download/'] : undefined,
            }).map((link) => ({ url: link.url, text: link.text }));

      crawls.push(
        Object.freeze({
          adapterId: context.adapter.adapterId,
          runKey: context.runKey,
          requestUrl: entryPoint,
          resourceKind: isFeed ? ('feed' as const) : ('listing' as const),
          statusCode: result.statusCode,
          status: result.ok
            ? ('succeeded' as const)
            : result.statusCode === null
              ? result.failureReason?.startsWith('robots.txt disallows') === true
                ? ('blocked_by_robots' as const)
                : ('unreachable' as const)
              : ('blocked_by_publisher' as const),
          contentSha256: result.body === null ? null : sha256Of(result.body),
          byteSize: result.byteSize,
          itemsSeen: items.length,
          robotsUnavailable: false,
          effectiveIntervalMs: context.adapter.minRequestIntervalMs,
          startedAt,
          finishedAt: new Date().toISOString(),
          failureReason: result.failureReason,
        }),
      );

      if (!result.ok) {
        this.logger.warn(
          `${context.adapter.adapterId}: ${entryPoint} -> ` +
            `${result.statusCode ?? 'no response'} (${result.failureReason ?? 'refused'}). ` +
            'Recorded as a publisher refusal, not as an absence of documents.',
        );
        continue;
      }

      for (const item of items) {
        const resolved = resolveDiscoveredCandidate({
          adapterId: context.adapter.adapterId,
          url: item.url,
          // These publishers have no official package identifier.
          packageId: null,
          title: item.text === '' ? null : item.text,
          declaredFiscalYear: null,
          divisionEvidence: null,
          horizonFiscalYears: context.horizonFiscalYears,
          registeredExpectedSourceKeys: context.registeredExpectedSourceKeys,
        });

        const emitted = resolved.outcome === 'resolved';
        auditCandidates.push({
          adapterId: context.adapter.adapterId,
          runKey: context.runKey,
          candidateUrl: item.url,
          packageId: null,
          title: item.text === '' ? null : item.text,
          resolution: resolved.outcome,
          expectedSourceDedupKey: resolved.expectedSourceDedupKey,
          classifiedFiscalYear: resolved.provisionalClassification?.fiscalYear ?? null,
          reason: resolved.reasons.join('; '),
          emitted,
          observedAt: context.nowIso,
        });

        if (emitted && resolved.expectedSourceDedupKey) {
          candidates.push(
            Object.freeze({
              adapterId: context.adapter.adapterId,
              expectedSourceDedupKey: resolved.expectedSourceDedupKey,
              url: item.url,
              packageId: null,
              title: item.text === '' ? null : item.text,
              declaredFiscalYear: resolved.provisionalClassification?.fiscalYear ?? null,
              divisionEvidence: null,
              versionRank: null,
            }),
          );
        }
      }
    }

    return Object.freeze({
      candidates: Object.freeze(candidates),
      auditCandidates: Object.freeze(auditCandidates),
      crawls: Object.freeze(crawls),
      // Index pages carry no per-item change signal, so there is no watermark to
      // advance. The Session 7 byte comparison is what makes re-seeing free.
      cursor: context.cursor,
      budget,
    });
  }
}
