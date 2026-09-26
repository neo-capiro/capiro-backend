import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MeriOpportunityToolsAdapter,
  MERI_OPPORTUNITY_TOOLS,
  MERI_TOOL_CAPS,
  MERI_TOOL_MAX_CHARS,
  FUNDING_OPPORTUNITIES_MERI_V2_FEATURE,
  asOpportunitySource,
  cap,
  clampText,
  isDeniedPacket,
  toBrief,
  toFacts,
} from './meri-opportunity-tools.adapter.js';
import type { FundingOpportunity, MissingProfileField } from './funding-opportunities.types.js';
import type { TenantRole } from '@capiro/shared';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { FundingOpportunityV2SearchService } from './funding-opportunity-v2-search.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { FundingOpportunityV2DetailService } from './funding-opportunity-v2-detail.service.js';

/**
 * Typed local Meri opportunity tools (P37).
 *
 * Five properties carry the phase, and each has its own describe block below:
 *
 *   1. The gate is (flag, role, wall) — in that order, and all three fail
 *      CLOSED. A denied client is indistinguishable from one that does not
 *      exist.
 *   2. Nothing here can reach MakeGov/Tango or a credential. Asserted against
 *      the source text, not against a mock that could be wired differently in
 *      production.
 *   3. Funding Opportunities does not import Meri. The one-way dependency is
 *      the whole reason the adapter lives in this directory.
 *   4. Missing data is stated, never inferred into an absence.
 *   5. Output is bounded, and a shortened result says so.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const OTHER_CLIENT = '99999999-9999-9999-9999-999999999999';
const SAM_ID = '44444444-4444-4444-4444-444444444444';
const AS_OF = new Date('2026-08-07T12:00:00.000Z');

interface Actor {
  tenantId: string;
  userId: string;
  role: TenantRole;
}
const STANDARD: Actor = { tenantId: TENANT, userId: USER, role: 'standard_user' };
const PORTAL: Actor = { tenantId: TENANT, userId: USER, role: 'client_portal_user' };

/** The one profile gap every fixture below carries. */
const MISSING_CERTIFICATIONS: MissingProfileField = {
  field: 'certifications',
  label: 'Certifications',
  impact: 'Eligibility for set-aside notices cannot be checked without them.',
  href: null,
};

// ── Fixtures ────────────────────────────────────────────────────────────────

function opportunity(over: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    id: `sam_gov:${SAM_ID}`,
    source: 'sam_gov',
    sourceRecordId: SAM_ID,
    sourceReference: 'N0001926R0042',
    sourceUrl: 'https://sam.gov/opp/example',
    kind: 'solicitation',
    kindRaw: 'Solicitation',
    baseKind: 'solicitation',
    title: 'Shipboard power conversion units',
    agency: 'Department of the Navy',
    subAgency: 'NAVSEA',
    office: 'Philadelphia',
    status: 'posted',
    postedDate: '2026-07-01T00:00:00.000Z',
    responseDeadline: '2026-10-01T17:00:00.000Z',
    responseDeadlineNote: null,
    closeOrArchiveDate: null,
    isActive: true,
    isPursuable: true,
    summary: 'Procurement of shipboard power conversion units.',
    summaryIsLink: false,
    naicsCodes: ['335313'],
    pscCodes: ['6110'],
    setAside: null,
    setAsideCode: null,
    eligibleApplicantTypes: [],
    assistanceListings: [],
    fundingInstrument: null,
    category: null,
    grantFunding: null,
    contractValue: null,
    placeOfPerformance: { city: 'Philadelphia', state: 'PA', zip: null, country: 'USA' },
    districtKey: null,
    districtBasis: null,
    relevanceScore: 72,
    eligibility: { state: 'needs_review', reason: 'No recorded certifications to check against.' },
    matchedSignals: [
      { signal: 'exact_naics_match', strength: 'strong', weight: 30, matchedOn: '335313' },
      { signal: 'exact_product_service_match', strength: 'strong', weight: 30, matchedOn: '6110' },
    ],
    recommendation: {
      machineRecommendation: 'needs_review',
      recommendationConfidence: 'medium',
      primaryReason: 'Exact NAICS and PSC match.',
      primaryRisk: 'Eligibility is unresolved.',
      recommendedNextAction: 'Confirm certifications.',
      reasonCodes: [],
    },
    acquisitionPosition: null,
    missingProfileFields: [MISSING_CERTIFICATIONS],
    sourceUpdatedAt: '2026-08-06T00:00:00.000Z',
    workflow: null,
    decision: null,
    clientId: CLIENT,
    ...over,
  } as FundingOpportunity;
}

function landscapePacket(over: Record<string, unknown> = {}) {
  return {
    clientId: CLIENT,
    source: 'sam_gov',
    sourceRecordId: SAM_ID,
    items: [
      {
        source: 'program_element',
        sourceId: 'match-1',
        label: 'Program Element 0204163N, linked by a reviewed and accepted match.',
        basis: 'source_backed',
        matchedOn: '0204163N',
        evidenceRef: 'sam_opportunity_match:match-1',
        asOf: null,
      },
    ],
    sources: [
      { source: 'program_element', state: 'available', itemCount: 1, explanation: '1 item.' },
      { source: 'hearing', state: 'not_wired', itemCount: 0, explanation: 'Not joined yet.' },
    ],
    coverage: { available: 1, wired: 3, declared: 11 },
    fingerprint: 'abc123',
    generatedAt: AS_OF.toISOString(),
    ...over,
  };
}

/**
 * The adapter with hand-rolled collaborators.
 *
 * `flagEnabled` defaults TRUE so a test about the wall is not silently
 * measuring the flag instead — the disabled case has its own tests and says so
 * explicitly.
 */
