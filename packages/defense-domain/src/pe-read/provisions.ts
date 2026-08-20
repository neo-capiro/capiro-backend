/**
 * Committee-report provision merge/rank for a PE profile — pure.
 *
 * Hoisted from `ProgramElementReadService.getProvisionsForPe` in
 * `apps/api/src/program-element/program-element-read.service.ts`. Only the two
 * link queries stay in the service; every merge, scope, caveat and ordering
 * decision lives here so defense-api and the parity suite share one
 * implementation.
 *
 * RC7 semantics preserved EXACTLY, including the attribution caveat's wording:
 * `pe_code` / `project_title` bases cite THIS PE (or a project of it) and are
 * `pe_specific`; anything else (a `program_alias` basis) is a PROGRAM-level
 * candidate that may apply to sibling PEs in the same program, so it carries a
 * caveat and is ranked below its PE-direct peers. FY committee reports name
 * PROGRAMS, not PE codes, so the program path is where nearly every real link
 * comes from — dropping it (the original bug) surfaced none at all.
 */

export interface ProvisionItem {
  id: string;
  committee: string;
  fy: number;
  heading: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  actionType: string | null;
  /** From the provision's SourceDocument when present (deep-link to the report); else null. */
  sourceUrl: string | null;
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
  matchScope: 'pe_specific' | 'program_level';
  attributionCaveat: string | null;
}

/** The joined link row shape both link queries select. */
export interface ProvisionLinkRow {
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
  provision: {
    id: string;
    committee: string;
    fy: number;
    heading: string;
    text: string;
    pageStart: number | null;
    pageEnd: number | null;
    actionType: string | null;
    sourceDocument: { sourceUrl: string } | null;
  };
}

/**
 * The exact caveat string apps/api emits. Kept as an exported constant so the
 * parity suite can assert byte equality rather than "looks similar" — the prior
 * defense-api implementation shipped a reworded variant.
 */
export const PROGRAM_LEVEL_ATTRIBUTION_CAVEAT =
  'Program-level match: this provision names a program that maps to this PE, not this PE code directly. It may apply to sibling PEs in the same program — attribute it at the program level, not exclusively to this PE.';

/** Cap so a heavily-referenced program cannot flood a single PE profile. */
export const PROVISION_LIMIT = 50;

/** matchBasis rank: PE-direct bases outrank program-level ones. */
export function provisionBasisRank(matchBasis: string): number {
  return matchBasis === 'pe_code' ? 0 : matchBasis === 'project_title' ? 1 : 2;
}

export function provisionMatchScope(matchBasis: string): 'pe_specific' | 'program_level' {
  return matchBasis === 'pe_code' || matchBasis === 'project_title'
    ? 'pe_specific'
    : 'program_level';
}

/**
 * Merge direct + program-path links, keeping the STRONGEST link per provision (a
 * provision reachable both directly and via program keeps its direct, higher-status
 * row), then order accepted -> pe-direct candidate -> program-level candidate,
 * newest FY first, highest confidence first, and cap at PROVISION_LIMIT.
 */
export function mergeProvisionLinks(
  directLinks: readonly ProvisionLinkRow[],
  programLinks: readonly ProvisionLinkRow[],
): ProvisionItem[] {
  const byProvision = new Map<string, ProvisionItem>();
  for (const l of [...directLinks, ...programLinks]) {
    const existing = byProvision.get(l.provision.id);
    if (existing && provisionBasisRank(existing.matchBasis) <= provisionBasisRank(l.matchBasis)) {
      continue;
    }
    const matchScope = provisionMatchScope(l.matchBasis);
    byProvision.set(l.provision.id, {
      id: l.provision.id,
      committee: l.provision.committee,
      fy: l.provision.fy,
      heading: l.provision.heading,
      text: l.provision.text,
      pageStart: l.provision.pageStart,
      pageEnd: l.provision.pageEnd,
      actionType: l.provision.actionType,
      sourceUrl: l.provision.sourceDocument?.sourceUrl ?? null,
      matchBasis: l.matchBasis,
      reviewStatus: l.reviewStatus,
      confidence: l.confidence,
      matchScope,
      attributionCaveat:
        matchScope === 'program_level' ? PROGRAM_LEVEL_ATTRIBUTION_CAVEAT : null,
    });
  }

  const items = [...byProvision.values()];
  const statusRank = (s: string) => (s === 'accepted' ? 0 : 1);
  items.sort(
    (a, b) =>
      statusRank(a.reviewStatus) - statusRank(b.reviewStatus) ||
      provisionBasisRank(a.matchBasis) - provisionBasisRank(b.matchBasis) ||
      b.fy - a.fy ||
      b.confidence - a.confidence,
  );
  return items.slice(0, PROVISION_LIMIT);
}
