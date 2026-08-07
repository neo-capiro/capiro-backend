import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUDGET_BETA_LABEL,
  BUDGET_CONTEXT_STATES,
  FUNDING_OPPORTUNITIES_BUDGET_CONTEXT_FEATURE,
  OpportunityBudgetContextService,
  decimal,
} from './opportunity-budget-context.service.js';
import {
  BUDGET_ACCOUNT_FIELDS,
  mapBudgetAccount,
  mapBudgetVendorFlow,
  toBudgetAccountRow,
} from '../external/tango/tango-budget.mapper.js';

/**
 * Tango budget beta context (P44).
 *
 * Five properties carry the phase:
 *   1. Nothing here can reach Capiro's own budget data. Structural, not
 *      promised.
 *   2. Null money stays null. An unattributed account is not an empty one.
 *   3. Nothing is summed across unlike scope — two fiscal years are two
 *      appropriations, and one number over them means nothing.
 *   4. "No account is linked to this notice" is on EVERY response, including
 *      the empty ones.
 *   5. Not-synced, no-identity and no-flows are three different facts with
 *      three different sentences.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const UEI = 'ABC123DEF456';
const AS_OF = new Date('2026-09-01T12:00:00.000Z');

const STANDARD = { tenantId: TENANT, userId: USER, role: 'standard_user' as const };
const PORTAL = { tenantId: TENANT, userId: USER, role: 'client_portal_user' as const };

/** A Decimal stand-in: the service only ever calls toString on these. */
function dec(v: string | null) {
  return v == null ? null : { toString: () => v };
}

function accountRow(over: Record<string, unknown> = {}) {
  return {
    federalAccountSymbol: '097-0400',
    fiscalYear: 2026,
    accountTitle: 'Operation and Maintenance, Defense-Wide',
    agencyName: 'Department of Defense',
    bureauName: 'Defense-Wide',
    requestedBa: null,
    enactedBa: null,
    apportioned: null,
    obligatedTotal: null,
    outlayedTotal: null,
    unobligatedBalance: null,
    contractObligated: dec('123456789.12'),
    attributionStatus: 'partial',
    attributionConfidence: 'medium',
    lastSyncedAt: new Date('2026-08-30T00:00:00.000Z'),
    ...over,
  };
}

function flowRow(over: Record<string, unknown> = {}) {
  return {
    id: 'flow-1',
    recipientUei: UEI,
    contractObligated: dec('1250000.00'),
    contractOutlayed: null,
    contractCount: 3,
    fundingOfficeName: 'NAVSEA Philadelphia',
    fundingAgencyName: 'Department of the Navy',
    budgetAccount: accountRow(),
    ...over,
  };
}

function makeService(
  over: {
    flagEnabled?: boolean;
    flagThrows?: boolean;
    visibleClientIds?: string[];
    clientUei?: string | null;
    flows?: unknown[];
    accountCount?: number;
  } = {},
) {
  const calls = { flows: 0, accountCount: 0 };
  const flagEnabled = over.flagEnabled ?? true;
  const visible = over.visibleClientIds ?? [CLIENT];
  const clientUei = over.clientUei === undefined ? UEI : over.clientUei;

  const prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => {
      if (over.flagThrows) throw new Error('42883 operator does not exist: text = uuid');
      return fn({
        $queryRaw: async () => (flagEnabled ? [{ ok: 1 }] : []),
        tangoBudgetVendorFlow: {
          findMany: async () => {
            calls.flows += 1;
            return over.flows ?? [flowRow()];
          },
        },
        tangoBudgetAccount: {
          count: async () => {
            calls.accountCount += 1;
            return over.accountCount ?? 0;
          },
        },
      });
    },
    withTenant: async (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        client: {
          findMany: async () => visible.map((id) => ({ id, memoryWall: false })),
          findFirst: async () => ({ uei: clientUei }),
        },
        clientMemoryAccess: { findMany: async () => [] },
      }),
  };

  return { service: new OpportunityBudgetContextService(prisma as never), calls };
}

// ── 1. It cannot reach Capiro's own budget data ─────────────────────────────

