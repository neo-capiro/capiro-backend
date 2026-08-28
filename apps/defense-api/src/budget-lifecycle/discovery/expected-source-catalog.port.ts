/**
 * Phase 10B-5 — expected-source catalog port.
 *
 * Read-only: "which FY24 request-track expected sources does this adapter
 * own?" The catalog is the 56-row inventory already bootstrapped by the
 * cycle-template machinery. Nothing here creates, mutates, or supersedes an
 * expected source; it only lists what already exists so discovery can be
 * scoped to the known inventory instead of a broad crawl.
 */

import type { AuthorityTrack, BudgetComponent, Chamber, LifecycleStage, SourceFamily } from '@capiro/defense-domain';

export interface CatalogExpectedSource {
  readonly expectedSourceId: string;
  readonly dedupKey: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly sourceFamily: SourceFamily;
  readonly stage: LifecycleStage;
  readonly chamber: Chamber;
  readonly committee: string | null;
  readonly component: BudgetComponent;
  readonly adapterId: string;
}

export interface ExpectedSourceCatalogPort {
  /**
   * List expected sources bound to one adapter across the given fiscal years.
   * Read-only. Must never create a row — a caller that finds nothing here
   * concludes "not yet bootstrapped", not "create one".
   */
  listExpectedSourcesForAdapter(input: {
    adapterId: string;
    fiscalYears: readonly number[];
  }): Promise<readonly CatalogExpectedSource[]>;
}

export const EXPECTED_SOURCE_CATALOG_PORT = Symbol('EXPECTED_SOURCE_CATALOG_PORT');
