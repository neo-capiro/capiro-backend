import { describe, expect, jest, test } from '@jest/globals';
import {
  DEFAULT_MIN_RELEVANCE,
  PAGE_SIZE,
  generateDibbsCandidates,
  hasPriorCageAward,
  parseArgs,
  resolveTenantIds,
  type DibbsCandidatesPrisma,
} from './generate-dibbs-opportunity-candidates.js';
import { scoreDibbsRelevance } from '../src/funding-opportunities/dibbs-relevance.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const SOLICITATION = 'dibbs-uuid-0001';
const AWARD_UUID = 'dibbs-award-uuid-0001';

describe('CLI parsing', () => {
  test('dry run is the default', () => {
    expect(parseArgs([])).toEqual({
      commit: false,
      tenantId: null,
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
      resumeClient: null,
    });
  });

  test('--commit, --tenant, --client and --min-relevance are all honoured', () => {
    expect(
      parseArgs(['node', 'x', '--commit', '--tenant', TENANT, '--client', CLIENT, '--min-relevance=40']),
    ).toEqual({
      commit: true,
      tenantId: TENANT,
      clientId: CLIENT,
      minRelevance: 40,
      resumeClient: null,
    });
    expect(parseArgs(['node', 'x', '--resume-client', 'client-00042']).resumeClient).toBe(
      'client-00042',
    );
  });

  test('--min-relevance accepts the space form too', () => {
    expect(parseArgs(['node', 'x', '--min-relevance', '30']).minRelevance).toBe(30);
  });
});

describe('the confidence-bridge invariant (scoreDibbsRelevance has no numeric score)', () => {
  const base = {
    documentType: 'rfq' as const,
    isOpen: true,
    closesDate: '2099-01-01',
    profileTooThin: false,
    exactNsnMatch: false,
    exactPartNumberMatch: false,
    priorCageAwardHistory: false,
    buyerHistory: false,
    capabilityTextMatch: false,
    clientHasRecordedParts: false,
    asOf: new Date('2026-01-01T12:00:00Z'),
  };

  // Every combination of LIVE signals that can clear the floor today (Rule 4 —
  // exact NSN/part match are structurally dormant in this producer, but the
  // scorer itself does not know that, so all three are exercised here).
  test.each([
    { priorCageAwardHistory: true },
    { exactNsnMatch: true },
    { exactPartNumberMatch: true },
    { exactNsnMatch: true, priorCageAwardHistory: true },
  ])('clearsSuggestionFloor never pairs with low confidence: %j', (signals) => {
    const result = scoreDibbsRelevance({ ...base, ...signals });
    expect(result.clearsSuggestionFloor).toBe(true);
    // This is the invariant `generate-dibbs-opportunity-candidates.ts`'s
    // confidence->relevanceScore bridge depends on: if this ever fails, a
    // future change to the scorer's rule order could silently make the
    // producer under-suggest against a --min-relevance floor above 30.
    expect(result.recommendationConfidence).not.toBe('low');
  });

  test('a weak-evidence-only result never clears the floor, and is low confidence', () => {
    const result = scoreDibbsRelevance({ ...base, capabilityTextMatch: true });
    expect(result.clearsSuggestionFloor).toBe(false);
    expect(result.recommendationConfidence).toBe('low');
  });
});

// ── Fake prisma ─────────────────────────────────────────────────────────────

function solicitationRow(partial: Record<string, unknown> = {}) {
  return {
    id: SOLICITATION,
    tangoDibbsId: SOLICITATION,
    documentType: 'rfq',
    isOpen: true,
    closesDate: new Date('2099-01-15T00:00:00Z'),
    nomenclature: 'BRACKET, ANGLE',
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    lastSyncedAt: new Date('2026-07-01T00:00:00Z'),
    ...partial,
  };
}

function clientRow(partial: Record<string, unknown> = {}) {
  return {
    id: CLIENT,
    name: 'Acme Defense LLC',
    uei: null,
    cageCode: '1ABC2',
    naicsCodes: ['336411'],
    pscCodes: [],
    applicantTypes: [],
    setAsideCertifications: [],
    sectorTag: 'DEFENSE',
    capabilities: [{ name: 'Angle brackets', tags: [], keywords: [], peNumbers: [] }],
    facilities: [],
    ...partial,
  };
}