function makeAdapter(
  over: {
    flagEnabled?: boolean;
    masterEnabled?: boolean;
    documentsEnabled?: boolean;
    flagThrows?: boolean;
    visibleClientIds?: string[];
    getOpportunity?: (...args: unknown[]) => Promise<FundingOpportunity>;
    search?: (...args: unknown[]) => Promise<unknown>;
    getRequirements?: (...args: unknown[]) => Promise<unknown>;
    getClientSummary?: () => Promise<unknown>;
    compose?: (...args: unknown[]) => Promise<unknown>;
    composeActionPlan?: (...args: unknown[]) => Promise<unknown>;
  } = {},
) {
  const calls = {
    flag: 0,
    wall: 0,
    getOpportunity: 0,
    summary: 0,
    compose: 0,
    plan: 0,
    list: 0,
    requirements: 0,
  };
  const flagEnabled = over.flagEnabled ?? true;
  const visible = over.visibleClientIds ?? [CLIENT];

  const prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => {
      calls.flag += 1;
      if (over.flagThrows) throw new Error('42883 operator does not exist: text = uuid');
      return fn({
        $queryRaw: async (_query: TemplateStringsArray, ...values: unknown[]) => {
          const enabled = values.includes('funding_opportunities_documents')
            ? (over.documentsEnabled ?? true)
            : values.includes('funding_opportunities')
              ? (over.masterEnabled ?? true)
              : flagEnabled;
          return enabled ? [{ ok: 1 }] : [];
        },
      });
    },
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) => {
      calls.wall += 1;
      return fn({
        client: {
          findMany: async () => visible.map((id) => ({ id, memoryWall: false })),
        },
        clientMemoryAccess: { findMany: async () => [] },
      });
    },
  };

  const canonicalRow = (overrides: Record<string, unknown> = {}) => ({
    id: `sam_gov:${SAM_ID}`, source: 'sam_gov', sourceRecordId: SAM_ID,
    title: 'Shipboard power conversion units', agency: 'Department of the Navy',
    sourceUrl: 'https://sam.gov/opp/example', type: 'solicitation', lifecycle: 'active',
    postedDate: '2026-07-01T00:00:00.000Z', deadline: '2026-10-01T17:00:00.000Z',
    closeOrArchiveDate: null, isPursuable: true, summary: 'Procurement of shipboard power conversion units.',
    naicsCodes: ['335313'], pscCodes: ['6110'], setAside: null, applicantTypes: [], geography: [],
    value: null, valueBasis: 'not_stated_by_source', sourceFacts: { provenance: 'test', sourceUpdated: '2026-08-06T00:00:00.000Z' },
    relevanceScore: 72, matchedSignals: [],
    eligibility: { state: 'needs_review', reason: 'No recorded certifications to check against.' },
    clientId: CLIENT, ...overrides,
  });
  const canonicalResponse = (overrides: Record<string, unknown> = {}) => ({
    criteria: {}, opportunities: [canonicalRow()], page: 1, pageSize: 5, total: 1,
    totalIsCapped: false, catalogComplete: true,
    counts: { grants: 0, contracts: 1, active: 1, closed: 0 }, mode: 'matched', clientId: CLIENT,
    freshness: [], provenance: [], emptyReason: null, profileGaps: null,
    generatedAt: AS_OF.toISOString(), ...overrides,
  });
  const search = jest.fn(async (...args: unknown[]) => {
    calls.list += 1;
    if (over.search) return over.search(...args);
    return canonicalResponse();
  });
  const opportunities = { search };
  const opportunityDetails = {
    readDetail: jest.fn(async (...args: unknown[]) => {
      const legacy = over.getOpportunity ? await over.getOpportunity(...args) : null;
      const requestedSource = String(args[1] ?? 'sam_gov');
      const requestedId = String(args[2] ?? SAM_ID);
      const canonical = legacy
        ? canonicalRow({
            id: `${requestedSource}:${requestedId}`, source: requestedSource, sourceRecordId: requestedId,
            type: legacy.kind === 'grant' ? 'grant' : 'solicitation', lifecycle: legacy.status === 'posted' ? 'active' : legacy.status,
            title: legacy.title, agency: legacy.agency, sourceUrl: legacy.sourceUrl,
            postedDate: legacy.postedDate, deadline: legacy.responseDeadline, closeOrArchiveDate: legacy.closeOrArchiveDate,
            isPursuable: legacy.isPursuable, summary: legacy.summary, naicsCodes: legacy.naicsCodes, pscCodes: legacy.pscCodes,
            applicantTypes: legacy.eligibleApplicantTypes, value: legacy.contractValue?.estimatedValue ?? null,
            sourceFacts: { sourceUpdated: legacy.sourceUpdatedAt, opportunityNumber: legacy.sourceReference },
            relevanceScore: legacy.relevanceScore, matchedSignals: legacy.matchedSignals,
            eligibility: legacy.eligibility, clientId: legacy.clientId,
          })
        : canonicalRow({ id: `${requestedSource}:${requestedId}`, source: requestedSource, sourceRecordId: requestedId });
      return {
        opportunity: canonical,
        generatedAt: AS_OF.toISOString(), source: requestedSource, sourceRecordId: requestedId,
        authoritativeSourceUrl: canonical.sourceUrl,
      };
    }),
  };
  const landscape = {
    compose: async (...args: unknown[]) => {
      calls.compose += 1;
      if (over.compose) return over.compose(...args);
      return landscapePacket();
    },
    composeActionPlan: async (...args: unknown[]) => {
      calls.plan += 1;
      if (over.composeActionPlan) return over.composeActionPlan(...args);
      return {
        state: 'available',
        explanation: 'Proposed actions only. Nothing here is committed until somebody accepts it.',
        plan: {
          source: 'sam_gov',
          sourceRecordId: SAM_ID,
          clientId: CLIENT,
          stage: 'solicitation',
          actions: [{ category: 'respond', title: 'Draft the response', intent: 'pursuit' }],
          fingerprint: 'plan-abc',
          generatedAt: AS_OF.toISOString(),
        },
        acceptance: { wired: true, explanation: 'Accepting creates or reuses the matching task.' },
      };
    },
  };

  const requirements = {
    getRequirements: async (...args: unknown[]) => {
      calls.requirements += 1;
      if (over.getRequirements) return over.getRequirements(...args);
      return {
        source: 'sam_gov',
        sourceRecordId: SAM_ID,
        requirements: [],
        coverage: 'no_documents',
        coverageExplanation: 'No documents archived; nothing has been read.',
        documentTextStatus: [],
        generatedAt: AS_OF.toISOString(),
        pagination: { offset: 0, limit: 10, total: 0, hasMore: false, nextOffset: null },
      };
    },
  };
  const adapter = new MeriOpportunityToolsAdapter(
    prisma as never,
    opportunities as never,
    landscape as never,
    requirements as never,
    opportunityDetails as never,
  );
  return { adapter, calls, search, opportunityDetails };
}

