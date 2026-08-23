/**
 * Phase 8 Session 8 — GovInfo sitemap crawler.
 * Phase 10 — fine-grained resumability inside an active collection.
 *
 * Walks the key-free sitemap channel: collection index -> year sitemaps ->
 * package ids -> MODS titles -> resolved candidates. Every step below is shaped
 * by a verified property of the real files.
 *
 *  * **The index is unordered and spans decades.** `CRPT_sitemap_index.xml` lists
 *    2001, 2015, 2004, 2005, 2011 in that order. Year files are sorted and then
 *    restricted to the calendar years the bootstrapped horizon could plausibly
 *    touch, so a FY28 crawl does not walk 2001.
 *
 *  * **`lastmod` is metadata mtime, not publication date.** Real FY2024 packages
 *    carry `lastmod` in late 2024 and 2025. It is used only as a change signal.
 *
 *  * **The sitemap gives no usable title.** `/app/details/<id>` has a generic
 *    page title, so the authoritative subject comes from
 *    `/metadata/pkg/<id>/mods.xml`. That is one request per surviving candidate,
 *    which is why the cheap id-shape prefilter below matters: `BILLS_2023` alone
 *    holds 13,354 packages.
 *
 *  * **A bounded run must be resumable and must say so.** The budget can be
 *    exhausted mid-collection. The durable collection watermark is then
 *    deliberately NOT advanced past unexamined work, `backfillPending` is set,
 *    and the shortfall is logged — a silent cap would read as "nothing left to
 *    find".
 *
 *  * **Phase 10: a real backlog can outlive many bounded runs' watermark rule
 *    alone.** The real FY2024 PLAW backlog needs more than one 250-request pass
 *    to walk, and the watermark by design never moves until the WHOLE collection
 *    is exhausted — so, before this file, four separate bounded passes restarted
 *    the sitemap from the beginning and hit the identical wall every time. The
 *    fix is a second, finer-grained checkpoint: `resumeAfterPackageId` (see
 *    `crawl-cursor.ts`), which advances package-by-package inside an unfinished
 *    collection walk and lets the NEXT pass skip straight past everything
 *    already fully handled — no MODS re-fetch, no re-classification — while the
 *    durable watermark keeps advancing only on genuine exhaustion, unchanged.
 *
 *    The crawl is restructured into two phases to make this safe:
 *
 *    1. fetch every relevant year sitemap for this pass and flatten their
 *       entries into one deterministic, ordered candidate list (package id +
 *       right collection only — the same filter the old inline loop applied);
 *    2. locate the persisted `resumeAfterPackageId` in THAT list and start
 *       immediately after it. If it cannot be found — the listing changed and
 *       the checkpoint package no longer exists at all — this fails safe: the
 *       walk starts from the very beginning of the candidate list rather than
 *       guessing a position by array index. A little replay is acceptable
 *       because persistence is SHA-based and idempotent; silently skipping is
 *       not.
 *
 *    A checkpoint is only ever set on a package whose discovery handling
 *    (resolved-and-recorded, unresolved-and-recorded, or structurally rejected
 *    by the id-shape prefilter) completed inside this pass. The package the
 *    budget ran out on mid-handling is never checkpointed — the next pass
 *    replays exactly it, never more.
 */

import { Injectable, Logger } from '@nestjs/common';

import {
  advanceCollectionCursor,
  alreadyEmittedAtWatermark,
  budgetExhausted,
  budgetRemaining,
  collectionCursor,
  govinfoCollectionOfPackageId,
  govinfoPackageModsUrl,
  govinfoPackagePdfUrl,
  govinfoSitemapIndexUrl,
  highestLastmod,
  packageIdFromSitemapLoc,
  parseModsMetadata,
  parseOfficialPackageId,
  parseSitemapIndex,
  parseSitemapUrlSet,
  plausibleCongressesForFiscalYear,
  resolveDiscoveredCandidate,
  sitemapEntryChangedSince,
  spendRequest,
  GOVINFO_ADAPTER_COLLECTIONS,
  type GovInfoCollection,
  type RequestBudget,
} from '@capiro/defense-domain';