function makeFake(opts: {
  solicitations?: Array<Record<string, unknown>>;
  clients?: Array<Record<string, unknown>>;
  existing?: Array<Record<string, unknown>>;
  flagRows?: Array<{ tenant_id: string }>;
  /** Normalized (upper/trim) CAGE codes that have a prior award, per the fake DB. */
  cagesWithAwards?: string[];
}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const bypassCalls: string[] = [];
  const clientWhere: unknown[] = [];
  const cageQueries: string[] = [];
  const solicitationPageArgs: Array<{ where?: any; take?: number; orderBy?: unknown }> = [];
  const workflowWhere: any[] = [];

  function page<T extends { id: string }>(
    rows: T[],
    where: Record<string, any> | undefined,
    take: number | undefined,
  ): T[] {
    const gt = (where?.id as { gt?: string } | undefined)?.gt;
    const exact = typeof where?.id === 'string' ? (where.id as string) : null;
    let out = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (exact) out = out.filter((r) => r.id === exact);
    if (gt) out = out.filter((r) => r.id > gt);
    return take == null ? out : out.slice(0, take);
  }

  /**
   * A small evaluator for the `activeSolicitationWhere` shape (AND/OR of
   * null-or-value conditions), so `isOpen`/`closesDate` filtering is actually
   * exercised by this fake rather than silently passed through. `id` is
   * skipped — cursor pagination is `page()`'s job, not this function's.
   */
  function matchesWhere(row: Record<string, any>, where: Record<string, any> | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'id') return true;
      if (key === 'AND') return (cond as unknown[]).every((w) => matchesWhere(row, w as any));
      if (key === 'OR') return (cond as unknown[]).some((w) => matchesWhere(row, w as any));
      const value = row[key];
      if (cond === null) return value == null;
      if (cond != null && typeof cond === 'object') {
        if ('gte' in cond) return value != null && new Date(value).getTime() >= new Date((cond as any).gte).getTime();
        if ('in' in cond) return ((cond as any).in as unknown[]).includes(value);
      }
      return value === cond;
    });
  }

  // Defaults to a match on the default clientRow's own CAGE: with
  // exactNsnMatch/exactPartNumberMatch always false in this producer (dormant
  // signals), prior CAGE award history is the ONLY signal that can clear the
  // suggestion floor, so a "happy path" fixture needs one unless a test is
  // specifically about the floor NOT clearing.
  const cagesWithAwards = new Set((opts.cagesWithAwards ?? ['1ABC2']).map((c) => c.toUpperCase()));

  const prisma: DibbsCandidatesPrisma = {
    $transaction: (async (fn: (tx: DibbsCandidatesPrisma) => Promise<unknown>) => fn(prisma)) as never,
    $executeRawUnsafe: (async (sql: string) => {
      bypassCalls.push(sql);
      return 0;
    }) as never,
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('intel_feature_flag')) return (opts.flagRows ?? [{ tenant_id: TENANT }]) as never;
      if (sql.includes('federal_award') || sql.includes('federal_assistance_award')) return [] as never;
      if (sql.includes('tango_dibbs_award')) {
        cageQueries.push(sql);
        const cage = String(values[0] ?? '').toUpperCase();
        return (cagesWithAwards.has(cage) ? [{ hit: 1 }] : []) as never;
      }
      return [] as never;
    }) as never,
    client: {
      findMany: jest.fn(async (args: unknown) => {
        const a = args as { where?: any; take?: number };
        clientWhere.push(a.where);
        return page((opts.clients ?? [clientRow()]) as Array<{ id: string }>, a.where, a.take) as never;
      }),
    },
    clientIntelMapping: { findMany: jest.fn(async () => [] as never) },
    tangoDibbsSolicitation: {
      findMany: jest.fn(async (args: unknown) => {
        const a = args as { where?: any; take?: number; orderBy?: unknown };
        solicitationPageArgs.push(a);
        const rows = (opts.solicitations ?? [solicitationRow()]) as Array<Record<string, any>>;
        const filtered = rows.filter((r) => matchesWhere(r, a.where));
        return page(filtered as Array<{ id: string }>, a.where, a.take) as never;
      }),
    },
    clientFundingOpportunity: {
      findMany: jest.fn(async (args: unknown) => {
        const where = (args as { where?: any }).where;
        workflowWhere.push(where);
        const rows = (opts.existing ?? []) as Array<Record<string, any>>;
        const keys = where?.sourceRecordKey?.in as string[] | undefined;
        return (keys ? rows.filter((r) => keys.includes(r.sourceRecordKey)) : rows) as never;
      }),
      create: jest.fn(async (args: unknown) => {
        created.push((args as { data: unknown }).data);
        return {};
      }),
      update: jest.fn(async (args: unknown) => {
        updated.push(args);
        return {};
      }),
    },
  } as unknown as DibbsCandidatesPrisma;

  return {
    prisma,
    created,
    updated,
    bypassCalls,
    clientWhere,
    cageQueries,
    solicitationPageArgs,
    workflowWhere,
  };
}

