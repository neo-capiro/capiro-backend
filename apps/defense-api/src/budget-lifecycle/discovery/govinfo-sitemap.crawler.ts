/**
 * Phase 8 Session 8 — GovInfo sitemap crawler.
 * Phase 10 — fine-grained resumability inside an active collection, hardened
 * against a no-skip correctness hole found in PR #1236 review.
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
 *  * **A package id alone is NOT a safe resume anchor.** A fiscal year's window
 *    spans several year sitemaps at once (FY-2 through FY+1), any one of which
 *    can fail to fetch on a given pass while others succeed, and GovInfo's
 *    listing itself can change (insertion, removal, a `lastmod` edit) before an
 *    otherwise still-present checkpoint package. "the checkpoint package id
 *    still exists" does not prove nothing before it was missed. This is closed
 *    with `resumeListingFingerprint` (see `crawl-cursor.ts`): a checkpoint is
 *    only ever trusted to resume strictly-after when THIS pass saw a COMPLETE
 *    relevant listing (every relevant year sitemap fetched successfully) AND a
 *    fresh fingerprint over that complete listing matches the persisted one
 *    exactly. Any mismatch, or any partial listing, means fail-safe: replay the
 *    collection from the beginning. A partial listing also never mints a NEW
 *    checkpoint/fingerprint pair — the prior pair (if any) is preserved
 *    untouched, exactly like a pass that made no further progress, because
 *    establishing a new position against an incomplete universe is exactly how
 *    a package that lives only in a currently-failing sitemap would end up
 *    permanently stranded before the checkpoint once that sitemap recovers.
 *
 *    The crawl is restructured into phases to make this safe:
 *
 *    1. fetch every relevant year sitemap for this pass and flatten their
 *       entries into one deterministic, ordered candidate list (package id +
 *       right collection only — the same filter the old inline loop applied),
 *       tracking which year sitemap each entry came from and whether every
 *       relevant year sitemap was fetched successfully this pass;
 *    2. compute this pass's listing fingerprint over that candidate list;
 *    3. resolve the resume position: trust the persisted anchor and resume
 *       strictly after it ONLY when the listing was complete this pass AND the
 *       fingerprint matches AND the anchor is found in the list. Otherwise,
 *       start from the very beginning of the candidate list — never derive a
 *       position by array index, never assume the item now at the old ordinal
 *       is equivalent, never jump forward on a guess. A little replay is
 *       acceptable because persistence is SHA-based and idempotent; silently
 *       skipping is not;
 *    4. process from the resume position under the remaining budget, and only
 *       report a NEW checkpoint + fingerprint pair to the cursor when this
 *       pass's listing was complete — a partial-listing pass preserves the
 *       prior pair untouched no matter how much processing it got through.
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
  computeListingFingerprint,
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

/**
 * A sitemap entry narrowed to a package this collection actually owns.
 *
 * `sitemap` is the year-sitemap URL the entry came from — required as part of
 * the fingerprinted identity, not merely provenance, because the same
 * `(loc, lastmod)` pair arriving from a different year file is not the same
 * fact.
 */
interface PlawCandidateEntry {
  readonly sitemap: string;
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
      // Could not read the index: nothing is knowable about this collection
      // now. This is a partial (in fact empty) listing — no new checkpoint or
      // fingerprint to report. The existing pair (if any) is preserved.
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
    // their entries into one deterministic, ordered list, tracking which year
    // sitemap each entry came from and whether EVERY relevant year sitemap was
    // fetched successfully this pass (`yearFilesComplete`). This has to happen
    // before any resume decision because the persisted checkpoint could name a
    // package in ANY of these year files, not necessarily the first — and
    // whether the listing is complete governs both whether the anchor can be
    // trusted and whether a new checkpoint may be minted at all.
    const rawEntries: { sitemap: string; loc: string; lastmod: string | null }[] = [];
    let observedWatermark = state.watermark;
    let yearFilesComplete = true;

    for (const yearFile of yearFiles) {
      if (budgetExhausted(budget)) {
        yearFilesComplete = false;
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
        yearFilesComplete = false;
        this.logger.warn(
          `${context.adapter.adapterId}/${collection}: ${yearFile.loc} could not be fetched this ` +
            'pass; the relevant listing is incomplete, so no new resume checkpoint will be minted.',
        );
        continue;
      }

      const entries = parseSitemapUrlSet(yearFetch.body);
      const changed = entries.filter((entry) =>
        sitemapEntryChangedSince(entry, state.watermark),
      );
      for (const entry of changed) {
        rawEntries.push({ sitemap: yearFile.loc, loc: entry.loc, lastmod: entry.lastmod });
      }
      observedWatermark = highestLastmod(changed, observedWatermark);
    }

    // ── Phase 2: narrow to packages this collection actually owns — the same
    // filter the pre-Phase-10 inline loop applied via its early `continue`s.
    // A malformed/off-collection entry carries no package identity, so it can
    // never anchor or receive a resume checkpoint; it is simply not a
    // candidate, and it does not contribute to the listing fingerprint either.
    const plawCandidates: PlawCandidateEntry[] = [];
    for (const entry of rawEntries) {
      const packageId = packageIdFromSitemapLoc(entry.loc);
      if (!packageId) continue;
      if (govinfoCollectionOfPackageId(packageId) !== collection) continue;
      plawCandidates.push({ sitemap: entry.sitemap, loc: entry.loc, lastmod: entry.lastmod, packageId });
    }

