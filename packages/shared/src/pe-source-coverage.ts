/**
 * Program Elements Phase L — honest source-family coverage matrix (Phase 7).
 *
 * Status values:
 * - loaded: product path + fixtures exist and may write owned canonical fields
 * - partial: some exhibits/FYs loaded; uncovered slices must stay non-canonical
 * - unsupported: no approved parser in this release; MUST NOT write canonical
 * - blocked: waiting on official fixture/authorization before implementation
 *
 * Unsupported/blocked families always fail closed for canonical writes.
 * Future work is one source family per PR (documented in futurePrHint).
 */

export type PeSourceFamilyStatus = 'loaded' | 'partial' | 'unsupported' | 'blocked';

export interface PeSourceFamilyCoverage {
  /** Stable id used in gates and docs. */
  id: string;
  /** Human label for model + operator surfaces. */
  label: string;
  status: PeSourceFamilyStatus;
  /** When false, no path may promote observations from this family to canonical PE years. */
  canWriteCanonical: boolean;
  notes: string;
  /** Speculative follow-on vehicle — never implies availability today. */
  futurePrHint?: string;
  /** Optional source-key prefixes that map into this family (normalized lowercase). */
  sourceKeyPrefixes?: readonly string[];
}

/**
 * Phase L decisions for closeout. Keep in sync with
 * docs/program-elements/source-coverage-matrix.md.
 */
export const PE_SOURCE_FAMILY_COVERAGE: readonly PeSourceFamilyCoverage[] = [
  {
    id: 'r1_r2_rdte_jbooks',
    label: 'R-1/R-2 RDT&E J-book exhibits',
    status: 'loaded',
    canWriteCanonical: true,
    notes: 'Core PE identity + request ladder from approved R-doc loaders on main/closeout.',
    sourceKeyPrefixes: ['r_doc', 'rdoc'],
  },
  {
    id: 'p1_p40_procurement',
    label: 'P-1/P-40 procurement exhibits',
    status: 'partial',
    canWriteCanonical: true,
    notes:
      'P-1/P-40 deterministic paths load line items; remaining P-5/P-21/P-3A depth is incomplete.',
    sourceKeyPrefixes: ['p_doc', 'pdoc'],
  },
  {
    id: 'committee_marks_reports',
    label: 'Committee marks and report language (HASC/SASC/HAC-D/SAC-D)',
    status: 'partial',
    canWriteCanonical: true,
    notes: 'Mark + provision extractors exist; coverage varies by FY and committee.',
    sourceKeyPrefixes: [
      'hasc_report',
      'sasc_report',
      'hac_d_report',
      'sac_d_report',
      'hacd_report',
      'sacd_report',
    ],
  },
  {
    id: 'ndaa_conference',
    label: 'NDAA conference / authorization conference',
    status: 'partial',
    canWriteCanonical: true,
    notes:
      'Authorization-track conference fields owned when source authority maps; not universal FY coverage.',
    sourceKeyPrefixes: ['conference_report', 'ndaa_conference'],
  },
  {
    id: 'defense_approps_conference_jes',
    label: 'Defense Appropriations conference / Joint Explanatory Statement (JES)',
    status: 'partial',
    canWriteCanonical: true,
    notes:
      'Appropriations conference authority exists for owned fields when an approved source is present; full JES narrative coverage is not claimed as complete.',
    sourceKeyPrefixes: ['approps_conference_report', 'appropriations_conference'],
  },
  {
    id: 'full_fydp_projection',
    label: 'Full FYDP projection coverage',
    status: 'partial',
    canWriteCanonical: true,
    notes:
      'Outyear request columns may appear on loaded lines; do not treat outyears as the current ask. Full multi-year FYDP reconstruction across accounts is not guaranteed.',
  },
  {
    id: 'execution_reprogramming_feeds',
    label: 'Execution / reprogramming feeds',
    status: 'unsupported',
    canWriteCanonical: false,
    notes: 'No approved continuous execution/reprogramming ingest in this release. Fail closed.',
    futurePrHint: 'future PR: pe-source-execution-reprogramming',
    sourceKeyPrefixes: ['execution_feed', 'reprogramming_feed', 'sf133', 'execution_scrape'],
  },
  {
    id: 'procurement_performer_coverage',
    label: 'Procurement performer / contractor coverage',
    status: 'partial',
    canWriteCanonical: true,
    notes:
      'Federal award / USAspending-linked performers exist for some PEs; unmatched dollars must stay candidates, never invent performers.',
    sourceKeyPrefixes: ['usaspending', 'federal_award'],
  },
  {
    id: 'milcon_c1',
    label: 'MILCON / C-1',
    status: 'unsupported',
    canWriteCanonical: false,
    notes: 'MILCON and C-1 exhibits are out of scope for the trust-foundation closeout.',
    futurePrHint: 'future PR: pe-source-milcon-c1',
    sourceKeyPrefixes: ['milcon', 'c1_exhibit', 'c_1'],
  },
  {
    id: 'reserve_exhibits',
    label: 'Reserve component exhibits',
    status: 'unsupported',
    canWriteCanonical: false,
    notes: 'Reserve-specific exhibits are not loaded as a first-class PE source family.',
    futurePrHint: 'future PR: pe-source-reserve-exhibits',
    sourceKeyPrefixes: ['reserve_exhibit', 'ng_exhibit', 'usar_exhibit'],
  },
  {
    id: 'p5_p21_p3a_op5_gaps',
    label: 'Remaining P-5 / P-21 / P-3A / OP-5 depth',
    status: 'blocked',
    canWriteCanonical: false,
    notes:
      'Gaps remain pending approved official fixtures and per-family parsers. Do not invent values or parsers in #705.',
    futurePrHint: 'future PR per exhibit family after fixture approval',
    sourceKeyPrefixes: ['p5_unreviewed', 'p21_unreviewed', 'p3a_unreviewed', 'op5_unreviewed'],
  },
  {
    id: 'sam_opportunity_personnel',
    label: 'SAM.gov opportunity + solicitation personnel',
    status: 'partial',
    canWriteCanonical: false,
    notes:
      'SAM matching may attach opportunities; personnel contacts are non-canonical program context with procurement-POC restrictions.',
    sourceKeyPrefixes: ['sam_opportunity', 'sam_gov'],
  },
] as const;