import type { DiscoveredCandidate } from '../lifecycle-ports.js';
import { sha256Of } from './https-publisher-http.adapter.js';
import type { PublisherHttpPort } from './publisher-http.port.js';
import type {
  NewDiscoveryCandidate,
  NewDiscoveryCrawl,
} from './discovery-audit.port.js';
import type { CrawlContext, CrawlProduct, PublisherCrawler } from './publisher-crawler.js';

/** Bill types that can carry defence authorization or appropriations. */
const RELEVANT_BILL_TYPES: readonly string[] = Object.freeze(['hr', 's', 'hjres', 'sjres']);

/** Publisher version suffixes that correspond to a chamber-action stage. */
const RELEVANT_BILL_VERSIONS: readonly string[] = Object.freeze([
  'ih',
  'is',
  'rh',
  'rs',
  'eh',
  'es',
  'eah',
  'eas',
  'enr',
]);

/** A sitemap entry narrowed to a package this collection actually owns. */
interface PlawCandidateEntry {
  readonly loc: string;
  readonly lastmod: string | null;
  readonly packageId: string;
}

@Injectable()
export class GovInfoSitemapCrawler implements PublisherCrawler {
  private readonly logger = new Logger(GovInfoSitemapCrawler.name);

  constructor(private readonly http: PublisherHttpPort) {}

  async crawl(context: CrawlContext): Promise<CrawlProduct> {
    const collections = GOVINFO_ADAPTER_COLLECTIONS[context.adapter.adapterId] ?? [];
    const candidates: DiscoveredCandidate[] = [];
    const auditCandidates: NewDiscoveryCandidate[] = [];
    const crawls: NewDiscoveryCrawl[] = [];
    let cursor = context.cursor;
    let budget = context.budget;

    for (const collection of collections) {
      const outcome = await this.crawlCollection({
        context,
        collection,
        cursor,
        budget,
      });
      candidates.push(...outcome.candidates);
      auditCandidates.push(...outcome.auditCandidates);
      crawls.push(...outcome.crawls);
      cursor = outcome.cursor;
      budget = outcome.budget;
    }

    return Object.freeze({
      candidates: Object.freeze(candidates),
      auditCandidates: Object.freeze(auditCandidates),
      crawls: Object.freeze(crawls),
      cursor,
      budget,
    });
  }