    // ── Phase 3: this pass's listing fingerprint, over exactly the candidate
    // list Phase 4 will walk, in the exact order it will walk it. Computed
    // unconditionally — it is only ever TRUSTED (compared against, or minted
    // as new) when `yearFilesComplete` is true; see Phase 3b and Phase 5.
    const currentListingFingerprint = computeListingFingerprint(
      plawCandidates.map((candidate) => ({
        sitemap: candidate.sitemap,
        loc: candidate.loc,
        lastmod: candidate.lastmod,
      })),
    );

    // ── Phase 3b: resolve the resume position.
    //
    // No persisted checkpoint -> start at the beginning, as always.
    //
    // A persisted checkpoint is trusted to skip past — resume strictly after
    // it — ONLY when ALL of the following hold:
    //   1. this pass's relevant listing is COMPLETE (`yearFilesComplete`): a
    //      partial listing (any relevant year sitemap failed to fetch) cannot
    //      prove nothing changed in the part it never saw, so the anchor is
    //      never trusted against it — not even the OLD checkpoint from a prior
    //      complete pass;
    //   2. the fingerprint of this pass's complete listing matches the
    //      fingerprint recorded alongside the checkpoint: any insertion,
    //      removal, reorder, or `lastmod` change anywhere in the listing —
    //      including strictly BEFORE the checkpoint package — changes the
    //      digest and is caught here, closing the hole where "the checkpoint
    //      package id still exists" was treated as sufficient;
    //   3. the checkpoint package is actually found in this pass's candidate
    //      list (should be automatic once 1 and 2 hold, but checked
    //      defensively rather than assumed).
    //
    // Any failure of 1–3 is FAIL SAFE: start from the beginning of the
    // candidate list. Never derive a position by array index, never assume the
    // item now at the old ordinal is equivalent, never jump forward on a
    // guess. A full replay is bounded work that idempotent SHA-based
    // persistence absorbs for free; skipping is not recoverable.
    let startIndex = 0;
    if (state.resumeAfterPackageId !== null) {
      if (!yearFilesComplete) {
        this.logger.warn(
          `${context.adapter.adapterId}/${collection}: this pass's relevant listing is incomplete ` +
            `(a year sitemap failed to fetch); the persisted resume checkpoint ` +
            `${state.resumeAfterPackageId} cannot be trusted against a partial universe. Failing ` +
            'safe and replaying the collection from the beginning.',
        );
      } else if (currentListingFingerprint !== state.resumeListingFingerprint) {
        this.logger.warn(
          `${context.adapter.adapterId}/${collection}: the relevant listing changed since the ` +
            `persisted resume checkpoint ${state.resumeAfterPackageId} was set (fingerprint ` +
            'mismatch). Failing safe and replaying the collection from the beginning rather than ' +
            'trusting a checkpoint whose universe no longer matches.',
        );
      } else {
        const anchorIndex = plawCandidates.findIndex(
          (candidate) => candidate.packageId === state.resumeAfterPackageId,
        );
        if (anchorIndex === -1) {
          // Should not happen once the fingerprint matches exactly, but never
          // trust a guessed position — fail safe regardless.
          this.logger.warn(
            `${context.adapter.adapterId}/${collection}: persisted resume checkpoint ` +
              `${state.resumeAfterPackageId} was not found in this pass's listing despite a ` +
              'matching fingerprint; failing safe and replaying the collection from the beginning.',
          );
        } else {
          startIndex = anchorIndex + 1;
        }
      }
    }

    // ── Phase 4: process candidates from the resume position, respecting the
    // remaining request budget. `lastCompletedPackageId` tracks the last
    // package boundary whose handling (resolved, unresolved-and-recorded, or
    // prefilter-rejected) completed inside this pass — but per Phase 5, it is
    // only ever REPORTED as a new checkpoint when this pass's listing was
    // complete. The package the budget runs out on mid-handling is never
    // recorded even then.
    const emittedAtWatermark: string[] = [];
    let exhausted = yearFilesComplete;
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

    // ── Phase 5: report the new checkpoint pair — but ONLY when this pass's
    // listing was complete. A partial-listing pass must never mint a new
    // global position, no matter how much processing it got through this
    // pass; `advanceCollectionCursor` preserves the prior pair untouched when
    // both fields are omitted/null on an unexhausted run.
    const reportedResumeAfterPackageId = yearFilesComplete ? lastCompletedPackageId : null;
    const reportedResumeListingFingerprint =
      yearFilesComplete && reportedResumeAfterPackageId !== null ? currentListingFingerprint : null;

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
        // On genuine exhaustion `advanceCollectionCursor` clears both fields
        // unconditionally; on an unfinished pass, `null` here (no new
        // progress, or a partial listing) preserves whatever pair already
        // existed rather than erasing it.
        resumeAfterPackageId: reportedResumeAfterPackageId,
        resumeListingFingerprint: reportedResumeListingFingerprint,
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