describe('P44 — beta context cannot touch Capiro’s budget data', () => {
  const files = [
    join(__dirname, 'opportunity-budget-context.service.ts'),
    join(__dirname, '..', 'external', 'tango', 'tango-budget.mapper.ts'),
  ];
  const sources = files.map((f) =>
    readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  );

  it('imports no canonical Program Element or defense-budget writer', () => {
    for (const code of sources) {
      for (const forbidden of [
        'program-element',
        'ProgramElement',
        'defense-budget',
        'DefenseBudget',
        'peBudget',
        'budgetLineItem',
      ]) {
        expect(code).not.toContain(forbidden);
      }
    }
  });

  it('holds no write verb at all — it is a read service and a pure mapper', () => {
    for (const code of sources) {
      for (const verb of [
        '.create(',
        '.update(',
        '.upsert(',
        '.delete(',
        '.createMany(',
        '.updateMany(',
        '$executeRaw',
      ]) {
        expect(code).not.toContain(verb);
      }
    }
  });

  it('the service takes exactly one collaborator, and it is Prisma', () => {
    // A second dependency is the moment a PE writer could arrive unnoticed.
    expect(OpportunityBudgetContextService.length).toBe(1);
    expect(sources[0]).toContain('private readonly prisma: PrismaService');
  });

  it('reads only the two provider-owned tables', () => {
    const models = [...sources[0]!.matchAll(/tx\.([a-zA-Z]+)\./g)].map((m) => m[1]);
    expect([...new Set(models)].sort()).toEqual([
      'client',
      'tangoBudgetAccount',
      'tangoBudgetVendorFlow',
    ]);
  });
});

// ── 2. Null money stays null ────────────────────────────────────────────────

describe('P44 — null money is null, never zero', () => {
  it('the mapper keeps every unstated figure null', () => {
    // The exact live-observed shape: contract_obligated populated, every other
    // money field null, agency_code null beside a populated agency_name.
    const record = mapBudgetAccount(
      {
        id: 18513,
        federal_account_symbol: '097-0400',
        fiscal_year: 2026,
        account_title: 'Operation and Maintenance, Defense-Wide',
        agency_code: null,
        agency_name: 'Department of Defense',
        contract_obligated: 123456789.12,
        enacted_ba: null,
        requested_ba: null,
        apportioned: null,
        obligated_total: null,
        outlayed_total: null,
        unobligated_balance: null,
        attribution_status: 'partial',
        attribution_confidence: 'medium',
      },
      AS_OF.toISOString(),
    )!;

    expect(record.money.contractObligated).toBe(123456789.12);
    for (const key of [
      'enactedBa',
      'requestedBa',
      'apportioned',
      'obligatedTotal',
      'outlayedTotal',
      'unobligatedBalance',
    ] as const) {
      expect(record.money[key]).toBeNull();
    }
    expect(record.agencyCode).toBeNull();
    expect(record.agencyName).toBe('Department of Defense');
  });

  it('the service renders a Decimal as its exact string, never a float', () => {
    // NUMERIC(20,2) exceeds what a JS float holds exactly. A nine-figure
    // obligation that comes back a cent short is a number nobody can reconcile.
    expect(decimal(dec('123456789012345.67'))).toBe('123456789012345.67');
    expect(decimal(null)).toBeNull();
    expect(decimal(undefined)).toBeNull();
  });

  it('the provider’s own attribution confidence travels with the number', () => {
    const record = mapBudgetAccount(
      {
        id: 1,
        federal_account_symbol: 'X',
        fiscal_year: 2026,
        account_title: 'T',
        attribution_status: 'estimated',
        attribution_confidence: 'low',
      },
      AS_OF.toISOString(),
    )!;
    expect(record.attributionStatus).toBe('estimated');
    expect(record.attributionConfidence).toBe('low');
  });
});

// ── 3. Mapper identity and allow-listing ────────────────────────────────────