  private async crawlCollection(input: {
    context: CrawlContext;
    collection: GovInfoCollection;
    cursor: DiscoveryCursorLike;
    budget: RequestBudget;
  }): Promise<CrawlProduct> {
    const { context, collection } = input;
    const candidates: DiscoveredCandidate[] = [];
    const auditCandidates: NewDiscoveryCandidate[] = [];
    const crawls: NewDiscoveryCrawl[] = [];
    let budget = input.budget;

    const state = collectionCursor(input.cursor, collection);
    const indexUrl = govinfoSitemapIndexUrl(collection);

    const indexFetch = await this.fetch({
      context,
      url: indexUrl,
      resourceKind: 'sitemap_index',
    });
    budget = spendRequest(budget);
    crawls.push(indexFetch.crawl);

    if (!indexFetch.body) {
      // Could not read the index: nothing is knowable about this collection now.
      // No new checkpoint to report — the existing one (if any) is preserved.
      return Object.freeze({
        candidates: Object.freeze([]),
        auditCandidates: Object.freeze([]),
        crawls: Object.freeze(crawls),
        cursor: advanceCollectionCursor({
          cursor: input.cursor,
          collection,
          observedWatermark: null,
          emittedAtWatermark: [],
          exhausted: false,
          nowIso: context.nowIso,
        }),
        budget,
      });
    }

    const yearFiles = this.relevantYearSitemaps({
      xml: indexFetch.body,
      collection,
      horizonFiscalYears: context.horizonFiscalYears,
      watermark: state.watermark,
    });

    // ── Phase 1: fetch every relevant year sitemap for this pass and flatten
    // their entries into one deterministic, ordered list. This has to happen
    // before any resume decision because the persisted checkpoint could name a
    // package in ANY of these year files, not necessarily the first.
    const rawEntries: { loc: string; lastmod: string | null }[] = [];
    let observedWatermark = state.watermark;
    let yearFilesExhausted = true;

    for (const yearFile of yearFiles) {
      if (budgetExhausted(budget)) {
        yearFilesExhausted = false;
        this.logger.warn(
          `${context.adapter.adapterId}/${collection}: request budget exhausted before ` +
            `${yearFile.loc}; ${yearFiles.length} year files were in scope. Cursor left pending.`,
        );
        break;
      }

      const yearFetch = await this.fetch({
        context,
        url: yearFile.loc,
        resourceKind: 'sitemap',
      });
      budget = spendRequest(budget);
      crawls.push(yearFetch.crawl);
      if (!yearFetch.body) {
        yearFilesExhausted = false;
        continue;
      }

      const entries = parseSitemapUrlSet(yearFetch.body);
      const changed = entries.filter((entry) =>
        sitemapEntryChangedSince(entry, state.watermark),
      );
      rawEntries.push(...changed);
      observedWatermark = highestLastmod(changed, observedWatermark);
    }

    // ── Phase 2: narrow to packages this collection actually owns — the same
    // filter the pre-Phase-10 inline loop applied via its early `continue`s.
    // A malformed/off-collection entry carries no package identity, so it can
    // never anchor or receive a resume checkpoint; it is simply not a
    // candidate.
    const plawCandidates: PlawCandidateEntry[] = [];
    for (const entry of rawEntries) {
      const packageId = packageIdFromSitemapLoc(entry.loc);
      if (!packageId) continue;
      if (govinfoCollectionOfPackageId(packageId) !== collection) continue;
      plawCandidates.push({ loc: entry.loc, lastmod: entry.lastmod, packageId });
    }

    // ── Phase 3: resolve the resume position.
    //
    // No persisted checkpoint -> start at the beginning, as always.
    // A persisted checkpoint found in THIS pass's candidate list -> resume
    //   strictly after it; everything up to and including it was already fully
    //   handled and must not be re-fetched.
    // A persisted checkpoint NOT found anywhere in this pass's candidate list
    //   (the listing changed and the package is genuinely gone) -> FAIL SAFE:
    //   start from the beginning. Never derive a position by array index, never
    //   assume the item now at the old ordinal is equivalent, never jump
    //   forward on a guess. A full replay is bounded work that idempotent
    //   SHA-based persistence absorbs for free; skipping is not recoverable.
    let startIndex = 0;
    if (state.resumeAfterPackageId !== null) {
      const anchorIndex = plawCandidates.findIndex(
        (candidate) => candidate.packageId === state.resumeAfterPackageId,
      );
      if (anchorIndex === -1) {
        this.logger.warn(
          `${context.adapter.adapterId}/${collection}: persisted resume checkpoint ` +
            `${state.resumeAfterPackageId} was not found in this pass's listing; failing safe ` +
            'and replaying the collection from the beginning rather than guessing a position.',
        );
      } else {
        startIndex = anchorIndex + 1;
      }
    }

    // ── Phase 4: process candidates from the resume position, respecting the
    // remaining request budget. `lastCompletedPackageId` becomes the NEW
    // in-progress checkpoint — set only on a package whose handling (resolved,
    // unresolved-and-recorded, or prefilter-rejected) completed inside this
    // pass. The package the budget runs out on mid-handling is never recorded.
    const emittedAtWatermark: string[] = [];
    let exhausted = yearFilesExhausted;
    let lastCompletedPackageId: string | null = null;

    for (let i = startIndex; i < plawCandidates.length; i += 1) {
      const candidate = plawCandidates[i]!;
      const { lastmod, packageId } = candidate;

      if (
        alreadyEmittedAtWatermark({
          cursor: input.cursor,
          collection,
          packageId,
          entryLastmod: lastmod,
        })
      ) {
        lastCompletedPackageId = packageId;
        continue;
      }

      // Cheap id-shape prefilter: no request, no metadata, no guessing about
      // subject. This is what keeps 13,354 BILLS entries affordable, and a
      // rejection here is still a completed decision for checkpoint purposes.
      if (!this.passesIdPrefilter(packageId, context.horizonFiscalYears)) {
        lastCompletedPackageId = packageId;
        continue;
      }

      if (budgetExhausted(budget)) {
        exhausted = false;
        this.logger.warn(
          `${context.adapter.adapterId}/${collection}: request budget exhausted while ` +
            `resolving ${packageId}. Cursor left pending for the next run; the durable resume ` +
            `checkpoint stays at ${lastCompletedPackageId ?? state.resumeAfterPackageId ?? '<start>'}.`,
        );
        break;
      }

      const modsFetch = await this.fetch({
        context,
        url: govinfoPackageModsUrl(packageId),
        resourceKind: 'metadata',
      });
      budget = spendRequest(budget);
      crawls.push(modsFetch.crawl);

      if (!modsFetch.body) {
        auditCandidates.push({
          adapterId: context.adapter.adapterId,
          runKey: context.runKey,
          candidateUrl: govinfoPackagePdfUrl(packageId),
          packageId,
          title: null,
          resolution: 'unresolved_unparseable_package',
          expectedSourceDedupKey: null,
          classifiedFiscalYear: null,
          reason: modsFetch.crawl.failureReason ?? 'metadata retrieval failed',
          emitted: false,
          observedAt: context.nowIso,
        });
        lastCompletedPackageId = packageId;
        continue;
      }

      const mods = parseModsMetadata(modsFetch.body);
      const documentUrl = govinfoPackagePdfUrl(packageId);
      const resolved = resolveDiscoveredCandidate({
        adapterId: context.adapter.adapterId,
        url: documentUrl,
        packageId,
        title: mods.title,
        // The document's own alternative titles from the same MODS record. A
        // bill's popular title lives here, and without it the NDAA is
        // unclassifiable from its long title alone.
        alternativeTitles: mods.alternativeTitles,
        declaredFiscalYear: mods.declaredFiscalYears[0] ?? null,
        divisionEvidence: null,
        horizonFiscalYears: context.horizonFiscalYears,
        registeredExpectedSourceKeys: context.registeredExpectedSourceKeys,
      });

      const emitted = resolved.outcome === 'resolved';
      auditCandidates.push({
        adapterId: context.adapter.adapterId,
        runKey: context.runKey,
        candidateUrl: documentUrl,
        packageId,
        title: mods.title,
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
            url: documentUrl,
            packageId,
            title: mods.title,
            declaredFiscalYear: resolved.provisionalClassification?.fiscalYear ?? null,
            divisionEvidence: null,
            // The publisher versions bills itself; the watcher ranks the
            // suffix. Leaving this null lets the domain decide.
            versionRank: null,
          }),
        );
        if (lastmod !== null) emittedAtWatermark.push(packageId);
      }

