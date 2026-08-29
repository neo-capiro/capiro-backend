/**
 * Phase 10B-5 — catalog-backed expected-source discovery adapter.
 *
 * Implements the EXISTING `SourceDiscoveryPort` contract (same port the
 * manifest and live-crawler adapters implement), so the lifecycle watcher's
 * discover -> identify -> fingerprint -> classify -> compare -> persist ->
 * queue control loop is completely unchanged downstream of this file.
 *
 * Scope, deliberately narrow:
 *  * `request`-track (President's Budget) expected sources only. Every other
 *    authority track returns zero candidates from this adapter — committee,
 *    alternative_funding, and appropriations discovery are unaffected and
 *    keep using their existing paths (manifest / live crawler).
 *  * one candidate per expected source, resolved via the pure
 *    `resolveExpectedSourceDocument` function in @capiro/defense-domain.
 *    `no_match` / `ambiguous` / `refused_*` outcomes are NEVER turned into a
 *    candidate — they are logged and counted, never guessed into evidence.
 *  * the deterministic DW catalog is consulted for `component: 'DW'`
 *    (dod-comptroller) expected sources. Army/Navy/AF/SF component volumes
 *    fall back to `listingDocuments`, which is empty unless a caller passes
 *    real extracted links — this adapter does not itself crawl an index page.
 *
 * This keeps discovery split into the two explicit stages the phase asked
 * for: `resolveExpectedSourceDocument` (pure, read-only) here, and the
 * EXISTING lifecycle-watcher's candidate -> observation -> outbox handoff
 * downstream, unmodified.
 *
 * Phase 10B-6 — one-source-boundedness selector. `--adapter` +
 * `--catalog-fiscal-years` alone is NOT single-source bounded: the DW
 * catalog seeds 5 request-track families per fiscal year
 * (pb_overview/r1/p1/o1/milcon_c1), and `listExpectedSourcesForAdapter`
 * filters only on adapterId + fiscalYear. When `options.expectedSourceId` is
 * set, `discover()` narrows the candidate set to that single expected source
 * BEFORE resolution — this filters the SAME rows the catalog port already
 * returned; it does not add a second query path, a second persistence path,
 * or change what `listExpectedSourcesForAdapter` itself returns. Omitting
 * the selector preserves byte-identical prior behavior (all matching
 * request-track rows are still resolved).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { resolveExpectedSourceDocument } from '@capiro/defense-domain';
import type { ExpectedSourceResolution } from '@capiro/defense-domain';

import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import type { DiscoveredCandidate, SourceDiscoveryPort } from '../lifecycle-ports.js';
import {
  EXPECTED_SOURCE_CATALOG_PORT,
  type CatalogExpectedSource,
  type ExpectedSourceCatalogPort,
} from './expected-source-catalog.port.js';

export interface CatalogDiscoveryOptions {
  /** Explicit fiscal-year scope. FY24-only for this phase; never widened. */
  readonly fiscalYears: readonly number[];
  /**
   * Phase 10B-6 — optional one-source-boundedness selector. When set,
   * `discover()` narrows to the single expected source with this exact id
   * (matched against `CatalogExpectedSource.expectedSourceId`) and ignores
   * every other request-track row the catalog port returned for this
   * adapter/fiscal-year scope. `null`/undefined preserves prior behavior
   * (every matching request-track row is resolved) — this option is
   * strictly additive and narrowing, never broadening.
   */
  readonly expectedSourceId?: string | null;
}

export interface CatalogDiscoveryOutcome {
  readonly expectedSourceId: string;
  readonly dedupKey: string;
  readonly resolution: ExpectedSourceResolution;
}

@Injectable()
export class CatalogSourceDiscoveryAdapter implements SourceDiscoveryPort {
  private readonly logger = new Logger(CatalogSourceDiscoveryAdapter.name);

  /** Last run's per-expected-source resolutions, for callers (e.g. a --dry-run CLI) that need the detail `discover()`'s narrower return type omits. */
  public lastOutcomes: readonly CatalogDiscoveryOutcome[] = [];

  constructor(
    private readonly registry: SourceAdapterRegistry,
    @Inject(EXPECTED_SOURCE_CATALOG_PORT) private readonly catalog: ExpectedSourceCatalogPort,
    private readonly options: CatalogDiscoveryOptions,
  ) {}

  async discover(input: {
    adapterId: string;
    cursor: Record<string, unknown>;
    nowIso: string;
  }): Promise<{ candidates: readonly DiscoveredCandidate[]; cursor: Record<string, unknown> }> {
    const adapter = this.registry.get(input.adapterId);

    const expectedSources = await this.catalog.listExpectedSourcesForAdapter({
      adapterId: input.adapterId,
      fiscalYears: this.options.fiscalYears,
    });

    let requestTrack = expectedSources.filter((row) => row.authorityTrack === 'request');

    // Phase 10B-6: narrow to exactly one expected source when the caller
    // supplied a selector. This filters the rows already returned by the
    // catalog port above; it never changes the port's own query. A selector
    // that matches nothing is NOT silently ignored -- it must yield zero
    // candidates, never fall back to "all rows", so a typo'd id fails
    // closed instead of accidentally widening back to every family.
    if (this.options.expectedSourceId) {
      requestTrack = requestTrack.filter(
        (row) => row.expectedSourceId === this.options.expectedSourceId,
      );
    }

    if (requestTrack.length === 0) {
      this.lastOutcomes = [];
      return {
        candidates: Object.freeze([]),
        cursor: { ...input.cursor, lastDiscoveryAt: input.nowIso, seen: 0 },
      };
    }

    const outcomes: CatalogDiscoveryOutcome[] = [];
    const candidates: DiscoveredCandidate[] = [];

    for (const expected of requestTrack) {
      const resolution = resolveExpectedSourceDocument({
        expectedSource: toResolutionTarget(expected),
        officialHosts: adapter.officialHosts,
        preferredCatalogHost: adapter.preferredRetrievalHost,
      });
      outcomes.push({
        expectedSourceId: expected.expectedSourceId,
        dedupKey: expected.dedupKey,
        resolution,
      });

      if (resolution.outcome !== 'resolved' || !resolution.candidate) {
        this.logger.warn(
          `${input.adapterId}: ${expected.dedupKey.slice(0, 12)} (${expected.sourceFamily}) -> ` +
            `${resolution.outcome}: ${resolution.reasons.join('; ')}`,
        );
        continue;
      }

      candidates.push(
        Object.freeze({
          adapterId: input.adapterId,
          expectedSourceDedupKey: resolution.expectedSourceDedupKey,
          url: resolution.candidate.url,
          packageId: null,
          title: resolution.candidate.title,
          declaredFiscalYear: resolution.candidate.detectedFiscalYear,
          divisionEvidence: null,
          versionRank: null,
        }),
      );
    }

    this.lastOutcomes = Object.freeze(outcomes);

    return {
      candidates: Object.freeze(candidates),
      cursor: { ...input.cursor, lastDiscoveryAt: input.nowIso, seen: candidates.length },
    };
  }
}

function toResolutionTarget(expected: CatalogExpectedSource) {
  return {
    fiscalYear: expected.fiscalYear,
    authorityTrack: expected.authorityTrack,
    sourceFamily: expected.sourceFamily,
    stage: expected.stage,
    chamber: expected.chamber,
    committee: expected.committee,
    component: expected.component,
    adapterId: expected.adapterId,
    dedupKey: expected.dedupKey,
  };
}
