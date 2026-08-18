/**
 * OLD-vs-NEW parity: the response CONTRACT of every representative route, plus
 * auth / tenant / error behaviour.
 *
 * Why static analysis of both sources rather than fixtures alone: several routes'
 * shaping is inline in the service (no pure function to call), and the failure mode
 * this session repairs is FIELD ABSENCE — the reduced implementation returned a
 * well-formed object that simply omitted enrichment. A fixture test passes happily
 * against a response missing ten fields; a required-field inventory does not.
 *
 * The inventories below are derived from apps/api's actual source (asserted present
 * there too, so this suite cannot drift into testing a fiction), and then required
 * of defense-api. If apps/api gains a field and defense-api does not, the apps/api
 * assertion still passes and the defense-api one fails — which is the direction
 * that matters.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const LEGACY_PE = read('apps/api/src/program-element/program-element-read.service.ts');
const LEGACY_BL = read('apps/api/src/program-element/budget-lines-read.service.ts');
const LEGACY_PROGRAMS = read('apps/api/src/program-element/programs/programs.service.ts');
const LEGACY_ISSUES = read('apps/api/src/program-element/program-element-data-issue.service.ts');

const NEXT_PE = read('apps/defense-api/src/program-elements/program-element-read.service.ts');
const NEXT_BL = read('apps/defense-api/src/program-elements/budget-lines-read.service.ts');
const NEXT_PROGRAMS = read('apps/defense-api/src/program-elements/programs.service.ts');
const NEXT_ISSUES = read('apps/defense-api/src/program-elements/program-element-data-issue.service.ts');

/**
 * The governed Program-graph admin boundary. Program mutations run inside
 * SECURITY DEFINER functions declared here, so for those routes this file IS part
 * of the new implementation and is checked as such.
 */
const NEXT_ADMIN_SQL = read(
  'apps/api/prisma/migrations/20261120210200_phase8_defense_program_admin_boundary/migration.sql',
);

/**
 * Slice one method body out of a service source: from its declaration to the start
 * of the next top-level `async`/`private` member. Crude but adequate and, crucially,
 * asserted non-empty at every call site so a rename cannot silently vacate a check.
 */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`async ${name}(`);
  assert.notEqual(start, -1, `could not find method ${name}`);
  const rest = source.slice(start + 1);
  const nextMember = rest.search(/\n {2}(?:\/\*\*|async |private |public )/);
  const body = nextMember === -1 ? rest : rest.slice(0, nextMember);
  assert.ok(body.length > 100, `method body for ${name} looks truncated`);
  return body;
}

interface RouteContract {
  /** Representative route label used in failure messages. */
  route: string;
  legacySource: string;
  legacyMethod: string;
  nextSource: string;
  nextMethod: string;
  /** Field/behaviour tokens that must appear in BOTH implementations. */
  required: string[];
  /** Tokens that must NOT appear in the new implementation. */
  forbidden?: string[];
  /**
   * Additional sources that count as part of the new implementation for this
   * route. Needed where behaviour legitimately lives outside the TypeScript
   * method — the governed Program-graph mutations execute inside SECURITY DEFINER
   * functions, so `status = 'merged'` and the FK re-points are in the migration,
   * not the service. The requirement is still "this behaviour exists in the new
   * implementation"; only its file changed.
   */
  extraNextSources?: string[];
}

/**
 * Tokens that exist only in the governed SQL layer, so the apps/api-side
 * inventory assertion skips them. Everything else must still be present in
 * apps/api first, which is what stops this suite drifting into testing a fiction.
 */
const GOVERNED_ONLY_TOKENS = new Set<string>([
  'capiro_defense_resolve_program_match',
  'capiro_defense_create_program_alias',
  'capiro_defense_update_program_alias',
  'capiro_defense_delete_program_alias',
  'capiro_defense_merge_programs',
  'weak_signal',
  'decision_notes',
  'audit_logs',
  'person_role',
  'program_office_program_link',
  'provision_pe_link',
  "status = 'merged'",
  'last ',
]);

