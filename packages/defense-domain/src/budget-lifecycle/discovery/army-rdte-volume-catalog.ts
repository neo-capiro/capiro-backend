/**
 * Phase 10B-18 Part C/E — Army FY24 R-2 exhibit member catalog.
 *
 * Supersedes the single-entry `ARMY_RDTE_CATALOG` proposed (unmerged) in
 * PR #1369. That entry's own doc comment already disclosed the exact defect
 * Phase 10B-18 Part B traced end to end: matching by `(sourceFamily,
 * component)` alone cannot distinguish more than one Army R-2 volume, so a
 * second real volume would silently resolve to the first volume's URL. This
 * catalog adds the missing discriminator (volume + budget activity) instead
 * of extending the collision.
 *
 * Source: Phase 10B-18 Part E read-only research against asafm.army.mil
 * (first-party only). Member 1 (Volume 1 / Budget Activity 1) is verified —
 * its bytes were fetched and SHA256'd in Phase 10B-17
 * (`1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6`).
 * Every other member's URL is confirmed only by convergent search-engine
 * indexing of the live asafm.army.mil path — the top-level Budget-Materials
 * index page 403'd on direct fetch (same Akamai block affecting production),
 * so no first-party table of contents could be walked directly. Do not
 * upgrade `urlConfidence` to `'byte_verified'` for a member until its bytes
 * have actually been fetched (governed import or a future working live
 * fetch) and SHA256'd.
 *
 * Known, disclosed gaps (Part E) — do NOT treat these as ruled out or as
 * present:
 *   - Whether BA5 splits further (5C/5D) for FY24 the way later fiscal years
 *     do: not found for FY24, working conclusion is "not present," not
 *     independently proven absent.
 *   - Whether a classified/exception annex volume exists: no evidence either
 *     way.
 *   - Per-PE coverage per volume: not obtainable without a reachable index
 *     page.
 */
import type { BudgetComponent, SourceFamily } from '../types.js';
import { armyRdteMemberKey } from '../bundle/bundle-completeness.js';

/**
 * Deliberately NOT a copy of `apps/defense-api`'s `SourceAdapterRegistry`
 * entry for `army-budget` as it stands on `main` today
 * (`officialHosts: ['asafm.army.mil']`, no `www.` variant) — that list is
 * stale for the real, byte-verified official URL every entry in this catalog
 * actually resolves to (`https://www.asafm.army.mil/...`, confirmed in Phase
 * 10B-17). PR #1369 (superseded, not merged — see Phase 10B-18 Part L)
 * separately proposed fixing that same registry to add the `www.` host; this
 * constant carries the equivalent fix for this governed-import feature
 * without depending on that PR or reaching into a different app's
 * compilation unit.
 */
export const ARMY_BUDGET_OFFICIAL_HOSTS: readonly string[] = Object.freeze([
  'asafm.army.mil',
  'www.asafm.army.mil',
]);

export type ArmyRdteMemberUrlConfidence = 'byte_verified' | 'search_index_confirmed';

export interface ArmyRdteVolumeCatalogEntry {
  readonly sourceFamily: SourceFamily;
  readonly component: BudgetComponent;
  readonly memberKey: string;
  readonly volume: string;
  readonly budgetActivity: string;
  readonly required: boolean;
  /** Path template under the official host; `{FY}` substituted. */
  readonly pathTemplate: string;
  readonly titleTemplate: string;
  readonly urlConfidence: ArmyRdteMemberUrlConfidence;
}

function entry(input: {
  volume: string;
  budgetActivity: string;
  pathSuffix: string;
  titleBudgetActivityLabel: string;
  urlConfidence: ArmyRdteMemberUrlConfidence;
}): ArmyRdteVolumeCatalogEntry {
  return Object.freeze({
    sourceFamily: 'pb_r2',
    component: 'ARMY',
    memberKey: armyRdteMemberKey({ volume: input.volume, budgetActivity: input.budgetActivity }),
    volume: input.volume,
    budgetActivity: input.budgetActivity,
    required: true,
    pathTemplate: `/Portals/72/Documents/BudgetMaterial/{FY}/Base%20Budget/rdte/${input.pathSuffix}`,
    titleTemplate:
      `Department of the Army Fiscal Year {FY} Budget Estimates: RDT&E Budget Item ` +
      `Justification (R-2), ${input.titleBudgetActivityLabel}`,
    urlConfidence: input.urlConfidence,
  });
}

