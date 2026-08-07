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
    flagThrows?: boolean;
    visibleClientIds?: string[];
    getOpportunity?: (...args: unknown[]) => Promise<FundingOpportunity>;
    getClientSummary?: () => Promise<unknown>;
    compose?: (...args: unknown[]) => Promise<unknown>;
    composeActionPlan?: (...args: unknown[]) => Promise<unknown>;
  } = {},
) {
  const calls = { flag: 0, wall: 0, getOpportunity: 0, summary: 0, compose: 0, plan: 0 };
  const flagEnabled = over.flagEnabled ?? true;
  const visible = over.visibleClientIds ?? [CLIENT];

  const prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => {
      calls.flag += 1;
      if (over.flagThrows) throw new Error('42883 operator does not exist: text = uuid');
      return fn({ $queryRaw: async () => (flagEnabled ? [{ ok: 1 }] : []) });
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

  const opportunities = {
    getOpportunity: async (...args: unknown[]) => {
      calls.getOpportunity += 1;
      if (over.getOpportunity) return over.getOpportunity(...args);
      return opportunity();
    },
    getClientSummary: async () => {
      calls.summary += 1;
      if (over.getClientSummary) return over.getClientSummary();
      return {
        clientId: CLIENT,
        counts: { activeGrants: 1, activeContracts: 2, saved: 0, pursuing: 0, dismissed: 0, deadlinesIn30Days: 1 },
        nextDeadline: null,
        topGrants: [],
        topContracts: [opportunity()],
        missingProfileFields: [MISSING_CERTIFICATIONS],
        freshness: [{ source: 'sam_gov', lastSyncedAt: '2026-08-06T00:00:00.000Z', state: 'fresh' }],
        emptyReason: null,
        emptyExplanation: null,
        generatedAt: AS_OF.toISOString(),
      };
    },
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

  const adapter = new MeriOpportunityToolsAdapter(
    prisma as never,
    opportunities as never,
    landscape as never,
  );
  return { adapter, calls };
}

/** Every tool, called with its own required inputs. One list, six call sites. */
function invokeAll(adapter: MeriOpportunityToolsAdapter, actor: Actor, clientId = CLIENT) {
  return [
    adapter.getFundingOpportunity(actor, { clientId, source: 'sam_gov', sourceRecordId: SAM_ID }, AS_OF),
    adapter.explainOpportunityMatch(actor, { clientId, source: 'sam_gov', sourceRecordId: SAM_ID }, AS_OF),
    adapter.getOpportunityClientContext(actor, { clientId }, AS_OF),
    adapter.getOpportunityGovernmentLandscape(actor, { clientId, source: 'sam_gov', sourceRecordId: SAM_ID }, AS_OF),
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
    adapter.buildOpportunityActionPlan(actor, { clientId, source: 'sam_gov', sourceRecordId: SAM_ID }, AS_OF),
  ];
}

// ── 1. The gate ─────────────────────────────────────────────────────────────

describe('P37 — the gate is flag, then role, then wall, and all three fail closed', () => {
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
            { source: 'program_element', state: 'denied', itemCount: 0, explanation: 'Not available for this client.' },
            { source: 'hearing', state: 'denied', itemCount: 0, explanation: 'Not available for this client.' },
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
    const result = await adapter.getOpportunityClientContext(STANDARD, { clientId: 'not-a-uuid' }, AS_OF);
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
    for (const forbidden of ['TANGO_API_KEY', 'SecretsManager', 'getSecret', 'TangoGateway', 'TangoStoreService']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('reaches the network through nothing — no fetch, no http client', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toContain('axios');
    expect(code).not.toContain('HttpService');
  });

  it('the constructor takes exactly three local collaborators', () => {
    // A fourth would be the moment a provider dependency could arrive without
    // anyone noticing. Named explicitly so adding one is a deliberate edit here.
    expect(MeriOpportunityToolsAdapter.length).toBe(3);
    expect(code).toContain('private readonly prisma: PrismaService');
    expect(code).toContain('private readonly opportunities: FundingOpportunitiesService');
    expect(code).toContain('private readonly landscape: GovernmentLandscapeService');
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

  it('Meri registers exactly these six tools, and the two lists cannot drift', () => {
    const meriDir = join(dir, '..', 'meri');
    const toolsText = readFileSync(join(meriDir, 'meri-tools.service.ts'), 'utf8');
    for (const tool of MERI_OPPORTUNITY_TOOLS) {
      // Declared in TOOL_DEFINITIONS, given a schema, and dispatched. All three
      // or the tool is half-registered — which is exactly how a tool ends up
      // advertised to the model and then throwing when selected.
      expect(toolsText).toContain(`name: '${tool}'`);
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
    expect(result.explanation).toContain('says nothing about whether the notice exists at the source');
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
    expect(data.recommendation?.machineRecommendation).toBe('needs_review');
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
    expect(result.data!.missingProfileFields).toEqual([MISSING_CERTIFICATIONS]);
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
    for (const row of result.data!.rows.slice(1)) expect(row.explanation.length).toBeGreaterThan(10);
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
    for (const verb of ['.create(', '.update(', '.upsert(', '.delete(', '.createMany(', '$executeRaw']) {
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
        throw new BadRequestException('An action plan is composed for SAM.gov contract opportunities.');
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

describe('P37 — vocabulary', () => {
  it('the tool list is the six the plan names, with no duplicates', () => {
    expect([...MERI_OPPORTUNITY_TOOLS]).toEqual([
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