const CONTRACTS: RouteContract[] = [
  {
    route: 'GET /program-elements (finder list)',
    legacySource: LEGACY_PE,
    legacyMethod: 'listProgramElements',
    nextSource: NEXT_PE,
    nextMethod: 'listProgramElements',
    required: [
      'markup-monitor',
      'program_element_detail_mv',
      'bill_count',
      'requestAtEnactedFy',
      'peCurrentCycleFy',
      'sqlCurrentCycleFyExpr',
      'fundingCurrentCoalesceSql',
      'fundingCurrentStageSql',
      'capability_budget_line_match',
      'program_element_intelligence_cache',
      'spark',
      'materiality_score',
      'normalizeServiceFilter',
      'similarity(pe.title',
    ],
  },
  {
    route: 'GET /program-elements/:peCode (detail)',
    legacySource: LEGACY_PE,
    legacyMethod: 'getProgramElement',
    nextSource: NEXT_PE,
    nextMethod: 'getProgramElement',
    required: [
      'fundingSummary',
      'renderPeFundingForModel',
      'currentCycleFyPreservingZero',
      'billCount',
      'projectCount',
      'sourceCount',
      'currentCycleFy',
      'currentUserIsWatching',
      'program_element_detail_mv',
      'detailCache',
    ],
  },
  {
    route: 'GET /program-elements/:peCode/timeline',
    legacySource: LEGACY_PE,
    legacyMethod: 'getTimeline',
    nextSource: NEXT_PE,
    nextMethod: 'getTimeline',
    required: [
      'currentCycleFyPreservingZero',
      'fundingSummary',
      'renderPeFundingForModel',
      'milestones',
      'appropriationType',
      'budgetActivity',
      'lineNumber',
    ],
  },
  {
    route: 'GET /program-elements/:peCode/intelligence',
    legacySource: LEGACY_PE,
    legacyMethod: 'getIntelligence',
    nextSource: NEXT_PE,
    nextMethod: 'getIntelligence',
    required: [
      'buildIntelligence',
      'maturityLadder',
      'appropriability',
      'valleyOfDeath',
      'cacheComputedAt',
      'outyears',
      'quantity',
    ],
  },
  {
    route: 'GET /program-elements/:peCode/narrative',
    legacySource: LEGACY_PE,
    legacyMethod: 'getNarrative',
    nextSource: NEXT_PE,
    nextMethod: 'getNarrative',
    required: ['assembleFundingNarrative', 'predictedConferenceAmount', 'materiality', 'steps'],
  },
  {
    route: 'GET /program-elements/:peCode/bills',
    legacySource: LEGACY_PE,
    legacyMethod: 'getBills',
    nextSource: NEXT_PE,
    nextMethod: 'getBills',
    required: [
      'peCodeCount',
      'budgetPackage',
      'budgetPackageVehicle',
      'billBudgetLineLink',
      'committeeRefs',
      'sponsor',
      'introducedDate',
    ],
  },
  {
    route: 'GET /program-elements/:peCode/bill-actions',
    legacySource: LEGACY_PE,
    legacyMethod: 'getBillActions',
    nextSource: NEXT_PE,
    nextMethod: 'getBillActions',
    required: ['normalizeBillStage', 'stageLabel', 'stageRank', 'billCount', 'peCodeCount'],
  },
  {
    route: 'GET /program-elements/:peCode/contractors',
    legacySource: LEGACY_PE,
    legacyMethod: 'getContractors',
    nextSource: NEXT_PE,
    nextMethod: 'getContractors',
    required: [
      'namedPrimes',
      'governmentExhibit',
      'federalAwards',
      'partitionContractorEvidence',
      'legacy_compatibility',
      'live_external',
      'windowMonths',
      'program_element_acquisition_program',
      'dod_acq_program_code',
      'attribution',
      'evidenceNote',
    ],
    // The two measures are never summed into one figure.
    forbidden: ['directAwardM + namedPrimeM'],
  },
  {
    route: 'GET /program-elements/:peCode/projects',
    legacySource: LEGACY_PE,
    legacyMethod: 'getProjects',
    nextSource: NEXT_PE,
    nextMethod: 'getProjects',
    required: ['projectCode', 'mission', 'budgetActivity', 'sourceUrl', 'pageNumber', 'confidence'],
  },
  {
    route: 'GET /program-elements/:peCode/procurement-lines',
    legacySource: LEGACY_PE,
    legacyMethod: 'getProcurementLines',
    nextSource: NEXT_PE,
    nextMethod: 'getProcurementLines',
    required: ['recipients', 'fyRows', 'unitCost', 'sourceUrl', 'totalRows', 'years'],
  },
  {
    route: 'GET /program-elements/:peCode/sources (provenance)',
    legacySource: LEGACY_PE,
    legacyMethod: 'getSources',
    nextSource: NEXT_PE,
    nextMethod: 'getSources',
    required: [
      'exhibitType',
      'publisher',
      'snippet',
      'confidence',
      'pageEnd',
      'sourceDocument',
      'budgetCycle',
      'sha256',
      'compareProofPackSources',
    ],
  },
  {
    route: 'GET /program-elements/:peCode/related',
    legacySource: LEGACY_PE,
    legacyMethod: 'getRelatedProgramElements',
    nextSource: NEXT_PE,
    nextMethod: 'getRelatedProgramElements',
    required: ['context_embeddings', 'similarity', 'related', 'todo', 'source_type'],
  },
  {
    route: 'GET /program-elements/:peCode/programs',
    legacySource: LEGACY_PE,
    legacyMethod: 'getProgramsForPe',
    nextSource: NEXT_PE,
    nextMethod: 'getProgramsForPe',
    required: [
      'acceptedMatches',
      'candidateMatches',
      'confidenceBand',
      'evidenceTier',
      'whyShown',
      'evidence',
      'projectCode',
      'component',
    ],
  },
  {
    route: 'GET /program-elements/:peCode/provisions',
    legacySource: LEGACY_PE,
    legacyMethod: 'getProvisionsForPe',
    nextSource: NEXT_PE,
    nextMethod: 'getProvisionsForPe',
    required: ['programId', 'reviewStatus', 'matchBasis'],
  },
  {
    route: 'GET /program-elements/:peCode/opportunities',
    legacySource: LEGACY_PE,
    legacyMethod: 'getOpportunitiesForPe',
    nextSource: NEXT_PE,
    nextMethod: 'listOpportunities',
    required: ['noticeId', 'pscCode', 'naicsCode', 'pocName', 'pocEmail', 'responseDeadline', 'active'],
  },
  {
    route: 'GET /program-elements/:peCode/positions',
    legacySource: LEGACY_PE,
    // apps/api's getBudgetPositions is only a snapshot/legacy dispatcher; the field
    // projection lives in getBudgetPositionsLegacy. defense-api serves the legacy
    // side directly (no snapshot gate in Session 3), so that is the right comparand.
    legacyMethod: 'getBudgetPositionsLegacy',
    nextSource: NEXT_PE,
    nextMethod: 'getBudgetPositions',
    required: ['positionCycle', 'assertedFy', 'valueKind', 'quantity', 'sourceUrl', 'pageNumber'],
  },
  {
    route: 'GET /program-elements/deltas/needs-attention',
    legacySource: LEGACY_PE,
    legacyMethod: 'getNeedsAttention',
    nextSource: NEXT_PE,
    nextMethod: 'getNeedsAttention',
    required: ['clientRelevant', 'effectiveScore', 'minScore', 'materialityScore'],
  },
  {
    route: 'POST /program-elements/:peCode/watch',
    legacySource: LEGACY_PE,
    legacyMethod: 'setWatching',
    nextSource: NEXT_PE,
    nextMethod: 'setWatching',
    required: [
      'isLegacyPeWatchConstraintConflict',
      'PE_WATCH_TENANT_KEY_ROLLOUT_PENDING',
      'auditLog',
      'ON CONFLICT',
    ],
  },
  {
    route: 'GET/PUT /program-elements/alerts/email-pref',
    legacySource: LEGACY_PE,
    legacyMethod: 'getPeAlertEmailPref',
    nextSource: NEXT_PE,
    nextMethod: 'getPeAlertEmailPref',
    required: ['daily'],
  },
  {
    route: 'GET /budget-lines/:peCode/actions',
    legacySource: LEGACY_BL,
    legacyMethod: 'getActions',
    nextSource: NEXT_BL,
    nextMethod: 'getActions',
    required: ['budgetAction', 'baseline', 'evidenceJson', 'stage'],
  },
  {
    route: 'GET /budget-lines/:peCode/relationships',
    legacySource: LEGACY_BL,
    legacyMethod: 'getRelationships',
    nextSource: NEXT_BL,
    nextMethod: 'getRelationships',
    required: ['direction', 'relType', 'evidence', 'lineType', 'maturity', 'appropTier', 'appropScore'],
  },
  {
    route: 'GET /budget-lines/:peCode/incumbents',
    legacySource: LEGACY_BL,
    legacyMethod: 'getIncumbents',
    nextSource: NEXT_BL,
    nextMethod: 'getIncumbents',
    required: ['peCodeCandidateCount', 'costCategory', 'totalCostM', 'tableType'],
  },
  {
    route: 'GET /budget-lines/movement',
    legacySource: LEGACY_BL,
    legacyMethod: 'getMovement',
    nextSource: NEXT_BL,
    nextMethod: 'getMovement',
    required: ['heatmap', 'conference', 'anomalies', 'kpis', 'openFy', 'feed', 'addsTotal', 'cutsTotal'],
  },
  {
    route: 'GET /budget-lines/graph',
    legacySource: LEGACY_BL,
    legacyMethod: 'getGraph',
    nextSource: NEXT_BL,
    nextMethod: 'getGraph',
    required: ['nodes', 'edges', 'valleyOfDeath', 'relType', 'evidence'],
  },
  {
    route: 'GET /budget-lines/watchlist-signals',
    legacySource: LEGACY_BL,
    legacyMethod: 'getWatchSignals',
    nextSource: NEXT_BL,
    nextMethod: 'getWatchSignals',
    required: ['budgetAction', 'withTenant', 'stage', 'action'],
  },
  {
    route: 'GET /budget-lines/capabilities',
    legacySource: LEGACY_BL,
    legacyMethod: 'listCapabilities',
    nextSource: NEXT_BL,
    nextMethod: 'listCapabilities',
    required: [
      'buildCapabilityTotal',
      'requestCoverage',
      'requestByLineType',
      'requestFiscalYear',
      'taxonomyPath',
      'USD millions',
    ],
  },
  {
    route: 'GET /budget-lines/capabilities/:slug/recommendations',
    legacySource: LEGACY_BL,
    legacyMethod: 'getCapabilityRecommendations',
    nextSource: NEXT_BL,
    nextMethod: 'getCapabilityRecommendations',
    required: ['wedge', 'matchConfidence', 'matchedOn', 'latestCurrentStage', 'requestClaim', 'currentClaim', 'appropScore'],
  },
  {
    route: 'GET /budget-lines/search',
    legacySource: LEGACY_BL,
    legacyMethod: 'searchCapabilityLines',
    nextSource: NEXT_BL,
    nextMethod: 'searchCapabilityLines',
    required: ['context_embeddings', 'mission similarity', 'wedge', 'requestClaim', 'currentClaim'],
  },
  {
    route: 'GET /programs (search)',
    legacySource: LEGACY_PROGRAMS,
    legacyMethod: 'searchPrograms',
    nextSource: NEXT_PROGRAMS,
    nextMethod: 'searchPrograms',
    required: ['bestAlias', 'alias_normalized', 'component', 'mdapCode'],
  },
  {
    route: 'GET /programs/:id',
    legacySource: LEGACY_PROGRAMS,
    legacyMethod: 'getProgram',
    nextSource: NEXT_PROGRAMS,
    nextMethod: 'getProgram',
    required: [
      'awards',
      'performers',
      'component',
      'capabilityArea',
      'acquisitionPathway',
      'description',
      'confidenceBand',
      'whyShown',
      'dodAcqProgramCode',
      'isNamedCompany',
    ],
  },
  {
    route: 'GET /programs/admin/match-queue',
    legacySource: LEGACY_PROGRAMS,
    legacyMethod: 'listMatchQueue',
    nextSource: NEXT_PROGRAMS,
    nextMethod: 'listMatchQueue',
    required: ['weakSignal', 'quarantined', 'matchBasis', 'confidenceBand', 'programElement'],
  },
  {
    route: 'POST /programs/admin/match-queue/:id/resolve',
    legacySource: LEGACY_PROGRAMS,
    legacyMethod: 'resolveMatch',
    nextSource: NEXT_PROGRAMS,
    nextMethod: 'resolveMatch',
    required: [
      'mdap_curated',
      // The write itself is governed: weak_signal clearing, decision notes and the
      // audit row are inside capiro_defense_resolve_program_match.
      'capiro_defense_resolve_program_match',
      'weak_signal',
      'decision_notes',
      'audit_logs',
    ],
    extraNextSources: [NEXT_ADMIN_SQL],
  },
  {
    route: 'POST /programs/admin/:programId/aliases',
    legacySource: LEGACY_PROGRAMS,
    legacyMethod: 'createAlias',
    nextSource: NEXT_PROGRAMS,
    nextMethod: 'createAlias',
    required: [
      'isGenericAlias',
      'aliasNormalized',
      'already exists',
      'analyst_manual',
      'capiro_defense_create_program_alias',
    ],
    extraNextSources: [NEXT_ADMIN_SQL],
  },
  {
    route: 'DELETE /programs/admin/aliases/:id',
    legacySource: LEGACY_PROGRAMS,
    legacyMethod: 'deleteAlias',
    nextSource: NEXT_PROGRAMS,
    nextMethod: 'deleteAlias',
    required: [
      'canonical',
      'remainingCanonical',
      // The refusal is enforced in BOTH layers.
      'capiro_defense_delete_program_alias',
      'last ',
    ],
    extraNextSources: [NEXT_ADMIN_SQL],
  },
  {
    route: 'POST /programs/admin/merge',
    legacySource: LEGACY_PROGRAMS,
    legacyMethod: 'mergePrograms',
    nextSource: NEXT_PROGRAMS,
    nextMethod: 'mergePrograms',
    required: [
      // Physical table names: the re-points execute inside the governed function.
      'person_role',
      'program_office_program_link',
      'provision_pe_link',
      "status = 'merged'",
      'mergedInto',
      'already merged',
      'capiro_defense_merge_programs',
    ],
    // The loser is retired, never hard-deleted -- in either layer.
    forbidden: ['program.delete(', 'programDelete', 'DELETE FROM public.program '],
    extraNextSources: [NEXT_ADMIN_SQL],
  },
  {
    route: 'POST /program-elements/:peCode/data-issues',
    legacySource: LEGACY_ISSUES,
    legacyMethod: 'create',
    nextSource: NEXT_ISSUES,
    nextMethod: 'create',
    required: ['suggestedSourceUrl', 'normalizeFieldName', 'normalizeFy', 'normalizeSourceUrl'],
  },
];