/** Every tool, called with its own required inputs. One list, all call sites. */
function invokeAll(adapter: MeriOpportunityToolsAdapter, actor: Actor, clientId = CLIENT) {
  return [
    adapter.searchFundingOpportunities(actor, { clientId }, AS_OF),
    adapter.getFundingOpportunityRequirements(
      actor,
      { clientId, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    ),
    adapter.getFundingOpportunity(
      actor,
      { clientId, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    ),
    adapter.explainOpportunityMatch(
      actor,
      { clientId, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    ),
    adapter.getOpportunityClientContext(actor, { clientId }, AS_OF),
    adapter.getOpportunityGovernmentLandscape(
      actor,
      { clientId, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    ),
    adapter.compareFundingOpportunities(
      actor,
      {
        clientId,
        opportunities: [
          { source: 'sam_gov', sourceRecordId: SAM_ID },
          { source: 'grants_gov', sourceRecordId: 'GRANT-1' },
        ],
      },
      AS_OF,
    ),
    adapter.buildOpportunityActionPlan(
      actor,
      { clientId, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    ),
  ];
}

// ── 1. The gate ─────────────────────────────────────────────────────────────

describe('P37 — the gate is flag, then role, then wall, and all three fail closed', () => {
  it('every tool stays disabled when Meri is enabled but the Funding Opportunities master is off', async () => {
    const { adapter, calls } = makeAdapter({ masterEnabled: false, flagEnabled: true });
    const results = await Promise.all(invokeAll(adapter, STANDARD));
    expect(results.every((result) => result.state === 'disabled' && result.data === null)).toBe(
      true,
    );
    expect(calls.wall).toBe(0);
    expect(calls.getOpportunity + calls.summary + calls.compose + calls.plan).toBe(0);
  });

  it('every tool returns `disabled` when the flag is off, and reads nothing', async () => {
    const { adapter, calls } = makeAdapter({ flagEnabled: false });
    const results = await Promise.all(invokeAll(adapter, STANDARD));

    expect(results).toHaveLength(MERI_OPPORTUNITY_TOOLS.length);
    for (const result of results) {
      expect(result.state).toBe('disabled');
      expect(result.data).toBeNull();
      // The wording must not imply anything about the client's opportunities.
      expect(result.explanation).toContain('not enabled for this workspace');
    }
    // Nothing past the flag ran: no wall query, no opportunity read.
    expect(calls.wall).toBe(0);
    expect(calls.getOpportunity).toBe(0);
    expect(calls.summary).toBe(0);
    expect(calls.compose).toBe(0);
    expect(calls.plan).toBe(0);
  });

  it('a THROWING flag read fails closed rather than killing the turn', async () => {
    const { adapter } = makeAdapter({ flagThrows: true });
    const results = await Promise.all(invokeAll(adapter, STANDARD));
    for (const result of results) expect(result.state).toBe('disabled');
  });

  it('a portal user is refused BEFORE any client read is issued', async () => {
    const { adapter, calls } = makeAdapter();
    const results = await Promise.all(invokeAll(adapter, PORTAL));

    for (const result of results) {
      expect(result.state).toBe('denied');
      expect(result.data).toBeNull();
    }
    // The refusal costs no query, so it cannot be timed to reveal a row.
    expect(calls.wall).toBe(0);
    expect(calls.getOpportunity).toBe(0);
  });

  it('a walled client is refused, and the refusal reads identically to a non-existent one', async () => {
    const { adapter } = makeAdapter({ visibleClientIds: [] });
    const walled = await Promise.all(invokeAll(adapter, STANDARD, CLIENT));
    const nonexistent = await Promise.all(invokeAll(adapter, STANDARD, OTHER_CLIENT));

    expect(walled).toHaveLength(nonexistent.length);
    walled.forEach((result, i) => {
      const twin = nonexistent[i]!;
      expect(result.state).toBe('denied');
      expect(twin.state).toBe('denied');
      // Byte-identical: the only thing distinguishing them would let a reader
      // enumerate clients behind an ethical wall.
      expect(result.explanation).toBe(twin.explanation);
      expect(result).toEqual(twin);
    });
  });

  it('a denied wall never reaches the underlying services', async () => {
    const { adapter, calls } = makeAdapter({ visibleClientIds: [] });
    await Promise.all(invokeAll(adapter, STANDARD));
    expect(calls.getOpportunity).toBe(0);
    expect(calls.summary).toBe(0);
    expect(calls.compose).toBe(0);
    expect(calls.plan).toBe(0);
  });

  it("P33's own denied packet maps back to the envelope's denied, not to an empty landscape", async () => {
    // The composer applies the wall itself. If the adapter's wall ever widens
    // relative to P33's, this is the path that keeps the answer honest.
    const { adapter } = makeAdapter({
      compose: async () =>
        landscapePacket({
          items: [],
          sources: [
            {
              source: 'program_element',
              state: 'denied',
              itemCount: 0,
              explanation: 'Not available for this client.',
            },
            {
              source: 'hearing',
              state: 'denied',
              itemCount: 0,
              explanation: 'Not available for this client.',
            },
          ],
        }),
    });
    const result = await adapter.getOpportunityGovernmentLandscape(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.state).toBe('denied');
    expect(result.data).toBeNull();
  });

  it('a malformed clientId is an invalid request, not a wall denial', async () => {
    // Telling the model its id was malformed gets a corrected retry. "Not
    // available for this client" tells it to give up on a client that is fine.
    const { adapter, calls } = makeAdapter();
    const result = await adapter.getOpportunityClientContext(
      STANDARD,
      { clientId: 'not-a-uuid' },
      AS_OF,
    );
    expect(result.state).toBe('invalid_request');
    expect(calls.wall).toBe(0);
  });

  it('isDeniedPacket does not treat a packet with no sources as denied', () => {
    // `[].every()` is true. Without the length guard a malformed packet would
    // silently read as an access refusal.
    expect(isDeniedPacket({ sources: [] })).toBe(false);
    expect(isDeniedPacket({ sources: [{ state: 'denied' }] })).toBe(true);
    expect(isDeniedPacket({ sources: [{ state: 'denied' }, { state: 'empty' }] })).toBe(false);
  });
});

// ── 2. No provider reach ────────────────────────────────────────────────────

describe('P37 — no tool can call Tango or retrieve a credential', () => {
  const source = readFileSync(join(__dirname, 'meri-opportunity-tools.adapter.ts'), 'utf8');
  // Comments are stripped so a docblock MENTIONING Tango (this file's own does,
  // and should) cannot fail an assertion about imports.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('imports nothing from the provider adapter directory', () => {
    expect(code).not.toContain('external/tango');
    expect(code).not.toContain('@makegov');
  });

  it('names no credential, secret or gateway', () => {
    for (const forbidden of [
      'TANGO_API_KEY',
      'SecretsManager',
      'getSecret',
      'TangoGateway',
      'TangoStoreService',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('reaches the network through nothing — no fetch, no http client', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain('axios');
    expect(code).not.toContain('HttpService');
  });

  it('the constructor takes four canonical local collaborators', () => {
    // Name every local dependency so an external provider cannot arrive unnoticed.
    expect(MeriOpportunityToolsAdapter.length).toBe(5);
    expect(code).toContain('private readonly prisma: PrismaService');
    expect(code).toContain('private readonly opportunities: FundingOpportunityV2SearchService');
    expect(code).toContain('private readonly landscape: GovernmentLandscapeService');
    expect(code).toContain('private readonly requirements: OpportunityRequirementService');
  });
});

// ── 3. The one-way module dependency ────────────────────────────────────────

describe('P37 — Funding Opportunities does not import Meri', () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('no file in this directory imports from src/meri', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/from\s+['"][^'"]*\/meri\//.test(text) || /from\s+['"]\.\.\/meri/.test(text)) {
        offenders.push(file);
      }
    }
    // A cycle here is not a lint preference: MeriModule imports this module, so
    // the reverse edge turns into a Nest bootstrap failure at runtime.
    expect(offenders).toEqual([]);
  });

  it('the module registers and EXPORTS the adapter, which is how Meri reaches it', () => {
    const moduleText = readFileSync(join(dir, 'funding-opportunities.module.ts'), 'utf8');
    expect(moduleText).toContain('MeriOpportunityToolsAdapter');
    // Registered as a provider AND exported — a provider alone would resolve
    // inside this module and fail to inject in Meri's.
    const exportsBlock = moduleText.slice(moduleText.indexOf('exports:'));
    expect(exportsBlock).toContain('MeriOpportunityToolsAdapter');
  });

  it('Meri registers all funding tools, and the two lists cannot drift', () => {
    const meriDir = join(dir, '..', 'meri');
    const toolsText = readFileSync(join(meriDir, 'meri-tools.service.ts'), 'utf8');
    for (const tool of MERI_OPPORTUNITY_TOOLS) {
      // Declared in TOOL_DEFINITIONS, given a schema, and dispatched. All three
      // or the tool is half-registered — which is exactly how a tool ends up
      // advertised to the model and then throwing when selected.
      expect(MERI_CAPABILITY_REGISTRY.find((entry) => entry.name === tool)).toMatchObject({
        backend: 'meri',
        readOnly: true,
        surfaces: ['full_chat'],
      });
      expect(toolsText).toContain(`case '${tool}':`);
      expect(toolsText).toMatch(new RegExp(`\\b${tool}:\\s*(obj\\(|\\{)`));
    }
  });

  it('MeriModule imports FundingOpportunitiesModule', () => {
    const meriModule = readFileSync(join(dir, '..', 'meri', 'meri.module.ts'), 'utf8');
    expect(meriModule).toContain('FundingOpportunitiesModule');
  });
});

// ── 4. Honest answers ───────────────────────────────────────────────────────

describe('P37 — missing data is stated, never inferred into an absence', () => {
  it('a record the catalog does not hold is `not_found`, and says what that does not mean', async () => {
    const { adapter } = makeAdapter({
      getOpportunity: async () => {
        throw new NotFoundException('Opportunity not found');
      },
    });
    const result = await adapter.getFundingOpportunity(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.state).toBe('not_found');
    expect(result.explanation).toContain(
      'says nothing about whether the notice exists at the source',
    );
  });

  it('a source outside the vocabulary is refused by name, not silently treated as SAM', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.getFundingOpportunity(
      STANDARD,
      { clientId: CLIENT, source: 'dibbs', sourceRecordId: 'x' },
      AS_OF,
    );
    expect(result.state).toBe('unsupported_source');
    expect(result.explanation).toContain('dibbs');
    expect(calls.getOpportunity).toBe(0);
  });

  it('the landscape refuses a non-SAM source without claiming the others have no context', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.getOpportunityGovernmentLandscape(
      STANDARD,
      { clientId: CLIENT, source: 'grants_gov', sourceRecordId: 'GRANT-1' },
      AS_OF,
    );
    expect(result.state).toBe('unsupported_source');
    expect(result.explanation).toContain('Nothing here says the other sources lack context');
    expect(calls.compose).toBe(0);
  });

  it('relevance, eligibility, recommendation and the human decision stay four separate fields', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.explainOpportunityMatch(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.state).toBe('available');
    const data = result.data!;
    expect(data.relevanceScore).toBe(72);
    expect(data.eligibility.state).toBe('needs_review');
    expect(data.recommendation).toBeNull();
    expect(data.humanDecision).toBeNull();
    // No blended field anywhere: a single "score" is the one thing a model
    // would collapse the four into.
    expect(Object.keys(data)).not.toContain('score');
    expect(Object.keys(data)).not.toContain('overallScore');
  });

  it('profile gaps travel with the explanation, so a thin profile is not reported as a bad fit', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.explainOpportunityMatch(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.data!.missingProfileFields).toBeNull();
    // The gap travels with its own IMPACT sentence, not just a key: that is
    // what lets a model say "unassessable" instead of "poor fit".
    expect(MISSING_CERTIFICATIONS.impact.length).toBeGreaterThan(10);
  });

  it('grant funding and contract value are separate fields and no total is emitted', () => {
    const facts = toFacts(
      opportunity({
        grantFunding: {
          estimatedProgramFunding: 5_000_000,
          awardFloor: 100_000,
          awardCeiling: 500_000,
          expectedAwardCount: 10,
          costSharingRequired: false,
        },
        contractValue: { estimatedValue: 2_000_000, basis: 'source_backed' },
      }),
    );
    expect(facts.grantFunding).not.toBeNull();
    expect(facts.contractValue).not.toBeNull();
    const keys = Object.keys(facts);
    expect(keys).not.toContain('totalAmount');
    expect(keys).not.toContain('totalValue');
    expect(keys.filter((k) => /^total/i.test(k))).toEqual([]);
  });

  it('null money stays null and is never rendered as zero', () => {
    const facts = toFacts(opportunity({ grantFunding: null, contractValue: null }));
    expect(facts.grantFunding).toBeNull();
    expect(facts.contractValue).toBeNull();
  });

  it('a comparison lists the row it could not read rather than dropping it', async () => {
    const { adapter } = makeAdapter({
      getOpportunity: async (...args: unknown[]) => {
        if (args[2] === 'MISSING') throw new NotFoundException('Opportunity not found');
        return opportunity();
      },
    });
    const result = await adapter.compareFundingOpportunities(
      STANDARD,
      {
        clientId: CLIENT,
        opportunities: [
          { source: 'sam_gov', sourceRecordId: SAM_ID },
          { source: 'sam_gov', sourceRecordId: 'MISSING' },
          { source: 'dibbs', sourceRecordId: 'X' },
        ],
      },
      AS_OF,
    );
    expect(result.state).toBe('available');
    expect(result.data!.rows).toHaveLength(3);
    expect(result.data!.rows.map((r) => r.state)).toEqual([
      'available',
      'not_found',
      'unsupported_source',
    ]);
    // The failed rows still carry their reason, so the comparison cannot read
    // as complete.
    for (const row of result.data!.rows.slice(1))
      expect(row.explanation.length).toBeGreaterThan(10);
  });

  it('a comparison of fewer than two is an invalid request, not an empty answer', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.compareFundingOpportunities(
      STANDARD,
      { clientId: CLIENT, opportunities: [{ source: 'sam_gov', sourceRecordId: SAM_ID }] },
      AS_OF,
    );
    expect(result.state).toBe('invalid_request');
  });

  it('the action plan says PROPOSALS ONLY, and the adapter holds nothing that could write one', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.buildOpportunityActionPlan(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.state).toBe('available');
    expect(result.explanation).toContain('PROPOSALS ONLY');
    expect(result.explanation).toContain('Nothing here is committed');
    expect(result.data!.acceptance.wired).toBe(true);

    // Structural, not just prose: no write verb anywhere in the file.
    const code = readFileSync(join(__dirname, 'meri-opportunity-tools.adapter.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const verb of [
      '.create(',
      '.update(',
      '.upsert(',
      '.delete(',
      '.createMany(',
      '$executeRaw',
    ]) {
      expect(code).not.toContain(verb);
    }
  });

  it('an unknown record from the planner is `not_found`, and a refused one is `invalid_request`', async () => {
    const unknown = makeAdapter({
      composeActionPlan: async () => ({
        state: 'unknown_record',
        explanation: 'Capiro holds no record for this opportunity.',
        plan: null,
        acceptance: { wired: true, explanation: '' },
      }),
    });
    expect(
      (
        await unknown.adapter.buildOpportunityActionPlan(
          STANDARD,
          { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
          AS_OF,
        )
      ).state,
    ).toBe('not_found');

    const refused = makeAdapter({
      composeActionPlan: async () => {
        throw new BadRequestException(
          'An action plan is composed for SAM.gov contract opportunities.',
        );
      },
    });
    const result = await refused.adapter.buildOpportunityActionPlan(
      STANDARD,
      { clientId: CLIENT, source: 'grants_gov', sourceRecordId: 'G' },
      AS_OF,
    );
    expect(result.state).toBe('invalid_request');
    // The human-written refusal survives; a stack-shaped string does not.
    expect(result.explanation).toContain('composed for SAM.gov');
  });

  it('a non-BadRequest failure is reported without leaking its message', async () => {
    const { adapter } = makeAdapter({
      composeActionPlan: async () => {
        throw new BadRequestException({ message: undefined });
      },
    });
    const result = await adapter.buildOpportunityActionPlan(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.state).toBe('invalid_request');
    expect(result.explanation).toBe('Capiro refused this request. Check the source and record id.');
  });

  it('every envelope echoes the caller’s asOf, so a cached answer cannot look current', async () => {
    const { adapter } = makeAdapter();
    const results = await Promise.all(invokeAll(adapter, STANDARD));
    for (const result of results) expect(result.asOf).toBe(AS_OF.toISOString());
  });

  it('the same facts and the same asOf produce byte-identical results', async () => {
    const a = makeAdapter();
    const b = makeAdapter();
    const first = await Promise.all(invokeAll(a.adapter, STANDARD));
    const second = await Promise.all(invokeAll(b.adapter, STANDARD));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ── 5. Bounded output ───────────────────────────────────────────────────────

describe('P37 — output is bounded, and a shortened result says so', () => {
  it('signals are capped and the loss is reported', async () => {
    const many = Array.from({ length: MERI_TOOL_CAPS.signals + 7 }, (_, i) => ({
      signal: 'exact_naics_match',
      strength: 'strong' as const,
      matchedOn: `33531${i}`,
    }));
    const { adapter } = makeAdapter({
      getOpportunity: async () =>
        opportunity({ matchedSignals: many as FundingOpportunity['matchedSignals'] }),
    });
    const result = await adapter.explainOpportunityMatch(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.data!.signals).toHaveLength(MERI_TOOL_CAPS.signals);
    expect(result.truncated).toEqual([
      { collection: 'signals', kept: MERI_TOOL_CAPS.signals, total: many.length },
    ]);
  });

  it('`truncated` is ABSENT when nothing was dropped, not an empty array', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.explainOpportunityMatch(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    // A model reading `truncated: []` has to reason about it. Absence is the
    // stronger statement.
    expect('truncated' in result).toBe(false);
  });

  it('a comparison beyond the row cap keeps the first N and says how many were asked for', async () => {
    const refs = Array.from({ length: MERI_TOOL_CAPS.comparisonRows + 3 }, (_, i) => ({
      source: 'sam_gov',
      sourceRecordId: `id-${i}`,
    }));
    const { adapter } = makeAdapter();
    const result = await adapter.compareFundingOpportunities(
      STANDARD,
      { clientId: CLIENT, opportunities: refs },
      AS_OF,
    );
    expect(result.data!.rows).toHaveLength(MERI_TOOL_CAPS.comparisonRows);
    expect(result.truncated).toEqual([
      { collection: 'rows', kept: MERI_TOOL_CAPS.comparisonRows, total: refs.length },
    ]);
  });

  it('long free text is trimmed WITH the marker inside the string it trimmed', () => {
    const long = 'x'.repeat(MERI_TOOL_CAPS.summaryChars + 500);
    const clamped = clampText(long, MERI_TOOL_CAPS.summaryChars)!;
    // Inside the string, not in a sibling field: the value gets quoted, and a
    // quote of a truncated synopsis must carry its own caveat.
    expect(clamped).toContain('truncated by Capiro');
    expect(clamped.length).toBeLessThan(long.length);
    expect(clampText(null, 10)).toBeNull();
    expect(clampText('short', 10)).toBe('short');
  });

  it('an oversized envelope becomes a refusal, never a half-serialized body', () => {
    const huge = {
      tool: 'get_funding_opportunity' as const,
      state: 'available' as const,
      explanation: 'ok',
      asOf: AS_OF.toISOString(),
      data: { blob: 'y'.repeat(MERI_TOOL_MAX_CHARS + 100) },
    };
    const capped = cap(huge);
    expect(capped.state).toBe('invalid_request');
    expect(capped.data).toBeNull();
    expect(capped.explanation).toContain(String(MERI_TOOL_MAX_CHARS));
  });

  it('every real result stays under the ceiling', async () => {
    const { adapter } = makeAdapter();
    const results = await Promise.all(invokeAll(adapter, STANDARD));
    for (const result of results) {
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(MERI_TOOL_MAX_CHARS);
      // …and none of them hit the last-resort path, which would mean a missing
      // per-collection cap rather than a tuning problem.
      expect(result.state).not.toBe('invalid_request');
    }
  });
});

// ── Vocabulary and pure helpers ─────────────────────────────────────────────

describe('government-affairs funding evidence contract', () => {
  it('resolves the canonical matching and requirement providers through Nest injection', async () => {
    // Regression test for a real production incident (2026-09-17..2026-09-23): the
    // "feat(funding): launch Funding Opportunities v2" refactor (d1c784a4b) moved a type
    // declaration to where `@Injectable()` sat directly above this class and silently
    // dropped the decorator. Without it, TypeScript emits NO constructor parameter-type
    // metadata for this class at all, so Nest's injector falls back to an empty
    // dependency list and constructs the adapter with `new MeriOpportunityToolsAdapter()`
    // — every one of its five fields silently `undefined`. `toBeInstanceOf` alone does
    // NOT catch this (a zero-arg construction is still `instanceof`), which is exactly
    // how this shipped unnoticed for six days despite this file's other 50+ tests: they
    // all hand-construct the adapter via `new MeriOpportunityToolsAdapter(...)` directly,
    // bypassing Nest's DI container entirely. This test uses DISTINCT, non-empty marker
    // objects for every dependency and asserts each one is the SAME object reference on
    // the constructed instance — the only way to actually prove real injection occurred.
    const markers = {
      prisma: { marker: 'prisma' },
      opportunities: { marker: 'opportunities' },
      landscape: { marker: 'landscape' },
      requirements: { marker: 'requirements' },
      opportunityDetails: { marker: 'opportunityDetails' },
    };
    const module = await Test.createTestingModule({
      providers: [
        MeriOpportunityToolsAdapter,
        { provide: PrismaService, useValue: markers.prisma },
        { provide: FundingOpportunityV2SearchService, useValue: markers.opportunities },
        { provide: GovernmentLandscapeService, useValue: markers.landscape },
        { provide: OpportunityRequirementService, useValue: markers.requirements },
        { provide: FundingOpportunityV2DetailService, useValue: markers.opportunityDetails },
      ],
    }).compile();
    const adapter = module.get(MeriOpportunityToolsAdapter);
    expect(adapter).toBeInstanceOf(MeriOpportunityToolsAdapter);
    const injected = adapter as unknown as Record<keyof typeof markers, unknown>;
    for (const key of Object.keys(markers) as (keyof typeof markers)[]) {
      expect(injected[key]).toBe(markers[key]);
    }
    await module.close();
  });

  it('readSamSourceFreshness resolves through the real FundingOpportunityV2SearchService, not a stand-in', async () => {
    // `readSamSourceFreshness` (the legacy `search_sam_opportunities` tool's dependency)
    // had zero test coverage before this incident — it is not exercised by `makeAdapter()`
    // or `invokeAll()` above. Constructed through real Nest DI end to end so a future
    // regression in either the decorator or this specific method surfaces here.
    const health = {
      sources: [
        { source: 'sam_gov' as const, state: 'current' as const, recordCount: 5000, activeRecordCount: 4000, lastSyncedAt: '2026-09-23T00:00:00.000Z', latestAttemptAt: '2026-09-23T00:00:00.000Z', lastSuccessAt: '2026-09-23T00:00:00.000Z' },
        { source: 'grants_gov' as const, state: 'current' as const, recordCount: 100, activeRecordCount: 80, lastSyncedAt: '2026-09-23T00:00:00.000Z', latestAttemptAt: '2026-09-23T00:00:00.000Z', lastSuccessAt: '2026-09-23T00:00:00.000Z' },
      ],
      generatedAt: '2026-09-23T00:00:00.000Z',
    };
    const module = await Test.createTestingModule({
      providers: [
        MeriOpportunityToolsAdapter,
        { provide: PrismaService, useValue: {} },
        { provide: FundingOpportunityV2SearchService, useValue: { readSourceHealth: jest.fn(async () => health) } },
        { provide: GovernmentLandscapeService, useValue: {} },
        { provide: OpportunityRequirementService, useValue: {} },
        { provide: FundingOpportunityV2DetailService, useValue: {} },
      ],
    }).compile();
    const adapter = module.get(MeriOpportunityToolsAdapter);
    const result = await adapter.readSamSourceFreshness({ tenantId: TENANT, userId: USER });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: 'sam_gov', recordCount: 5000, neverSynced: false, lastRunDegraded: false });
    await module.close();
  });

  it('delegates paginated discovery to the workspace matching service without rescoring or hiding scan limits', async () => {
    const record = {
      id: 'sam_gov:abc-123', source: 'sam_gov', sourceRecordId: 'abc-123',
      title: 'UGV Autonomy R&D', agency: 'Department of Defense', sourceUrl: 'https://sam.gov/opp/abc-123',
      type: 'forecast', lifecycle: 'forecast', postedDate: '2026-08-01T00:00:00Z', deadline: null,
      closeOrArchiveDate: null, isPursuable: false, summary: 'Forecast notice.',
      naicsCodes: ['541330'], pscCodes: [], setAside: null, applicantTypes: ['Public and State controlled institutions of higher education'],
      geography: [], value: null, valueBasis: 'not_stated_by_source',
      sourceFacts: { sourceUpdated: '2026-08-01T00:00:00Z' }, relevanceScore: 92,
      matchedSignals: [{ signal: 'exact_naics_match', strength: 'strong', matchedOn: '541330' }],
      eligibility: { state: 'ineligible', reason: 'Notice requires an applicant type absent from the verified client profile.' },
      clientId: CLIENT,
    };
    const canonical = {
      criteria: { mode: 'matched', clientId: CLIENT, sources: ['sam_gov'], lifecycle: ['active'], page: 2, pageSize: 5 },
      opportunities: [record], total: 11, totalIsCapped: true, catalogComplete: false,
      page: 2, pageSize: 5, counts: { grants: 4, contracts: null, active: null, closed: null }, mode: 'matched', clientId: CLIENT,
      freshness: [{ source: 'sam_gov', state: 'degraded', recordCount: null, activeRecordCount: null, lastSyncedAt: '2026-08-01T00:00:00Z' }],
      profileGaps: { items: [MISSING_CERTIFICATIONS], unavailableReason: null }, emptyReason: null,
      provenance: [{ source: 'sam_gov', queried: true, returned: 1, count: 11, capped: true }],
      generatedAt: AS_OF.toISOString(),
    };
    const search = jest.fn(async () => canonical);
    const { adapter } = makeAdapter({ search });
    const result = await adapter.searchFundingOpportunities(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', query: 'power conversion', page: 2, pageSize: 5 },
      AS_OF,
    );
    expect(search).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER },
      expect.objectContaining({
        mode: 'matched', clientId: CLIENT, query: 'power conversion',
        sources: ['sam_gov'], lifecycle: ['active'], page: 2, pageSize: 5,
      }),
    );
    expect(result.state).toBe('available');
    expect(result.data).toMatchObject({
      total: 11,
      totalIsCapped: true,
      page: 2,
      nextPage: 3,
      hasMore: true,
      freshness: canonical.freshness,
      coverage: {
        pageCoversMatchedResults: false,
        procurementForecasts: { tool: 'search_procurement_forecasts' },
      },
    });
    const returned = result.data!.opportunities[0]!;
    expect(returned.relevanceScore).toBe(92);
    expect(returned.eligibility).toBe(record.eligibility);
    expect(returned.matchedSignals).toEqual(expect.arrayContaining([{ signal: 'exact_naics_match', strength: 'strong', matchedOn: '541330', weight: undefined }]));
    expect(returned.recommendation).toBeNull();
    expect(returned.eligibleApplicantTypes).toEqual(record.applicantTypes);
    expect(returned.status).toBe('forecast');
    expect(returned.evidence.disqualifiers).toEqual([
      { basis: 'canonical_eligibility', reason: record.eligibility.reason },
    ]);
    expect(returned.evidence.recommendationConfidence).toBeNull();
    expect(returned.evidence.recordRef).toBe(record.id);
  });

  it('reports an empty canonical result and profile gaps as unknown coverage, not no opportunities', async () => {
    const search = jest.fn(async () => ({
      opportunities: [],
      total: 0,
      totalIsCapped: false,
      page: 1,
      pageSize: 5,
      counts: { grants: null, contracts: null, active: null, closed: null },
      catalogComplete: false,
      mode: 'matched', clientId: CLIENT, profileGaps: { items: [MISSING_CERTIFICATIONS], unavailableReason: null },
      freshness: [{ source: 'grants_gov', state: 'never_synced', recordCount: null, activeRecordCount: null, lastSyncedAt: null }],
      emptyReason: 'source_never_synced',
      emptyExplanation: 'Nothing can be said about matches until the source sync runs.',
      generatedAt: AS_OF.toISOString(),
    }));
    const { adapter } = makeAdapter({ search });
    const result = await adapter.searchFundingOpportunities(STANDARD, { clientId: CLIENT }, AS_OF);
    expect(result.data).toMatchObject({
      nextPage: null,
      hasMore: false,
      emptyReason: 'source_never_synced',
      missingProfileFields: [MISSING_CERTIFICATIONS],
      freshness: [{ source: 'grants_gov', state: 'never_synced' }],
    });
    expect(result.data!.coverage.explanation).toContain(
      'no matching result does not prove no opportunity exists',
    );
  });

  it('does not turn a disabled source into complete coverage or a no-match claim', async () => {
    const { adapter } = makeAdapter({
      search: async () => ({
        criteria: {}, opportunities: [], total: null, totalIsCapped: false,
        page: 1, pageSize: 5, catalogComplete: false,
        counts: { grants: null, contracts: null, active: null, closed: null },
        mode: 'matched', clientId: CLIENT,
        freshness: [{ source: 'grants_gov', state: 'not_enabled', recordCount: null, activeRecordCount: null, lastSyncedAt: null }],
        provenance: [{ source: 'grants_gov', queried: false, returned: 0, count: null, capped: false }],
        emptyReason: null, profileGaps: null, generatedAt: AS_OF.toISOString(),
      }),
    });

    const result = await adapter.searchFundingOpportunities(STANDARD, { clientId: CLIENT, source: 'grants_gov' }, AS_OF);

    expect(result.state).toBe('available');
    expect(result.data).toMatchObject({
      opportunities: [], total: null, emptyReason: null, hasMore: false, nextPage: null,
      coverage: { sources: ['grants_gov'], pageCoversMatchedResults: false },
    });
    expect(result.data!.emptyExplanation).toContain('no source was searched');
    expect(result.data!.coverage.explanation).toContain('not evidence that no matching opportunities exist');
  });

  it('marks requested-source coverage partial when an enabled and disabled source are selected together', async () => {
    const { adapter } = makeAdapter({
      search: async () => ({
        criteria: {}, opportunities: [], total: 0, totalIsCapped: false,
        page: 1, pageSize: 5, catalogComplete: true,
        counts: { grants: 0, contracts: 0, active: 0, closed: 0 },
        mode: 'matched', clientId: CLIENT,
        freshness: [
          { source: 'grants_gov', state: 'current', recordCount: 0, activeRecordCount: 0, lastSyncedAt: AS_OF.toISOString() },
          { source: 'sam_gov', state: 'not_enabled', recordCount: null, activeRecordCount: null, lastSyncedAt: null },
        ],
        provenance: [
          { source: 'grants_gov', queried: true, returned: 0, count: 0, capped: false },
          { source: 'sam_gov', queried: false, returned: 0, count: null, capped: false },
        ],
        emptyReason: 'no_matches', profileGaps: null, generatedAt: AS_OF.toISOString(),
      }),
    });

    const result = await adapter.searchFundingOpportunities(STANDARD, { clientId: CLIENT }, AS_OF);

    expect(result.state).toBe('available');
    expect(result.data).toMatchObject({
      total: 0, coverage: { sources: ['grants_gov', 'sam_gov'], pageCoversMatchedResults: false },
    });
    expect(result.data!.emptyExplanation).toContain('disabled requested sources were not searched');
    expect(result.data!.coverage.explanation).toContain('only the enabled sources that were queried');
  });

  it.each([
    { page: 0 },
    { pageSize: 6 },
    { page: 1.5 },
    { activeState: 'open' },
    { query: 'x'.repeat(501) },
  ])('rejects invalid discovery input before calling matching: %j', async (invalid) => {
    const { adapter, calls } = makeAdapter();
    expect(
      (await adapter.searchFundingOpportunities(STANDARD, { clientId: CLIENT, ...invalid }, AS_OF))
        .state,
    ).toBe('invalid_request');
    expect(calls.list).toBe(0);
  });

  it('keeps agency procurement forecasts out of the canonical open opportunity vocabulary', async () => {
    const { adapter, calls } = makeAdapter();
    expect(
      (
        await adapter.searchFundingOpportunities(
          STANDARD,
          { clientId: CLIENT, source: 'agency_forecast' },
          AS_OF,
        )
      ).state,
    ).toBe('unsupported_source');
    expect(calls.list).toBe(0);
  });

  it('reads every held notice character across continuation pages with exact source and truncation information', async () => {
    const text = 'Eligibility and conditions. '.repeat(1000);
    const { adapter } = makeAdapter({
      getOpportunity: async () => opportunity({ source: 'grants_gov', summary: text }),
    });
    let collected = '',
      offset = 0;
    do {
      const result = await adapter.getFundingOpportunity(
        STANDARD,
        {
          clientId: CLIENT,
          source: 'grants_gov',
          sourceRecordId: 'GRANT-1',
          summaryOffset: offset,
          summaryLimit: 4000,
        },
        AS_OF,
      );
      expect(result.state).toBe('available');
      const facts = result.data!;
      expect(facts.summaryRead).toMatchObject({
        offset,
        totalCharacters: text.length,
        sourceUpdatedAt: '2026-08-06T00:00:00.000Z',
      });
      collected += facts.summary;
      if (facts.summaryRead.nextOffset == null) break;
      expect(facts.summaryRead.truncated).toBe(true);
      offset = facts.summaryRead.nextOffset;
    } while (offset < text.length);
    expect(collected).toBe(text);
  });

  it('requires the document flag before any mandatory-condition read', async () => {
    const { adapter, calls } = makeAdapter({ documentsEnabled: false });
    const result = await adapter.getFundingOpportunityRequirements(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID },
      AS_OF,
    );
    expect(result.state).toBe('disabled');
    expect(calls.getOpportunity).toBe(0);
    expect(calls.requirements).toBe(0);
  });

  it('preserves canonical requirement citations, pending reviews, supersession and continuation', async () => {
    const evidence = {
      requirements: [
        {
          id: 'req-1',
          attachmentId: 'doc-1',
          sourcePage: 7,
          excerptStart: 500,
          excerptEnd: 523,
          sourceExcerpt: 'Offerors must register.',
          statement: 'Register before bidding',
          confidence: 'high',
          reviewStatus: 'pending',
          supersededAt: '2026-08-05T00:00:00Z',
        },
      ],
      coverage: 'available',
      generatedAt: AS_OF.toISOString(),
      documentTextStatus: [],
      pagination: { offset: 20, limit: 10, total: 42, hasMore: true, nextOffset: 30 },
    };
    const getRequirements = jest.fn(async () => evidence);
    const { adapter } = makeAdapter({ getRequirements });
    const result = await adapter.getFundingOpportunityRequirements(
      STANDARD,
      { clientId: CLIENT, source: 'sam_gov', sourceRecordId: SAM_ID, offset: 20, limit: 10 },
      AS_OF,
    );
    expect(getRequirements).toHaveBeenCalledWith(TENANT, 'sam_gov', SAM_ID, AS_OF, {
      offset: 20,
      limit: 10,
    });
    expect(result.data).toBe(evidence);
    expect(result.explanation).toContain('not verified mandatory conditions');
  });

  it('does not turn unassessed eligibility or absent source fields into disqualifiers', () => {
    const facts = toFacts(
      opportunity({
        source: 'grants_gov',
        eligibility: { state: 'unknown', reason: 'Applicant types unrecorded.' },
        sourceUrl: null,
        sourceUpdatedAt: null,
        placeOfPerformance: null,
        responseDeadline: null,
        summary: null,
      }),
    );
    expect(facts.evidence.disqualifiers).toEqual([]);
    expect(facts.evidence.missingFields).toEqual(
      expect.arrayContaining([
        'sourceUrl',
        'sourceUpdatedAt',
        'placeOfPerformance',
        'responseDeadline',
        'eligibleApplicantTypes',
        'noticeText',
      ]),
    );
    expect(facts.summaryRead.state).toBe('missing');
  });
});