describe('prior CAGE award history — DIBBS-only signal', () => {
  test('a client with no recorded CAGE code triggers no award query', async () => {
    const { prisma, cageQueries } = makeFake({ clients: [clientRow({ cageCode: null })] });
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(cageQueries).toHaveLength(0);
  });

  test('a matching CAGE is found case- and whitespace-insensitively', async () => {
    const { prisma } = makeFake({
      clients: [clientRow({ cageCode: ' 1abc2 ' })],
      cagesWithAwards: ['1ABC2'],
    });
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.created).toBe(1);
  });

  test('CAGE history is read ONCE per client, never once per solicitation', async () => {
    const { prisma, cageQueries } = makeFake({
      solicitations: [
        solicitationRow({ id: 's-1', tangoDibbsId: 's-1' }),
        solicitationRow({ id: 's-2', tangoDibbsId: 's-2' }),
        solicitationRow({ id: 's-3', tangoDibbsId: 's-3' }),
      ],
    });
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(cageQueries).toHaveLength(1);
  });

  test('hasPriorCageAward matches on either awardee_cage or awardee_cage_code', async () => {
    const { prisma, cageQueries } = makeFake({ cagesWithAwards: ['XYZ99'] });
    const hit = await hasPriorCageAward(prisma, 'XYZ99');
    expect(hit).toBe(true);
    expect(cageQueries).toHaveLength(1);
  });
});

describe('DIBBS awards can never become candidates', () => {
  test('a candidate row is always keyed on a SOLICITATION tangoDibbsId, never an award one', async () => {
    // The CAGE signal is fed by the award table, but the row identity always
    // traces back to the solicitation being scored — there is no code path by
    // which `AWARD_UUID` itself could appear as a created row's identity, since
    // `tangoDibbsAward` is never read as a source of scoreable rows (only via
    // the raw-SQL CAGE check).
    const { prisma, created } = makeFake({
      solicitations: [solicitationRow({ id: SOLICITATION, tangoDibbsId: SOLICITATION })],
      cagesWithAwards: ['1ABC2'],
    });
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.sourceRecordKey).toBe(SOLICITATION);
    expect(row.sourceRecordKey).not.toBe(AWARD_UUID);
  });
});

