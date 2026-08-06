import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import baseline from './__fixtures__/baseline-contract-v1.json';
import {
  MACHINE_RECOMMENDATIONS,
  RECOMMENDATION_CONFIDENCES,
} from './opportunity-recommendation.js';
import {
  ELIGIBILITY_STATES,
  HUMAN_DECISION_STATUSES,
  NON_PURSUABLE_KINDS,
  OPPORTUNITY_KINDS,
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_WORKFLOW_STATUSES,
  WORKFLOW_SORT_PRIORITY,
} from './funding-opportunities.types.js';
import type {
  ClientFundingOpportunitySummary,
  ContractValue,
  FundingOpportunity,
  FundingOpportunityCounts,
  FundingOpportunityListResponse,
  GrantEnrichmentHealth,
  GrantFunding,
  MissingProfileField,
  OpportunityMatchedSignal,
  OpportunitySourceFreshness,
  OpportunityWorkflow,
} from './funding-opportunities.types.js';

/**
 * P00 — the frozen baseline contract.
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT A SNAPSHOT TEST
 * -------------------------------------------------------
 * Every phase after this one adds fields, tables and surfaces to Funding
 * Opportunities. `__fixtures__/baseline-contract-v1.json` records what the
 * contract and its vocabularies looked like BEFORE any of that, so a later phase
 * that quietly renames a field, drops a workflow status, blends grant money into
 * contract money, or makes a nullable money field non-nullable fails here instead
 * of being discovered by a client.
 *
 * It is deliberately NOT `toMatchSnapshot()`. A snapshot is regenerated with
 * `-u` by whoever broke it, which is precisely the review step that matters. A
 * checked-in fixture has to be edited by hand, in the diff, with a reason.
 *
 * THE FIXTURE IS BUILT FROM STATIC CONSTRUCTORS, NOT FROM A TENANT
 * ---------------------------------------------------------------
 * The literals below are typed as the real interfaces, so TypeScript rejects a
 * missing or misspelled property at compile time, and `Object.keys` on them is
 * the runtime key set. Nothing here reads a database, a fixture recorded from a
 * live response, or a tenant. That is a requirement, not an implementation
 * detail: a baseline captured from production data freezes that data's
 * accidents (a null that happened to be populated that week) as if they were
 * the contract.
 *
 * The typed literals catch a REMOVED or RENAMED field. They cannot catch an
 * ADDED optional one, because a literal that omits it still compiles — so the
 * interface source is parsed as well, and both must agree with the fixture.
 */

// ── Static constructors. Typed, so tsc enforces exhaustiveness. ─────────────

const GRANT_FUNDING: GrantFunding = {
  estimatedProgramFunding: null,
  awardFloor: null,
  awardCeiling: null,
  expectedAwardCount: null,
  costSharingRequired: null,
};

const CONTRACT_VALUE: ContractValue = {
  estimatedValue: null,
  basis: 'not_stated_by_source',
};

const MATCHED_SIGNAL: OpportunityMatchedSignal = {
  signal: 'exact_naics_match',
  strength: 'strong',
  weight: 1,
  matchedOn: '541330',
};

const MISSING_PROFILE_FIELD: MissingProfileField = {
  field: 'naicsCodes',
  label: 'NAICS codes',
  impact: 'Contract notices are matched on NAICS before anything else.',
  href: null,
};

const WORKFLOW: OpportunityWorkflow = {
  id: 'wf-1',
  status: 'suggested',
  owner: null,
  facility: null,
  notes: null,
  dismissedReason: null,
  outcomeNote: null,
  userCreated: false,
  staleAt: null,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};

const OWNER: NonNullable<OpportunityWorkflow['owner']> = {
  userId: 'u-1',
  name: null,
  email: null,
};

const FACILITY: NonNullable<OpportunityWorkflow['facility']> = {
  id: 'f-1',
  name: 'Plant 4',
  state: null,
  districtKey: null,
};

const PLACE_OF_PERFORMANCE: NonNullable<FundingOpportunity['placeOfPerformance']> = {
  city: null,
  state: null,
  zip: null,
  country: null,
};

const ELIGIBILITY: FundingOpportunity['eligibility'] = {
  state: 'unknown',
  reason: 'The notice does not state eligible applicant types.',
};

/**
 * A grant row. Money is all null on purpose: null is the contract's way of
 * saying the source stated no figure, and this constructor is the thing that
 * proves a null survives to the response instead of becoming 0.
 */