test('PARITY: every representative route contract holds on BOTH implementations', () => {
  const failures: string[] = [];
  for (const c of CONTRACTS) {
    const legacyBody = methodBody(c.legacySource, c.legacyMethod);
    const nextBody = methodBody(c.nextSource, c.nextMethod);
    for (const token of c.required) {
      // Tokens naming the governed SQL (function names, physical columns) have no
      // counterpart in apps/api's TypeScript; they are new-implementation-only.
      if (GOVERNED_ONLY_TOKENS.has(token)) continue;
      if (!legacyBody.includes(token)) {
        // The inventory itself has drifted from apps/api — report it as such rather
        // than blaming defense-api for a field apps/api no longer serves.
        failures.push(
          `[inventory stale] ${c.route}: "${token}" is no longer present in apps/api ${c.legacyMethod}`,
        );
        continue;
      }
      const inNext =
        nextBody.includes(token) ||
        (c.extraNextSources ?? []).some((extra) => extra.includes(token));
      if (!inNext) {
        failures.push(`[gap] ${c.route}: defense-api ${c.nextMethod} is missing "${token}"`);
      }
    }
    for (const token of c.forbidden ?? []) {
      const sources = [nextBody, ...(c.extraNextSources ?? [])];
      if (sources.some((source) => source.includes(token))) {
        failures.push(`[forbidden] ${c.route}: defense-api ${c.nextMethod} contains "${token}"`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);
});

test('PARITY: no route body is an unconditional empty-result stub', () => {
  // The exact Session 3 regression: five Budget Lines methods returned `{data: []}`
  // with no query at all. A method that reaches the database and legitimately finds
  // nothing is fine; a method whose ONLY behaviour is to return empty is not.
  const STUB_SUSPECTS: Array<[string, string, string]> = [
    ['budget-lines getActions', NEXT_BL, 'getActions'],
    ['budget-lines getMovement', NEXT_BL, 'getMovement'],
    ['budget-lines listCapabilities', NEXT_BL, 'listCapabilities'],
    ['budget-lines getCapabilityRecommendations', NEXT_BL, 'getCapabilityRecommendations'],
    ['budget-lines searchCapabilityLines', NEXT_BL, 'searchCapabilityLines'],
    ['budget-lines getWatchSignals', NEXT_BL, 'getWatchSignals'],
    ['budget-lines getIncumbents', NEXT_BL, 'getIncumbents'],
    ['budget-lines getGraph', NEXT_BL, 'getGraph'],
    ['budget-lines getRelationships', NEXT_BL, 'getRelationships'],
  ];
  for (const [label, source, method] of STUB_SUSPECTS) {
    const body = methodBody(source, method);
    assert.ok(
      /this\.prisma\./.test(body),
      `${label} never touches the database — it is a stub, not an implementation`,
    );
    // A `return { data: [] }` is only acceptable behind a guard (an early return on
    // empty input); it must never be the sole statement.
    const returnsOnlyEmpty =
      /^\s*(?:const peCode[^\n]*\n)?\s*return \{\s*data:\s*\[\]\s*,?\s*[^}]*\};\s*$/m.test(body) &&
      !/this\.prisma\./.test(body);
    assert.ok(!returnsOnlyEmpty, `${label} unconditionally returns an empty payload`);
  }
});

test('PARITY: peCode normalization is applied consistently on every peCode-taking method', () => {
  // The audit found peCode handling was inconsistent across nearly every method:
  // some trimmed+uppercased+threw, others trimmed only and silently produced an
  // empty code, others did nothing. Inconsistency here means the SAME peCode string
  // resolves differently depending on which panel asked.
  const offenders: string[] = [];
  for (const [label, source] of [
    ['program-element-read', NEXT_PE],
    ['budget-lines-read', NEXT_BL],
  ] as const) {
    const re = /async (\w+)\(\s*peCodeRaw[^)]*\)[^{]*\{([\s\S]{0,400})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const [, method, head] = m;
      if (!head!.includes('requirePeCode(peCodeRaw)')) {
        offenders.push(`${label}.${method} does not normalize via requirePeCode`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);

  // And every such method must take the raw parameter name, so the check above
  // cannot be defeated by renaming the parameter.
  const rawTakers = [...NEXT_PE.matchAll(/async (\w+)\(\s*peCode:/g)].map((m) => m[1]);
  assert.deepEqual(
    rawTakers,
    [],
    `these methods accept a pre-normalized peCode and bypass requirePeCode: ${rawTakers.join(', ')}`,
  );
});