      lastCompletedPackageId = packageId;
    }

    return Object.freeze({
      candidates: Object.freeze(candidates),
      auditCandidates: Object.freeze(auditCandidates),
      crawls: Object.freeze(crawls),
      cursor: advanceCollectionCursor({
        cursor: input.cursor,
        collection,
        observedWatermark,
        emittedAtWatermark,
        exhausted,
        // On genuine exhaustion `advanceCollectionCursor` clears this
        // unconditionally; on an unfinished pass, `null` here (no new progress)
        // preserves whatever checkpoint already existed rather than erasing it.
        resumeAfterPackageId: lastCompletedPackageId,
        nowIso: context.nowIso,
      }),
      budget,
    });
  }

  /**
   * Which year sitemaps could carry a horizon fiscal year.
   *
   * A fiscal year's documents appear in the preceding calendar year (marks and
   * reports), the year itself (enactment, supplementals) and occasionally the one
   * after (late corrections), so the window is FY-2 through FY+1 inclusive.
   */
  private relevantYearSitemaps(input: {
    xml: string;
    collection: GovInfoCollection;
    horizonFiscalYears: readonly number[];
    watermark: string | null;
  }): readonly { loc: string; lastmod: string | null }[] {
    const years = new Set<number>();
    for (const fiscalYear of input.horizonFiscalYears) {
      for (let year = fiscalYear - 2; year <= fiscalYear + 1; year += 1) years.add(year);
    }

    return parseSitemapIndex(input.xml)
      .filter((entry) => {
        const year = new RegExp(`/${input.collection}_(\\d{4})_sitemap\\.xml$`).exec(entry.loc)?.[1];
        if (!year) return false;
        if (!years.has(Number(year))) return false;
        return sitemapEntryChangedSince(entry, input.watermark);
      })
      .map((entry) => ({ loc: entry.loc, lastmod: entry.lastmod }));
  }

  /** Id-shape prefilter. Rejects only on structure, never on subject. */
  private passesIdPrefilter(packageId: string, horizonFiscalYears: readonly number[]): boolean {
    const shape = parseOfficialPackageId(packageId);
    if (shape.kind === 'unknown') return false;

    if (shape.congress !== null) {
      const plausible = new Set<number>();
      for (const fiscalYear of horizonFiscalYears) {
        for (const congress of plausibleCongressesForFiscalYear(fiscalYear)) plausible.add(congress);
      }
      if (!plausible.has(shape.congress)) return false;
    }

    if (shape.kind === 'bill') {
      const typeMatch = /^BILLS-\d{3}(hr|s|hjres|sjres|hconres|sconres)\d+[a-z]{2,4}$/i.exec(
        packageId,
      );
      const billType = typeMatch?.[1]?.toLowerCase();
      if (!billType || !RELEVANT_BILL_TYPES.includes(billType)) return false;
      if (!shape.billVersion || !RELEVANT_BILL_VERSIONS.includes(shape.billVersion)) return false;
    }

    return true;
  }

  private async fetch(input: {
    context: CrawlContext;
    url: string;
    resourceKind: NewDiscoveryCrawl['resourceKind'];
  }): Promise<{ body: string | null; crawl: NewDiscoveryCrawl }> {
    const startedAt = new Date().toISOString();
    const result = await this.http.get({
      url: input.url,
      adapterId: input.context.adapter.adapterId,
      allowedHosts: input.context.adapter.officialHosts,
      nowIso: input.context.nowIso,
    });

    const status: NewDiscoveryCrawl['status'] = result.ok
      ? 'succeeded'
      : result.statusCode === null
        ? result.failureReason?.startsWith('robots.txt disallows') === true
          ? 'blocked_by_robots'
          : 'unreachable'
        : 'blocked_by_publisher';

    return {
      body: result.body,
      crawl: Object.freeze({
        adapterId: input.context.adapter.adapterId,
        runKey: input.context.runKey,
        requestUrl: input.url,
        resourceKind: input.resourceKind,
        statusCode: result.statusCode,
        status,
        contentSha256: result.body === null ? null : sha256Of(result.body),
        byteSize: result.byteSize,
        itemsSeen: 0,
        robotsUnavailable: false,
        effectiveIntervalMs: input.context.adapter.minRequestIntervalMs,
        startedAt,
        finishedAt: new Date().toISOString(),
        failureReason: result.failureReason,
      }),
    };
  }
}

/** Structural alias so this file does not import the cursor type twice. */
type DiscoveryCursorLike = CrawlContext['cursor'];
