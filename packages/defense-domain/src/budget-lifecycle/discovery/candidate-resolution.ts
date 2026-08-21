/**
 * Phase 8 Session 8 — candidate resolution.
 *
 * This is the one thing the manifest adapter got for free and a live crawler has
 * to earn. Session 7's manifest carried `expectedSourceDedupKey` per entry,
 * written by hand. A crawler sees a package id and a title and must decide, on
 * its own, which expected source — if any — the document could satisfy.
 *
 * Three rules make that safe:
 *
 *  1. **Resolution is not classification.** The dedup key chosen here only
 *     decides *which expected source a candidate is compared against*. The
 *     authoritative classification still happens in the watcher, after the bytes
 *     are downloaded, with content corroboration. Nothing here advances a stage,
 *     and a resolved candidate is not an accepted one.
 *
 *  2. **Fail closed, and stay visible.** A candidate that cannot be resolved to a
 *     *registered* expected source is never given an invented key. It is returned
 *     as an explicit unresolved outcome with a reason, so it lands in the audit
 *     trail instead of being silently dropped. The watcher already refuses a key
 *     with no expected source behind it; this keeps that path from being reached
 *     by guesswork.
 *
 *  3. **Resolution is also the filter.** The real `BILLS_2023` sitemap carries
 *     13,354 packages. Emitting all of them would mean 13,354 downloads for the
 *     handful that matter. Requiring a candidate to resolve to an expected source
 *     that a bootstrapped cycle actually registered is what makes a live crawl
 *     affordable — and it is a correctness rule, not an optimisation, because an
 *     expected source is the only thing an observation may attach to.
 */

import { classifyLifecycleSource, parseOfficialPackageId } from '../classifier.js';
import { expectedSourceDedupKey } from '../cycle.js';
import { STAGE_TRACK } from '../types.js';
import type { LifecycleClassification } from '../classifier.js';

export type CandidateResolutionOutcome =
  | 'resolved'
  | 'unresolved_unparseable_package'
  | 'unresolved_not_defense_subject'
  | 'unresolved_fiscal_year_unknown'
  | 'unresolved_fiscal_year_out_of_horizon'
  | 'unresolved_stage_not_expected'
  | 'unresolved_no_registered_expected_source';

export interface ResolutionInput {
  readonly adapterId: string;
  /** Document URL the watcher would fetch. */
  readonly url: string;
  readonly packageId: string | null;
  /** Authoritative title, for GovInfo the primary MODS title. */
  readonly title: string | null;
  /**
   * The document's OWN alternative titles from the same authoritative record.
   *
   * Reading these is reading one record more completely, not guessing. A real
   * bill's primary title is "To authorize appropriations for fiscal year 2024 for
   * military activities of the Department of Defense..." — which names both
   * tracks in one breath and is correctly ambiguous — while the popular title
   * "National Defense Authorization Act for Fiscal Year 2024" is unambiguous and
   * sits in the same MODS record as an alternative.
   */
  readonly alternativeTitles?: readonly string[];
  readonly declaredFiscalYear: number | null;
  readonly divisionEvidence: string | null;
  /** Fiscal years whose cycles are bootstrapped and therefore crawlable. */
  readonly horizonFiscalYears: readonly number[];
  /**
   * Dedup keys of expected sources that actually exist. Membership — not
   * plausibility — is what makes a candidate resolvable.
   */
  readonly registeredExpectedSourceKeys: ReadonlySet<string>;
}

export interface ResolvedCandidate {
  readonly outcome: CandidateResolutionOutcome;
  /** Set only when `outcome === 'resolved'`. Never fabricated. */
  readonly expectedSourceDedupKey: string | null;
  /**
   * The provisional, metadata-only classification used to pick the expected
   * source. The watcher re-classifies against real bytes; this is not evidence.
   */
  readonly provisionalClassification: LifecycleClassification | null;
  readonly reasons: readonly string[];
  /** Publisher version rank, when the publisher versions the document itself. */
  readonly versionRank: number | null;
}

function unresolved(
  outcome: CandidateResolutionOutcome,
  reasons: readonly string[],
  provisionalClassification: LifecycleClassification | null = null,
): ResolvedCandidate {
  return Object.freeze({
    outcome,
    expectedSourceDedupKey: null,
    provisionalClassification,
    reasons: Object.freeze([...reasons]),
    versionRank: null,
  });
}

/**
 * Resolve one crawled candidate to a registered expected source.
 *
 * The metadata-only classification deliberately passes
 * `contentExcerptAvailable: false`, which is the same "corroboration deferred"
 * path Session 7 defined for PDF-only publishers. Discovery has no document text
 * and must not pretend otherwise: omitting the excerpt is not the same as
 * declaring it unavailable, and the lenient content-check path is never entered
 * from here.
 */