const RECOMMENDATION: NonNullable<FundingOpportunity['recommendation']> = {
  machineRecommendation: 'pass',
  recommendationConfidence: 'high',
  primaryReason: 'No strong match against this client.',
  primaryRisk: null,
  recommendedNextAction: 'No action.',
  reasonCodes: ['below_evidence_floor'],
};

const OPPORTUNITY: FundingOpportunity = {
  id: 'grants_gov:ABC-123',
  source: 'grants_gov',
  sourceRecordId: 'ABC-123',
  sourceReference: 'ABC-123',
  sourceUrl: null,
  kind: 'grant',
  kindRaw: null,
  baseKind: null,
  title: 'Advanced Manufacturing Research',
  agency: null,
  subAgency: null,
  office: null,
  status: null,
  postedDate: null,
  responseDeadline: null,
  responseDeadlineNote: null,
  closeOrArchiveDate: null,
  isActive: true,
  isPursuable: true,
  summary: null,
  summaryIsLink: false,
  naicsCodes: [],
  pscCodes: [],
  setAside: null,
  setAsideCode: null,
  eligibleApplicantTypes: [],
  assistanceListings: [],
  fundingInstrument: null,
  category: null,
  grantFunding: GRANT_FUNDING,
  contractValue: null,
  placeOfPerformance: null,
  districtKey: null,
  districtBasis: null,
  relevanceScore: 0,
  eligibility: ELIGIBILITY,
  // Null is the honest value on an unscoped row. The constructor below covers the
  // populated shape.
  recommendation: null,
  matchedSignals: [],
  missingProfileFields: [],
  sourceUpdatedAt: null,
  workflow: null,
  clientId: null,
};

const COUNTS: FundingOpportunityCounts = {
  activeGrants: 0,
  activeContracts: 0,
  saved: 0,
  pursuing: 0,
  dismissed: 0,
  deadlinesIn30Days: 0,
};

const ENRICHMENT: GrantEnrichmentHealth = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  degraded: null,
  detailedRecordCount: null,
  activeAwaitingEnrichment: null,
};

const FRESHNESS: OpportunitySourceFreshness = {
  source: 'grants_gov',
  verb: 'sync-grants',
  label: 'Grants.gov',
  lastSyncedAt: null,
  lastAttemptAt: null,
  lastRunStatus: null,
  lastRunErrorCount: null,
  lastFailureAt: null,
  hoursSinceLastSuccess: null,
  neverSynced: true,
  lastRunDegraded: null,
  countsUnavailable: false,
  recordCount: null,
  activeRecordCount: null,
  enrichment: null,
};

const LIST_RESPONSE: FundingOpportunityListResponse = {
  opportunities: [],
  total: 0,
  totalIsCapped: false,
  page: 1,
  pageSize: 25,
  counts: COUNTS,
  freshness: [],
  emptyReason: 'no_source_records',
  emptyExplanation: 'The Grants.gov rail has never completed a sync.',
  missingProfileFields: [],
  generatedAt: '2026-08-06T00:00:00.000Z',
};

const SUMMARY: ClientFundingOpportunitySummary = {
  clientId: 'c-1',
  counts: COUNTS,
  nextDeadline: null,
  topGrants: [],
  topContracts: [],
  missingProfileFields: [],
  freshness: [],
  emptyReason: null,
  emptyExplanation: null,
  generatedAt: '2026-08-06T00:00:00.000Z',
};

const NEXT_DEADLINE: NonNullable<ClientFundingOpportunitySummary['nextDeadline']> = {
  opportunityId: 'grants_gov:ABC-123',
  title: 'Advanced Manufacturing Research',
  source: 'grants_gov',
  responseDeadline: '2026-09-01T00:00:00.000Z',
};

// ── Source parsing, so an ADDED optional field is caught too ────────────────

const TYPES_SOURCE = readFileSync(join(__dirname, 'funding-opportunities.types.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(join(__dirname, 'funding-opportunities.service.ts'), 'utf8');
const CI_WORKFLOW = join(__dirname, '../../../../.github/workflows/funding-opportunities-ci.yml');
const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '');
}

/** Body text of `export interface <name> { … }`, brace-matched. */
function interfaceBody(name: string): string {
  const src = stripComments(TYPES_SOURCE);
  const open = new RegExp(`export interface ${name}\\s*\\{`).exec(src);
  if (!open) throw new Error(`interface ${name} not found in funding-opportunities.types.ts`);
  const from = open.index + open[0].length;
  let depth = 1;
  let i = from;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(from, i - 1);
}