describe('P44 — the mapper drops what it cannot identify and admits nothing extra', () => {
  const base = {
    id: 1,
    federal_account_symbol: '097-0400',
    fiscal_year: 2026,
    account_title: 'T',
  };

  it.each([
    ['no provider row id', { ...base, id: null }],
    ['no account symbol', { ...base, federal_account_symbol: '   ' }],
    ['no fiscal year', { ...base, fiscal_year: null }],
    ['no account title', { ...base, account_title: '' }],
  ])('%s is dropped rather than written with a placeholder', (_name, raw) => {
    expect(mapBudgetAccount(raw, AS_OF.toISOString())).toBeNull();
  });

  it('a field the provider newly added cannot enter the normalized object', () => {
    const record = mapBudgetAccount(
      { ...base, a_field_capiro_never_asked_for: 'surprise' },
      AS_OF.toISOString(),
    )!;
    expect(JSON.stringify(record)).not.toContain('surprise');
  });

  it('the allow-list is the live-observed field set', () => {
    expect(BUDGET_ACCOUNT_FIELDS).toContain('federal_account_symbol');
    expect(BUDGET_ACCOUNT_FIELDS).toContain('attribution_confidence');
    // Derived percentage fields the live row also carries are deliberately NOT
    // stored: a capped ratio is the provider's own presentation choice, and
    // recomputing it locally from figures that may be null is a different
    // number wearing the same name.
    expect(BUDGET_ACCOUNT_FIELDS).not.toContain('obligated_to_enacted_pct_capped');
  });

  it('a vendor flow is kept ONLY for a UEI Capiro already knows', () => {
    const raw = {
      funding_organization_id: 'org-1',
      contract_obligated: 1250000,
      n_contracts: 3,
      funding_office: { office_name: 'NAVSEA', agency_name: 'Navy' },
      recipient: { uei: UEI, legal_business_name: 'Known Co', dba_name: 'Trading Name' },
    };
    expect(mapBudgetVendorFlow(raw, new Set([UEI]))?.recipientUei).toBe(UEI);
    // Everyone else on the account is read, checked and discarded.
    expect(mapBudgetVendorFlow(raw, new Set(['OTHERUEI1234']))).toBeNull();
    expect(mapBudgetVendorFlow(raw, new Set())).toBeNull();
  });

  it('the LEGAL name is stored, not the DBA', () => {
    // A DBA is a trading name; a row a reader cannot reconcile to a client
    // record is a row they have to go and check by hand.
    const flow = mapBudgetVendorFlow(
      { recipient: { uei: UEI, legal_business_name: 'Known Co', dba_name: 'Trading Name' } },
      new Set([UEI]),
    )!;
    expect(flow.recipientName).toBe('Known Co');
  });

  it('a malformed UEI is refused even when the set would admit it', () => {
    for (const uei of ['TOOSHORT', 'WAY-TOO-LONG-UEI', '', null]) {
      expect(
        mapBudgetVendorFlow({ recipient: { uei } }, new Set([String(uei)])),
      ).toBeNull();
    }
  });

  it('toBudgetAccountRow carries the snapshot and invents no source url', () => {
    const record = mapBudgetAccount(base, AS_OF.toISOString())!;
    const row = toBudgetAccountRow(record);
    expect(row.tangoAccountRowId).toBe(1);
    expect(row.snapshot).toBeDefined();
    // The live resource states none, and a fabricated deep link is worse than
    // no link — the reader clicks it and lands nowhere.
    expect(row.sourceUrl).toBeNull();
  });
});

// ── 4. Grouping, and the linkage disclaimer ─────────────────────────────────

describe('P44 — nothing is summed across unlike scope', () => {
  it('accounts are grouped BY fiscal year, newest first, with no cross-year total', async () => {
    const { service } = makeService({
      flows: [
        flowRow({ id: 'f1', budgetAccount: accountRow({ fiscalYear: 2025 }) }),
        flowRow({ id: 'f2', budgetAccount: accountRow({ fiscalYear: 2026 }) }),
        flowRow({
          id: 'f3',
          budgetAccount: accountRow({ fiscalYear: 2026, federalAccountSymbol: '097-0100' }),
        }),
      ],
    });
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);

    expect(result.state).toBe('available');
    expect(result.fiscalYears.map((y) => y.fiscalYear)).toEqual([2026, 2025]);
    expect(result.fiscalYears[0]!.accounts).toHaveLength(2);
    expect(result.fiscalYears[1]!.accounts).toHaveLength(1);

    // No field anywhere spans two fiscal years or two accounts.
    const keys = Object.keys(result);
    expect(keys).not.toContain('total');
    expect(keys).not.toContain('totalObligated');
    expect(JSON.stringify(result)).not.toContain('grandTotal');
  });

  it('every account carries its OWN fiscal year, so a figure cannot be read out of year', async () => {
    const { service } = makeService();
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);
    for (const year of result.fiscalYears) {
      for (const account of year.accounts) {
        expect(account.fiscalYear).toBe(year.fiscalYear);
      }
    }
  });

  it('the grain is stated on every response, including the empty ones', async () => {
    const populated = await makeService().service.getContext(STANDARD, CLIENT, AS_OF);
    const empty = await makeService({ flagEnabled: false }).service.getContext(
      STANDARD,
      CLIENT,
      AS_OF,
    );
    for (const result of [populated, empty]) {
      expect(result.grain).toContain('Federal account × fiscal year');
      expect(result.grain).toContain('not Program Element line-item funding');
      expect(result.source).toBe(BUDGET_BETA_LABEL);
    }
  });

  it('"no account is linked to this notice" is on EVERY response', async () => {
    // A reader who only sees the disclaimer when data is missing will read its
    // absence as a link existing.
    for (const over of [
      {},
      { flagEnabled: false },
      { visibleClientIds: [] },
      { clientUei: null },
      { flows: [] as unknown[] },
    ]) {
      const result = await makeService(over).service.getContext(STANDARD, CLIENT, AS_OF);
      expect(result.noticeLinkage.linked).toBe(false);
      expect(result.noticeLinkage.explanation).toContain('No federal account is linked');
      expect(result.noticeLinkage.explanation).toContain('matching on agency name would be a guess');
    }
  });
});