export function resolveDiscoveredCandidate(input: ResolutionInput): ResolvedCandidate {
  const shape = parseOfficialPackageId(input.packageId);

  // A GovInfo-style adapter that produced no recognisable package id has nothing
  // to resolve against. Non-GovInfo adapters legitimately have no package id and
  // rely on the title alone, so this only rejects an id we failed to understand.
  if (input.packageId !== null && shape.kind === 'unknown') {
    return unresolved('unresolved_unparseable_package', [
      `package id ${input.packageId} is not a recognised official package shape`,
    ]);
  }

  // Try the document's own titles in order: primary first, then its alternatives.
  // The FIRST title that yields a classification wins; if none do, the candidate
  // is unresolved. This never combines evidence across titles and never falls
  // back to a title belonging to a different document.
  let classified = classifyLifecycleSource({
    url: input.url,
    packageId: input.packageId,
    title: input.title,
    declaredFiscalYear: input.declaredFiscalYear,
    contentExcerpt: null,
    contentExcerptAvailable: false,
    divisionEvidence: input.divisionEvidence,
    adapterId: input.adapterId,
  });

  if (!classified.classification) {
    for (const alternative of input.alternativeTitles ?? []) {
      const retried = classifyLifecycleSource({
        url: input.url,
        packageId: input.packageId,
        title: alternative,
        declaredFiscalYear: input.declaredFiscalYear,
        contentExcerpt: null,
        contentExcerptAvailable: false,
        divisionEvidence: input.divisionEvidence,
        adapterId: input.adapterId,
      });
      if (retried.classification) {
        classified = retried;
        break;
      }
    }
  }

  const classification = classified.classification;
  if (!classification) {
    // Metadata alone did not identify a defence budget document. That is the
    // overwhelmingly common case on a general-purpose collection sitemap.
    return unresolved(
      'unresolved_not_defense_subject',
      classified.reasons.length > 0
        ? classified.reasons
        : ['metadata does not identify a defense budget document'],
    );
  }

  if (!Number.isInteger(classification.fiscalYear)) {
    return unresolved(
      'unresolved_fiscal_year_unknown',
      ['no fiscal year could be established from metadata'],
      classification,
    );
  }

  if (!input.horizonFiscalYears.includes(classification.fiscalYear)) {
    return unresolved(
      'unresolved_fiscal_year_out_of_horizon',
      [
        `FY${classification.fiscalYear} is outside the bootstrapped horizon ` +
          `[${input.horizonFiscalYears.join(', ')}]`,
      ],
      classification,
    );
  }

  // A stage must belong to the track it was classified onto. This mirrors the
  // domain's own cross-track guard; a mismatch here means the classifier and the
  // track map disagree, which must never silently produce a key.
  if (STAGE_TRACK[classification.stage] !== classification.authorityTrack) {
    return unresolved(
      'unresolved_stage_not_expected',
      [
        `stage ${classification.stage} belongs to the ` +
          `${STAGE_TRACK[classification.stage]} track, not ${classification.authorityTrack}`,
      ],
      classification,
    );
  }

  const dedupKey = expectedSourceDedupKey({
    fiscalYear: classification.fiscalYear,
    authorityTrack: classification.authorityTrack,
    sourceFamily: classification.sourceFamily,
    stage: classification.stage,
    chamber: classification.chamber,
    committee: classification.committee,
    component: classification.component,
  });

  if (!input.registeredExpectedSourceKeys.has(dedupKey)) {
    // The document is plausibly a defence budget source, but no bootstrapped
    // cycle expects anything of this shape. Recorded, never invented.
    return unresolved(
      'unresolved_no_registered_expected_source',
      [
        `no registered expected source for FY${classification.fiscalYear} ` +
          `${classification.authorityTrack}/${classification.stage}/` +
          `${classification.sourceFamily}/${classification.component ?? 'all'}`,
      ],
      classification,
    );
  }

  return Object.freeze({
    outcome: 'resolved' as const,
    expectedSourceDedupKey: dedupKey,
    provisionalClassification: classification,
    reasons: Object.freeze([
      `resolved to FY${classification.fiscalYear} ${classification.authorityTrack}/` +
        `${classification.stage} from publisher metadata; ` +
        'authoritative classification is deferred to the post-download pass',
    ]),
    versionRank: null,
  });
}

/**
 * `true` when a resolution outcome means "we understood this and it is ours".
 * Everything else is auditable non-work, not an error.
 */
export function isResolvedOutcome(outcome: CandidateResolutionOutcome): boolean {
  return outcome === 'resolved';
}

export const CANDIDATE_RESOLUTION_OUTCOMES: readonly CandidateResolutionOutcome[] = Object.freeze([
  'resolved',
  'unresolved_unparseable_package',
  'unresolved_not_defense_subject',
  'unresolved_fiscal_year_unknown',
  'unresolved_fiscal_year_out_of_horizon',
  'unresolved_stage_not_expected',
  'unresolved_no_registered_expected_source',
]);