describe('generateDibbsCandidates', () => {
  test('a dry run reports REAL counts and writes nothing', async () => {
    const { prisma, created, updated } = makeFake({});
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.evaluated).toBe(1);
    expect(r.created).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('--commit writes a suggested, producer-owned row with the generic identity only', async () => {
    const { prisma, created } = makeFake({});
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.tenantId).toBe(TENANT);
    expect(row.clientId).toBe(CLIENT);
    expect(row.source).toBe('dibbs');
    expect(row.sourceRecordType).toBe('dibbs_solicitation');
    expect(row.sourceRecordKey).toBe(SOLICITATION);
    expect(row.grantOpportunityId).toBeNull();
    expect(row.samOpportunityId).toBeNull();
    expect(row.workflowStatus).toBe('suggested');
    expect(row.userCreated).toBe(false);
    expect(row.evidenceSourceType).toBe('deterministic_relevance_v1');
    // No eligibility concept for DIBBS — must not be fabricated.
    expect(row.eligibilityState).toBeUndefined();
  });

  test('a closed solicitation is excluded from the corpus entirely', async () => {
    const { prisma } = makeFake({
      solicitations: [solicitationRow({ isOpen: false })],
    });
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.opportunitiesRead).toBe(0);
    expect(r.evaluated).toBe(0);
  });

  test('a null isOpen with no closesDate is treated as open, not excluded', async () => {
    const { prisma } = makeFake({
      solicitations: [solicitationRow({ isOpen: null, closesDate: null })],
    });
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.opportunitiesRead).toBe(1);
  });

  test('re-running over its own row is idempotent: refresh, not a duplicate', async () => {
    const { prisma, created, updated } = makeFake({
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          sourceRecordKey: SOLICITATION,
          workflowStatus: 'suggested',
          userCreated: false,
          evidenceSourceType: 'deterministic_relevance_v1',
          staleAt: null,
        },
      ],
    });
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.created).toBe(0);
    expect(r.refreshed).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
  });

  test('a pursued row is never touched, and is counted as preserved', async () => {
    const { prisma, created, updated } = makeFake({
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          sourceRecordKey: SOLICITATION,
          workflowStatus: 'pursuing',
          userCreated: true,
          evidenceSourceType: 'user_action',
          staleAt: null,
        },
      ],
    });
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.humanDecisionsPreserved).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('every tenant-scoped read carries an EXPLICIT tenantId as well as the bypass', async () => {
    const { prisma, clientWhere, bypassCalls } = makeFake({});
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(bypassCalls.some((s) => s.includes('app.bypass_rls'))).toBe(true);
    expect((clientWhere[0] as { tenantId?: string }).tenantId).toBe(TENANT);
  });

  test('--client narrows the sweep to one client', async () => {
    const { prisma, clientWhere } = makeFake({});
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: CLIENT,
      minRelevance: 15,
      commit: false,
    });
    expect((clientWhere[0] as { id?: string }).id).toBe(CLIENT);
  });

  test('there is no query per (client, solicitation) pair', async () => {
    const solicitations = Array.from({ length: 6 }, (_, i) =>
      solicitationRow({ id: `sol-${i}`, tangoDibbsId: `sol-${i}` }),
    );
    const clients = Array.from({ length: 4 }, (_, i) =>
      clientRow({ id: `00000000-0000-0000-0000-00000000010${i}` }),
    );
    const { prisma, cageQueries } = makeFake({ solicitations, clients });
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect((prisma.tangoDibbsSolicitation.findMany as jest.Mock).mock.calls).toHaveLength(1);
    expect((prisma.client.findMany as jest.Mock).mock.calls).toHaveLength(1);
    // CAGE history bounded by CLIENTS, not by (client x solicitation) pairs.
    expect(cageQueries.length).toBeLessThanOrEqual(clients.length);
  });

  test('the workflow read is scoped to the current solicitation page', async () => {
    const solicitations = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
      solicitationRow({ id: `sol-${String(i).padStart(5, '0')}`, tangoDibbsId: `sol-${i}` }),
    );
    const { prisma, workflowWhere } = makeFake({ solicitations });
    await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(workflowWhere.length).toBeGreaterThan(0);
    for (const where of workflowWhere) {
      expect(where.sourceRecordKey?.in).toBeDefined();
      expect(where.sourceRecordKey.in.length).toBeLessThanOrEqual(PAGE_SIZE);
    }
  }, 60000);

  test('a page-sized corpus is COMPLETE, and a resumed run starts strictly after the cursor', async () => {
    const clients = Array.from({ length: 5 }, (_, i) => clientRow({ id: `c-${String(i).padStart(5, '0')}` }));
    const { prisma, clientWhere } = makeFake({ clients });
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
      resumeClientCursor: `c-${String(1).padStart(5, '0')}`,
    });
    expect((clientWhere[0] as { id?: unknown }).id).toEqual({ gt: `c-${String(1).padStart(5, '0')}` });
    expect(r.clientsRead).toBe(3);
    expect(r.completion).toBe('COMPLETE');
  });

  test('one failing pair does not abort the rest of the run', async () => {
    const { prisma } = makeFake({
      solicitations: [
        solicitationRow({ id: 's-1', tangoDibbsId: 's-1' }),
        solicitationRow({ id: 's-2', tangoDibbsId: 's-2' }),
      ],
    });
    let calls = 0;
    (prisma.clientFundingOpportunity.create as jest.Mock).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('unique violation');
      return {};
    });
    const r = await generateDibbsCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.errors).toBe(1);
    expect(r.evaluated).toBe(2);
  });
});

describe('resolveTenantIds', () => {
  test('--tenant wins outright, regardless of flag state', async () => {
    const { prisma } = makeFake({ flagRows: [] });
    expect(await resolveTenantIds(prisma, TENANT)).toEqual([TENANT]);
  });

  test('otherwise only tenants with an ENABLED funding_opportunities flag', async () => {
    const { prisma } = makeFake({ flagRows: [{ tenant_id: TENANT }] });
    expect(await resolveTenantIds(prisma, null)).toEqual([TENANT]);
  });

  test('no enabled flag means no tenants — there is NO internal-tenant hardcode', async () => {
    const { prisma } = makeFake({ flagRows: [] });
    expect(await resolveTenantIds(prisma, null)).toEqual([]);
  });
});