/**
 * Top-level property names of an interface body. Nested object types are
 * collapsed to a placeholder first so a nested type's own keys do not leak up
 * and read as siblings.
 */
function topLevelKeys(body: string): string[] {
  let flat = body;
  for (let guard = 0; guard < 20; guard += 1) {
    const next = flat.replace(/\{[^{}]*\}/g, ' _ ');
    if (next === flat) break;
    flat = next;
  }
  return [...flat.matchAll(/(?:^|;|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/g)].map((m) => m[1]!);
}

/**
 * Declared type text of one property, e.g. `Money` for `awardFloor: Money;`.
 *
 * Terminates on a `;` at brace depth zero, not on the first `;` in the string:
 * an inline object type such as `{ state: EligibilityState; reason: string }`
 * contains its own separators, and stopping at the first one silently returns
 * half a type.
 */
function declaredType(body: string, key: string): string {
  const start = new RegExp(`(?:^|;|\\n)\\s*${key}\\s*\\??\\s*:\\s*`).exec(body);
  if (!start) throw new Error(`property ${key} not found`);
  let i = start.index + start[0].length;
  const from = i;
  let depth = 0;
  for (; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) break;
  }
  return body.slice(from, i).trim();
}

/** Quoted string-literal members of a `type X = 'a' | 'b';` alias. */
function unionMembers(name: string): string[] {
  const src = stripComments(TYPES_SOURCE);
  const m = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(src);
  if (!m) throw new Error(`type alias ${name} not found`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const CONSTRUCTED_KEYS: Record<string, string[]> = {
  FundingOpportunity: Object.keys(OPPORTUNITY),
  'FundingOpportunity.eligibility': Object.keys(ELIGIBILITY),
  'FundingOpportunity.placeOfPerformance': Object.keys(PLACE_OF_PERFORMANCE),
  GrantFunding: Object.keys(GRANT_FUNDING),
  ContractValue: Object.keys(CONTRACT_VALUE),
  OpportunityWorkflow: Object.keys(WORKFLOW),
  'OpportunityWorkflow.owner': Object.keys(OWNER),
  'OpportunityWorkflow.facility': Object.keys(FACILITY),
  OpportunityMatchedSignal: Object.keys(MATCHED_SIGNAL),
  MissingProfileField: Object.keys(MISSING_PROFILE_FIELD),
  FundingOpportunityCounts: Object.keys(COUNTS),
  OpportunitySourceFreshness: Object.keys(FRESHNESS),
  GrantEnrichmentHealth: Object.keys(ENRICHMENT),
  OpportunityRecommendationView: Object.keys(RECOMMENDATION),
  FundingOpportunityListResponse: Object.keys(LIST_RESPONSE),
  ClientFundingOpportunitySummary: Object.keys(SUMMARY),
  'ClientFundingOpportunitySummary.nextDeadline': Object.keys(NEXT_DEADLINE),
};

// ── The frozen response contract ────────────────────────────────────────────

describe('the frozen response contract still matches the code', () => {
  test('the fixture covers every shape the constructors build, and no others', () => {
    expect(Object.keys(baseline.responseKeys).sort()).toEqual(Object.keys(CONSTRUCTED_KEYS).sort());
  });

  test.each(Object.keys(CONSTRUCTED_KEYS))('%s has exactly the frozen keys', (shape) => {
    const frozen = (baseline.responseKeys as Record<string, string[]>)[shape]!;
    expect([...CONSTRUCTED_KEYS[shape]!].sort()).toEqual([...frozen].sort());
  });

  test.each([
    'FundingOpportunity',
    'GrantFunding',
    'ContractValue',
    'OpportunityWorkflow',
    'OpportunityMatchedSignal',
    'MissingProfileField',
    'FundingOpportunityCounts',
    'OpportunitySourceFreshness',
    'GrantEnrichmentHealth',
    'OpportunityRecommendationView',
    'FundingOpportunityListResponse',
    'ClientFundingOpportunitySummary',
  ])('the %s INTERFACE declares exactly the frozen keys (catches an added optional)', (name) => {
    const frozen = (baseline.responseKeys as Record<string, string[]>)[name]!;
    expect(topLevelKeys(interfaceBody(name)).sort()).toEqual([...frozen].sort());
  });
});

// ── No blended money ────────────────────────────────────────────────────────

describe('grant money and contract money are never blended', () => {
  const allowlist = new Set(Object.keys(baseline.blendedTotalAllowlist));

  test('no frozen key is an amount, and no total is unaccounted for', () => {
    for (const [shape, keys] of Object.entries(baseline.responseKeys as Record<string, string[]>)) {
      for (const key of keys) {
        expect(key).not.toMatch(/amount/i);
        if (/^total/i.test(key)) {
          // A `total*` key is only ever allowed to be a row count, and it has to
          // be named in the fixture's allowlist with a reason saying so.
          expect(allowlist.has(`${shape}.${key}`)).toBe(true);
        }
      }
    }
  });

  test('every allowlisted total is a real key, so the allowlist cannot rot', () => {
    for (const entry of allowlist) {
      const dot = entry.lastIndexOf('.');
      const shape = entry.slice(0, dot);
      const key = entry.slice(dot + 1);
      expect((baseline.responseKeys as Record<string, string[]>)[shape]).toContain(key);
    }
  });

  test('a grant carries no contract value and a contract carries no grant funding', () => {
    // The two money blocks are mutually exclusive by source, which is what makes
    // a blended total impossible to compute by accident downstream.
    expect(OPPORTUNITY.source).toBe('grants_gov');
    expect(OPPORTUNITY.contractValue).toBeNull();

    const samRow: FundingOpportunity = {
      ...OPPORTUNITY,
      id: 'sam_gov:11111111-1111-1111-1111-111111111111',
      source: 'sam_gov',
      grantFunding: null,
      contractValue: CONTRACT_VALUE,
    };
    expect(samRow.grantFunding).toBeNull();
  });
});

// ── Null money is not zero ──────────────────────────────────────────────────

describe('null money means "no figure stated", never zero', () => {
  test('Money is number | null', () => {
    expect(stripComments(TYPES_SOURCE)).toMatch(/export type Money\s*=\s*number\s*\|\s*null;/);
  });

  test.each(baseline.moneyFields)('%s is declared as Money', (path) => {
    const [shape, key] = path.split('.') as [string, string];
    expect(declaredType(interfaceBody(shape), key)).toBe('Money');
  });

  test('a null money field survives a JSON round trip as null, not 0', () => {
    const round = JSON.parse(JSON.stringify({ grantFunding: GRANT_FUNDING, contractValue: CONTRACT_VALUE }));
    expect(round.grantFunding.estimatedProgramFunding).toBeNull();
    expect(round.grantFunding.awardFloor).toBeNull();
    expect(round.grantFunding.awardCeiling).toBeNull();
    expect(round.contractValue.estimatedValue).toBeNull();
  });

  test('the service never zero-fills a money field', () => {
    // The mutation this catches: `awardCeiling: g.awardCeiling ?? 0`. The type
    // stays `Money`, every other test in this file still passes, and every grant
    // with no stated ceiling starts claiming the source said zero.
    const src = stripComments(SERVICE_SOURCE);
    for (const key of ['estimatedProgramFunding', 'awardFloor', 'awardCeiling', 'estimatedValue']) {
      for (const line of src.split('\n')) {
        if (!line.includes(key)) continue;
        expect(line).not.toMatch(/(\?\?|\|\|)\s*0\b/);
      }
    }
  });
});

// ── Relevance is not eligibility ────────────────────────────────────────────

describe('relevance and eligibility stay separate concepts', () => {
  test('both are top-level keys, and neither is the other', () => {
    const keys = baseline.responseKeys.FundingOpportunity;
    expect(keys).toContain('relevanceScore');
    expect(keys).toContain('eligibility');
  });

  test('relevanceScore is a number and eligibility is a reasoned state', () => {
    const body = interfaceBody('FundingOpportunity');
    expect(declaredType(body, 'relevanceScore')).toBe('number');
    // Eligibility must carry a reason. A bare enum would let the UI show
    // "Not eligible" with nothing an operator can check or dispute.
    expect(declaredType(body, 'eligibility')).toMatch(/state:\s*EligibilityState/);
    expect(declaredType(body, 'eligibility')).toMatch(/reason:\s*string/);
    expect(ELIGIBILITY.reason.length).toBeGreaterThan(0);
  });

  test('there is no single merged fit score', () => {
    for (const key of baseline.responseKeys.FundingOpportunity) {
      expect(key).not.toMatch(/^(score|fitScore|matchScore|overallScore)$/);
    }
  });
});

// ── Frozen vocabularies ─────────────────────────────────────────────────────

describe('the frozen vocabularies still match the runtime constants', () => {
  test('OPPORTUNITY_SOURCES', () => {
    expect([...OPPORTUNITY_SOURCES]).toEqual(baseline.vocabularies.OPPORTUNITY_SOURCES);
  });

  test('OPPORTUNITY_KINDS, in order', () => {
    expect([...OPPORTUNITY_KINDS]).toEqual(baseline.vocabularies.OPPORTUNITY_KINDS);
  });

  test('NON_PURSUABLE_KINDS', () => {
    expect([...NON_PURSUABLE_KINDS].sort()).toEqual(
      [...baseline.vocabularies.NON_PURSUABLE_KINDS].sort(),
    );
  });

  test('OPPORTUNITY_WORKFLOW_STATUSES, in order', () => {
    // Order is part of the contract: the migration's CHECK constraint and the
    // web mirror are both written against this list.
    expect([...OPPORTUNITY_WORKFLOW_STATUSES]).toEqual(
      baseline.vocabularies.OPPORTUNITY_WORKFLOW_STATUSES,
    );
  });

  test('HUMAN_DECISION_STATUSES', () => {
    expect([...HUMAN_DECISION_STATUSES].sort()).toEqual(
      [...baseline.vocabularies.HUMAN_DECISION_STATUSES].sort(),
    );
  });

  test('WORKFLOW_SORT_PRIORITY', () => {
    expect({ ...WORKFLOW_SORT_PRIORITY }).toEqual(baseline.vocabularies.WORKFLOW_SORT_PRIORITY);
  });

  test('ELIGIBILITY_STATES, in order', () => {
    expect([...ELIGIBILITY_STATES]).toEqual(baseline.vocabularies.ELIGIBILITY_STATES);
  });

  test('EmptyReason has no member meaning "the request failed"', () => {
    expect(unionMembers('EmptyReason').sort()).toEqual(
      [...baseline.vocabularies.EMPTY_REASONS].sort(),
    );
    for (const member of unionMembers('EmptyReason')) {
      expect(member).not.toMatch(/error|fail|unavailable|degraded/i);
    }
  });

  test('the recommendation vocabularies are frozen', () => {
    expect([...MACHINE_RECOMMENDATIONS]).toEqual(baseline.vocabularies.MACHINE_RECOMMENDATIONS);
    expect([...RECOMMENDATION_CONFIDENCES]).toEqual(
      baseline.vocabularies.RECOMMENDATION_CONFIDENCES,
    );
  });

  test('confidence is never named like a probability', () => {
    // The field is evidence quality. A value called "likely" or a percent band
    // would invite exactly the win-rate reading the contract forbids.
    for (const value of RECOMMENDATION_CONFIDENCES) {
      expect(value).not.toMatch(/likely|probab|percent|%|win/i);
    }
  });

  test('ContractValue.basis distinguishes "source said nothing" from "source said this"', () => {
    const basis = declaredType(interfaceBody('ContractValue'), 'basis');
    expect(basis).toContain("'not_stated_by_source'");
    expect(basis).toContain("'source_backed'");
  });
});

// ── The gate itself ─────────────────────────────────────────────────────────

describe('the release gate cannot shrink below its frozen floor', () => {
  const yml = existsSync(CI_WORKFLOW) ? readFileSync(CI_WORKFLOW, 'utf8') : '';

  test('the dedicated CI workflow exists', () => {
    expect(yml.length).toBeGreaterThan(0);
  });

  const floors: Array<[string, { suites: number; tests: number }]> = [
    ['api', baseline.testFloors.api],
    ['web', baseline.testFloors.web],
  ];

  test.each(floors)('the %s floor is at or above the frozen floor', (app, floor) => {
    const m = new RegExp(`assert-test-summary\\.mjs[^\\n]*apps/${app}\\s+(\\d+)\\s+(\\d+)`).exec(yml);
    expect(m).not.toBeNull();
    const [suites, tests] = [Number(m![1]), Number(m![2])];
    expect(suites).toBeGreaterThanOrEqual(floor.suites);
    expect(tests).toBeGreaterThanOrEqual(floor.tests);
  });

  test('this spec is inside the gate’s enumerated api scope', () => {
    // The gate lists suites explicitly. A new spec under a path the gate does not
    // name is a test nobody runs.
    expect(yml).toContain('src/funding-opportunities/');
  });

  test('the frozen feature flag is the one the guard uses', () => {
    expect(baseline.featureFlag).toBe('funding_opportunities');
  });

  test('every frozen migration is still on disk', () => {
    const present = new Set(
      readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
    for (const name of baseline.migrations) expect(present.has(name)).toBe(true);
  });

  test('the baseline records the base SHA it was frozen at', () => {
    // Without this, "the baseline" is whatever main happened to be when someone
    // last looked, which is not a baseline.
    expect(baseline.frozenAtBaseSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