/**
 * The complete required-member manifest proposal for FY2024 Army pb_r2, per
 * Phase 10B-18 Part E. 10 members across 3 volumes (BA groupings match the
 * FY21/FY23 precedent the research found, and FY24 does not yet show the
 * BA5C/5D split later fiscal years introduce).
 */
export const ARMY_RDTE_VOLUME_CATALOG: readonly ArmyRdteVolumeCatalogEntry[] = Object.freeze([
  entry({
    volume: '1',
    budgetActivity: '1',
    pathSuffix: 'RDTE-Vol%201-Budget%20Activity%201.pdf',
    titleBudgetActivityLabel: 'Budget Activity 1',
    urlConfidence: 'byte_verified',
  }),
  entry({
    volume: '1',
    budgetActivity: '2',
    pathSuffix: 'RDTE-Vol%201-Budget%20Activity%202.pdf',
    titleBudgetActivityLabel: 'Budget Activity 2',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '1',
    budgetActivity: '3',
    pathSuffix: 'RDTE-Vol%201-Budget%20Activity%203.pdf',
    titleBudgetActivityLabel: 'Budget Activity 3',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '2',
    budgetActivity: '4A',
    pathSuffix: 'RDTE-Vol%202-Budget%20Activity%204A.pdf',
    titleBudgetActivityLabel: 'Budget Activity 4A',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '2',
    budgetActivity: '4B',
    pathSuffix: 'RDTE-Vol%202-Budget%20Activity%204B.pdf',
    titleBudgetActivityLabel: 'Budget Activity 4B',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '2',
    budgetActivity: '5A',
    pathSuffix: 'RDTE-Vol%202-Budget%20Activity%205A.pdf',
    titleBudgetActivityLabel: 'Budget Activity 5A',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '2',
    budgetActivity: '5B',
    pathSuffix: 'RDTE-Vol%202-Budget%20Activity%205B.pdf',
    titleBudgetActivityLabel: 'Budget Activity 5B',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '3',
    budgetActivity: '6',
    pathSuffix: 'RDTE-Vol%203-Budget%20Activity%206.pdf',
    titleBudgetActivityLabel: 'Budget Activity 6',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '3',
    budgetActivity: '7',
    pathSuffix: 'RDTE-Vol%203-Budget%20Activity%207.pdf',
    titleBudgetActivityLabel: 'Budget Activity 7',
    urlConfidence: 'search_index_confirmed',
  }),
  entry({
    volume: '3',
    budgetActivity: '8',
    pathSuffix: 'RDTE-Vol%203-Budget%20Activity%208.pdf',
    titleBudgetActivityLabel: 'Budget Activity 8',
    urlConfidence: 'search_index_confirmed',
  }),
]);

export function armyRdteOfficialUrl(entryRow: ArmyRdteVolumeCatalogEntry, fiscalYear: number): string {
  return `https://www.asafm.army.mil${entryRow.pathTemplate.replace(/\{FY\}/g, String(fiscalYear))}`;
}

export function armyRdteTitle(entryRow: ArmyRdteVolumeCatalogEntry, fiscalYear: number): string {
  return entryRow.titleTemplate.replace(/\{FY\}/g, String(fiscalYear));
}

/** Find the catalog member whose deterministic official URL exactly matches `url` for `fiscalYear`. */
export function findArmyRdteMemberByUrl(
  url: string,
  fiscalYear: number,
): ArmyRdteVolumeCatalogEntry | null {
  return ARMY_RDTE_VOLUME_CATALOG.find((e) => armyRdteOfficialUrl(e, fiscalYear) === url) ?? null;
}

export function findArmyRdteMemberByKey(memberKey: string): ArmyRdteVolumeCatalogEntry | null {
  return ARMY_RDTE_VOLUME_CATALOG.find((e) => e.memberKey === memberKey) ?? null;
}