// ── 5. Honest empty states ──────────────────────────────────────────────────

describe('P44 — not-synced, no-identity and no-flows are three different facts', () => {
  it('an unsynced catalog says Capiro has not looked', async () => {
    const { service } = makeService({ flows: [], accountCount: 0 });
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);
    expect(result.state).toBe('not_synced');
    expect(result.explanation).toContain('has not synchronized');
    expect(result.explanation).toContain('gap in Capiro’s coverage');
  });

  it('a populated catalog with no match for this client says exactly that', async () => {
    const { service } = makeService({ flows: [], accountCount: 5000 });
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);
    expect(result.state).toBe('no_flows');
    expect(result.explanation).toContain('not proof the client received nothing');
  });

  it('a client with no UEI is a missing KEY, not a missing finding', async () => {
    const { service, calls } = makeService({ clientUei: null });
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);
    expect(result.state).toBe('no_client_identity');
    expect(result.explanation).toContain('no recorded UEI');
    expect(result.explanation).toContain('Nothing here says the client received no federal funding');
    // And no query was issued for a key that does not exist.
    expect(calls.flows).toBe(0);
  });

  it('the flag off is a stated capability gap, not an empty panel', async () => {
    const { service, calls } = makeService({ flagEnabled: false });
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);
    expect(result.state).toBe('disabled');
    expect(result.explanation).toContain('says nothing about the client’s federal funding');
    expect(calls.flows).toBe(0);
  });

  it('a throwing flag read fails closed', async () => {
    const { service } = makeService({ flagThrows: true });
    expect((await service.getContext(STANDARD, CLIENT, AS_OF)).state).toBe('disabled');
  });

  it('a portal user is denied before any client read', async () => {
    const { service, calls } = makeService();
    const result = await service.getContext(PORTAL, CLIENT, AS_OF);
    expect(result.state).toBe('denied');
    expect(calls.flows).toBe(0);
  });

  it('a walled client is denied with the same sentence a missing one gets', async () => {
    const { service } = makeService({ visibleClientIds: [] });
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);
    expect(result.state).toBe('denied');
    expect(result.explanation).toBe('Not available for this client.');
  });

  it('staleness is visible — every account reports when it was last synced', async () => {
    const { service } = makeService();
    const result = await service.getContext(STANDARD, CLIENT, AS_OF);
    expect(result.fiscalYears[0]!.accounts[0]!.lastSyncedAt).toBe('2026-08-30T00:00:00.000Z');
    expect(result.asOf).toBe(AS_OF.toISOString());
  });

  it('the state vocabulary is the six real outcomes', () => {
    expect([...BUDGET_CONTEXT_STATES]).toEqual([
      'available',
      'disabled',
      'denied',
      'not_synced',
      'no_client_identity',
      'no_flows',
    ]);
    expect(FUNDING_OPPORTUNITIES_BUDGET_CONTEXT_FEATURE).toBe(
      'funding_opportunities_budget_context',
    );
  });
});

// ── Identity discipline ─────────────────────────────────────────────────────

describe('P44 — the UEI is the only key, and a fallback is not admitted', () => {
  it('only the client’s OWN uei is used — never a reviewed name fallback', () => {
    const raw = readFileSync(join(__dirname, 'opportunity-budget-context.service.ts'), 'utf8');
    // Comments stripped: the service's own docblock NAMES the fallback in order
    // to say it is not used, and a doc explaining a rule must not fail the test
    // that pins it.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A budget flow says money reached a legal entity. Attributing a parent's
    // or an affiliate's obligation to this client is a financial claim about
    // the wrong company, so the reviewed-name fallback P02 admits for award
    // history is explicitly not usable here.
    expect(code).not.toContain('reviewed_name_fallback');
    expect(code).not.toContain('clientIntelMapping');
    expect(code).toContain('select: { uei: true }');
    // …and the docblock does explain the exclusion, rather than leaving a
    // future reader to wonder why the mappings are not consulted.
    expect(raw).toContain('reviewed_name_fallback');
  });
});