const BY_ID = new Map(PE_SOURCE_FAMILY_COVERAGE.map((row) => [row.id, row]));

export function getPeSourceFamilyCoverage(id: string): PeSourceFamilyCoverage | undefined {
  return BY_ID.get(id);
}

/** Families that must never become canonical from this release. */
export function unsupportedOrBlockedSourceFamilies(): readonly PeSourceFamilyCoverage[] {
  return PE_SOURCE_FAMILY_COVERAGE.filter(
    (row) => row.status === 'unsupported' || row.status === 'blocked' || !row.canWriteCanonical,
  );
}

/**
 * Fail-closed gate: if a source key matches an unsupported/blocked family prefix,
 * canonical ownership is denied even when a looser authority heuristic might guess.
 */
export function sourceKeyForbiddenForCanonical(sourceKey: string | null | undefined): boolean {
  if (!sourceKey) return false;
  const value = sourceKey.trim().toLowerCase().replace(/[-\s]+/g, '_');
  for (const family of PE_SOURCE_FAMILY_COVERAGE) {
    if (family.canWriteCanonical) continue;
    for (const prefix of family.sourceKeyPrefixes ?? []) {
      if (value === prefix || value.startsWith(`${prefix}_`) || value.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

/** Short model-facing caveat listing unavailable families (no false completeness). */
export function peSourceCoverageModelCaveat(): string {
  const missing = PE_SOURCE_FAMILY_COVERAGE.filter(
    (row) => row.status === 'unsupported' || row.status === 'blocked',
  );
  if (!missing.length) {
    return (
      'All documented PE source families are at least partially loaded; still verify per-line tools before asserting coverage.'
    );
  }
  const labels = missing.map((row) => `${row.label} (${row.status})`).join('; ');
  return (
    `Capiro does NOT currently load complete coverage for: ${labels}. ` +
    'Do not imply those families are available. Treat missing justification or marks as absent from loaded sources, not as proof of non-existence.'
  );
}