describe('P37 — vocabulary', () => {
  it('the tool list is the canonical funding tools, with no duplicates', () => {
    expect([...MERI_OPPORTUNITY_TOOLS]).toEqual([
      'search_funding_opportunities',
      'get_funding_opportunity_requirements',
      'get_funding_opportunity',
      'explain_opportunity_match',
      'get_opportunity_client_context',
      'get_opportunity_government_landscape',
      'compare_funding_opportunities',
      'build_opportunity_action_plan',
    ]);
    expect(new Set(MERI_OPPORTUNITY_TOOLS).size).toBe(MERI_OPPORTUNITY_TOOLS.length);
  });

  it('the flag is its own, and off by default everywhere', () => {
    expect(FUNDING_OPPORTUNITIES_MERI_V2_FEATURE).toBe('funding_opportunities_meri_v2');
  });

  it('asOpportunitySource admits only the two real sources', () => {
    expect(asOpportunitySource('sam_gov')).toBe('sam_gov');
    expect(asOpportunitySource('grants_gov')).toBe('grants_gov');
    for (const value of ['agency_forecast', 'dibbs', 'sbir_sttr', '', null, 42, undefined]) {
      expect(asOpportunitySource(value)).toBeNull();
    }
  });

  it('toBrief carries the workflow status without inventing one', () => {
    expect(toBrief(opportunity()).workflowStatus).toBeNull();
    expect(
      toBrief(opportunity({ workflow: { status: 'pursuing' } as FundingOpportunity['workflow'] }))
        .workflowStatus,
    ).toBe('pursuing');
  });
});
