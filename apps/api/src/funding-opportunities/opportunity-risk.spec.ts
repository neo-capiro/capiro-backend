import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXCLUSION_STALE_AFTER_DAYS,
  OpportunityRiskService,
  RISK_EXCLUSION_STATES,
  RISK_STATES,
  deriveExclusion,
} from './opportunity-risk.service.js';
import {
  PROTEST_FIELDS,
  mapExclusionObservation,
  mapProtest,
  toProtestRow,
  uei12,
} from '../external/tango/tango-risk.mapper.js';

/**
 * Protest and exclusion risk context (P45).
 *
 * Five properties carry the phase:
 *   1. Same-name entities inherit nothing. The only key is a 12-character UEI.
 *   2. An expired exclusion never reads as active.
 *   3. Protest outcome language is the provider's own word, unaltered.
 *   4. No legal advice, anywhere — swept, not promised.
 *   5. Absence of evidence is never good standing, and the caveat is on every
 *      response including the clean ones.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const UEI = 'ABC123DEF456';
const OTHER_UEI = 'ZZZ999YYY888';
const AS_OF = new Date('2026-09-03T12:00:00.000Z');

const STANDARD = { tenantId: TENANT, userId: USER, role: 'standard_user' as const };
const PORTAL = { tenantId: TENANT, userId: USER, role: 'client_portal_user' as const };

function daysBefore(days: number): Date {
  return new Date(AS_OF.getTime() - days * 86_400_000);
}

function exclusionRow(over: Record<string, unknown> = {}) {
  return {
    exclusionStatusFlag: 'true',
    exclusionUrl: 'https://sam.gov/exclusion/1',
    exclusionStartDate: null,
    exclusionEndDate: null,
    observedAt: daysBefore(1),
    ...over,
  } as Parameters<typeof deriveExclusion>[0];
}

function protestRow(over: Record<string, unknown> = {}) {
  return {
    tangoCaseId: 'B-421234.2',
    caseNumber: 'B-421234.2',
    sourceSystem: 'gao',
    outcome: 'Denied',
    caseType: 'protest',
    filedDate: new Date('2026-04-01T00:00:00.000Z'),
    decisionDate: new Date('2026-07-15T00:00:00.000Z'),
    agencyName: 'Department of the Navy',
    protesterName: 'Known Co',
    protesterUei: UEI,
    sourceUrl: 'https://gao.gov/products/b-421234.2',
    ...over,
  };
}

function makeService(
  over: {
    flagEnabled?: boolean;
    flagThrows?: boolean;
    visibleClientIds?: string[];
    clientUei?: string | null;
    exclusion?: unknown;
    protests?: unknown[];
  } = {},
) {
  const queried = { exclusionWhere: null as unknown, protestWhere: null as unknown };
  const flagEnabled = over.flagEnabled ?? true;
  const visible = over.visibleClientIds ?? [CLIENT];
  const clientUei = over.clientUei === undefined ? UEI : over.clientUei;

  const prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => {
      if (over.flagThrows) throw new Error('42883 operator does not exist: text = uuid');
      return fn({
        $queryRaw: async () => (flagEnabled ? [{ ok: 1 }] : []),
        tangoEntityExclusion: {
          findFirst: async (args: { where: unknown }) => {
            queried.exclusionWhere = args.where;
            return over.exclusion === undefined ? null : over.exclusion;
          },
        },
        tangoProcurementProtest: {
          findMany: async (args: { where: unknown }) => {
            queried.protestWhere = args.where;
            return over.protests ?? [];
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

  return { service: new OpportunityRiskService(prisma as never), queried };
}

// ── 1. Identity ─────────────────────────────────────────────────────────────

describe('P45 — same-name entities inherit nothing', () => {
  it('both queries are keyed on the UEI, and neither mentions a name', async () => {
    const { service, queried } = makeService();
    await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(queried.exclusionWhere).toEqual({ uei: UEI });
    expect(queried.protestWhere).toEqual({ protesterUei: UEI });
    expect(JSON.stringify(queried)).not.toContain('name');
  });

  it('a client with no UEI gets no query at all, and is told why', async () => {
    const { service, queried } = makeService({ clientUei: null });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.state).toBe('no_client_identity');
    expect(result.explanation).toContain('a name match could attach another company’s record');
    expect(queried.exclusionWhere).toBeNull();
  });

  it('a malformed UEI is treated as no identity, never as a key', async () => {
    // A wrong-length value that reached a query would match nothing, and
    // "no protests found" is the wrong answer about a client whose UEI was
    // mangled.
    for (const bad of ['TOOSHORT', 'WAY-TOO-LONG-UEI-VALUE', '   ', '']) {
      const { service } = makeService({ clientUei: bad });
      expect((await service.getRiskContext(STANDARD, CLIENT, AS_OF)).state).toBe(
        'no_client_identity',
      );
    }
  });

  it('the mapper refuses a malformed UEI on both sides', () => {
    expect(uei12(UEI)).toBe(UEI);
    for (const bad of ['SHORT', 'TOOLONGTOOLONG', '', null, 42, {}]) expect(uei12(bad)).toBeNull();

    // A protest whose protester the provider never resolved carries no UEI, so
    // it can never be matched to a client at all — which is correct.
    const unresolved = mapProtest(
      { case_id: 'B-1', protester: { name: 'Some Co' } },
      AS_OF.toISOString(),
    )!;
    expect(unresolved.protesterUei).toBeNull();
    expect(unresolved.protesterName).toBe('Some Co');

    expect(mapExclusionObservation({ uei: 'BAD' }, AS_OF.toISOString())).toBeNull();
    expect(mapExclusionObservation({ uei: OTHER_UEI }, AS_OF.toISOString())?.uei).toBe(OTHER_UEI);
  });
});

// ── 2. Exclusion states ─────────────────────────────────────────────────────

describe('P45 — an expired exclusion never reads as active', () => {
  it('a set flag with a PAST end date is expired, whatever the freshness', () => {
    const view = deriveExclusion(
      exclusionRow({ exclusionEndDate: new Date('2025-01-01T00:00:00.000Z') }),
      AS_OF,
    );
    expect(view.state).toBe('expired');
    expect(view.explanation).toContain('not in force');
    expect(view.explanation).not.toContain('active exclusion');
  });

  it('the DATE check runs before the staleness check', () => {
    // A finished exclusion is finished whether or not Capiro re-checked. A
    // provider-supplied date is better evidence than a clock, and reporting it
    // `unverified` would send a reviewer to re-check something already resolved.
    const view = deriveExclusion(
      exclusionRow({
        exclusionEndDate: new Date('2025-01-01T00:00:00.000Z'),
        observedAt: daysBefore(EXCLUSION_STALE_AFTER_DAYS + 60),
      }),
      AS_OF,
    );
    expect(view.state).toBe('expired');
  });

  it('a set flag observed too long ago is unverified, never active', () => {
    const view = deriveExclusion(
      exclusionRow({ observedAt: daysBefore(EXCLUSION_STALE_AFTER_DAYS + 1) }),
      AS_OF,
    );
    expect(view.state).toBe('unverified');
    expect(view.explanation).toContain('cannot say whether it still stands');
  });

  it('a set flag observed recently, with no end date, is active', () => {
    const view = deriveExclusion(exclusionRow(), AS_OF);
    expect(view.state).toBe('active');
    expect(view.explanation).toContain('when Capiro last asked');
  });

  it('the staleness boundary is exact', () => {
    expect(deriveExclusion(exclusionRow({ observedAt: daysBefore(30) }), AS_OF).state).toBe(
      'active',
    );
    expect(
      deriveExclusion(exclusionRow({ observedAt: daysBefore(30.001) }), AS_OF).state,
    ).toBe('unverified');
  });

  it('a FUTURE end date is still active — the exclusion has not ended', () => {
    const view = deriveExclusion(
      exclusionRow({ exclusionEndDate: new Date('2027-01-01T00:00:00.000Z') }),
      AS_OF,
    );
    expect(view.state).toBe('active');
  });

  it('a clear flag is "none observed" and explicitly not a clearance', () => {
    for (const flag of ['false', 'N', 'no', '0', '', null]) {
      const view = deriveExclusion(exclusionRow({ exclusionStatusFlag: flag }), AS_OF);
      expect(view.state).toBe('none_observed');
      expect(view.explanation).toContain('not a clearance');
    }
  });

  it('the provider’s flag is stored verbatim, including a literal false', () => {
    // A boolean column would lose the difference between "the provider said no"
    // and "the provider said nothing", and only the first is evidence.
    expect(
      mapExclusionObservation({ uei: UEI, exclusion_status_flag: false }, AS_OF.toISOString())
        ?.exclusionStatusFlag,
    ).toBe('false');
    expect(
      mapExclusionObservation({ uei: UEI }, AS_OF.toISOString())?.exclusionStatusFlag,
    ).toBeNull();
  });

  it('the dates are always null today, and the record says so by carrying them', () => {
    // The Entity resource states neither. The fields exist so the derivation
    // rule already honours them if a provider release adds them.
    const obs = mapExclusionObservation({ uei: UEI, exclusion_status_flag: 'true' }, AS_OF.toISOString())!;
    expect(obs.exclusionStartDate).toBeNull();
    expect(obs.exclusionEndDate).toBeNull();
  });

  it('an ACTIVE exclusion routes to needs_review and nothing stronger', async () => {
    const { service } = makeService({ exclusion: exclusionRow() });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.recommendationHint).toEqual({
      state: 'needs_review',
      reason:
        'An active exclusion was observed against this client’s UEI. Blocked pending legal or compliance review.',
    });
    // There is no value this field could carry that reads as a clearance or a
    // decision — `needs_review` is the only one.
    expect(result.recommendationHint!.state).toBe('needs_review');
  });

  it('every other exclusion state contributes NO recommendation hint', async () => {
    for (const over of [
      { exclusion: undefined },
      { exclusion: exclusionRow({ exclusionStatusFlag: 'false' }) },
      { exclusion: exclusionRow({ exclusionEndDate: new Date('2025-01-01T00:00:00.000Z') }) },
      { exclusion: exclusionRow({ observedAt: daysBefore(90) }) },
    ]) {
      const { service } = makeService(over);
      expect((await service.getRiskContext(STANDARD, CLIENT, AS_OF)).recommendationHint).toBeNull();
    }
  });
});

// ── 3. Protest language ─────────────────────────────────────────────────────

describe('P45 — protest outcome language is source-backed', () => {
  it('the provider’s own word is passed through unaltered, with its caveat', async () => {
    const { service } = makeService({ protests: [protestRow({ outcome: 'Sustained' })] });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.protests[0]!.outcome).toBe('Sustained');
    expect(result.protests[0]!.outcomeCaveat).toContain('Capiro does not interpret it');
    expect(result.protests[0]!.matchedOn).toBe('protester_uei');
  });

  it('a null outcome stays null — an open case is not a failed one', async () => {
    const { service } = makeService({ protests: [protestRow({ outcome: null })] });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.protests[0]!.outcome).toBeNull();
    // And nothing invents a word for it.
    expect(JSON.stringify(result.protests[0])).not.toMatch(/dismissed|failed|lost/i);
  });

  it('the forum is carried, never normalized away', async () => {
    // GAO and the Court of Federal Claims use the same outcome words for
    // different procedural events; one shared enum would make them look alike.
    const { service } = makeService({
      protests: [protestRow({ sourceSystem: 'gao' }), protestRow({ sourceSystem: 'cofc' })],
    });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.protests.map((p) => p.sourceSystem)).toEqual(['gao', 'cofc']);
  });

  it('dates render as DATES, not instants', async () => {
    // toISOString() on UTC midnight shows the previous day for every reader
    // west of Greenwich — the trap P26 named for forecast dates.
    const { service } = makeService({ protests: [protestRow()] });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.protests[0]!.filedDate).toBe('2026-04-01');
    expect(result.protests[0]!.decisionDate).toBe('2026-07-15');
  });

  it('the mapper prefers the RESOLVED protester for the key, the docket name for display', () => {
    const record = mapProtest(
      {
        case_id: 'B-9',
        protester: { name: 'ACME CORP (as typed on the docket)' },
        resolved_protester: { uei: UEI, legal_business_name: 'Acme Corporation' },
      },
      AS_OF.toISOString(),
    )!;
    expect(record.protesterUei).toBe(UEI);
    expect(record.protesterName).toBe('Acme Corporation');
  });

  it('a protest with no case id is dropped rather than duplicated next sync', () => {
    expect(mapProtest({ outcome: 'Denied' }, AS_OF.toISOString())).toBeNull();
    // …but a case_number alone is enough identity.
    expect(mapProtest({ case_number: 'B-7' }, AS_OF.toISOString())?.caseId).toBe('B-7');
  });

  it('the field list is the SDK’s own ProtestRecord declaration', () => {
    for (const field of ['case_id', 'case_number', 'source_system', 'outcome', 'docket']) {
      expect(PROTEST_FIELDS).toContain(field);
    }
    const record = mapProtest(
      { case_id: 'B-1', a_field_capiro_never_asked_for: 'surprise' },
      AS_OF.toISOString(),
    )!;
    expect(JSON.stringify(record)).not.toContain('surprise');
  });

  it('the opportunity link is a PARAMETER, never derived by the mapper', () => {
    const record = mapProtest({ case_id: 'B-1', agency: { name: 'Navy' } }, AS_OF.toISOString())!;
    expect(toProtestRow(record, null).samOpportunityId).toBeNull();
    expect(toProtestRow(record, 'notice-uuid').samOpportunityId).toBe('notice-uuid');
    // A mapper that guessed a link from an agency name would be the fuzzy match
    // this whole phase refuses.
    expect(toProtestRow.length).toBe(2);
  });
});

// ── 4. No legal advice ──────────────────────────────────────────────────────

describe('P45 — nothing here is legal advice', () => {
  const files = [
    join(__dirname, 'opportunity-risk.service.ts'),
    join(__dirname, '..', 'external', 'tango', 'tango-risk.mapper.ts'),
  ];

  it('no advice-shaped phrasing appears in any string this phase emits', () => {
    // Swept against the SOURCE rather than one rendered response, so a branch
    // nobody exercised in a test cannot smuggle a sentence through.
    const forbidden = [
      'you should',
      'we recommend that',
      'is not permitted to bid',
      'cannot bid',
      'is ineligible',
      'is disqualified',
      'is barred',
      'must not pursue',
      'legally',
      'unlawful',
      'illegal',
      'liable',
      'consult your attorney',
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const phrase of forbidden) expect(text).not.toContain(phrase);
    }
  });

  it('the caveats say what a protest is NOT', async () => {
    const { service } = makeService({ protests: [protestRow()] });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    const joined = result.caveats.join(' ');
    expect(joined).toContain('not evidence that this procurement is invalid');
    expect(joined).toContain('not evidence of good standing');
  });

  it('the service writes nothing and reads only the two provider tables', () => {
    const code = readFileSync(files[0]!, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const verb of ['.create(', '.update(', '.upsert(', '.delete(', '$executeRaw']) {
      expect(code).not.toContain(verb);
    }
    const models = [...code.matchAll(/tx\.([a-zA-Z]+)\./g)].map((m) => m[1]);
    expect([...new Set(models)].sort()).toEqual([
      'client',
      'tangoEntityExclusion',
      'tangoProcurementProtest',
    ]);
    expect(OpportunityRiskService.length).toBe(1);
  });
});

// ── 5. Absence, and the gate ────────────────────────────────────────────────

describe('P45 — absence is never good standing', () => {
  it('the absence caveat is on EVERY response, including the clean ones', async () => {
    for (const over of [
      {},
      { exclusion: exclusionRow({ exclusionStatusFlag: 'false' }) },
      { flagEnabled: false },
      { visibleClientIds: [] },
      { clientUei: null },
    ]) {
      const { service } = makeService(over);
      const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
      expect(result.caveats.join(' ')).toContain(
        'Absence of exclusion evidence is not evidence of good standing',
      );
    }
  });

  it('a client with no observation and no protests still says "not a clearance"', async () => {
    const { service } = makeService({ exclusion: undefined, protests: [] });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.state).toBe('available');
    expect(result.exclusion.state).toBe('none_observed');
    expect(result.exclusion.explanation).toContain('not a clearance');
    expect(result.protests).toEqual([]);
  });

  it('the flag off, a portal user and a walled client all fail closed', async () => {
    expect((await makeService({ flagEnabled: false }).service.getRiskContext(STANDARD, CLIENT, AS_OF)).state).toBe('disabled');
    expect((await makeService({ flagThrows: true }).service.getRiskContext(STANDARD, CLIENT, AS_OF)).state).toBe('disabled');
    expect((await makeService().service.getRiskContext(PORTAL, CLIENT, AS_OF)).state).toBe('denied');
    const walled = await makeService({ visibleClientIds: [] }).service.getRiskContext(
      STANDARD,
      CLIENT,
      AS_OF,
    );
    expect(walled.state).toBe('denied');
    expect(walled.explanation).toBe('Not available for this client.');
  });

  it('a refusal carries no risk data at all', async () => {
    const { service } = makeService({
      flagEnabled: false,
      exclusion: exclusionRow(),
      protests: [protestRow()],
    });
    const result = await service.getRiskContext(STANDARD, CLIENT, AS_OF);
    expect(result.protests).toEqual([]);
    expect(result.exclusion.providerFlag).toBeNull();
    expect(result.recommendationHint).toBeNull();
  });

  it('the vocabularies are the states the phase actually has', () => {
    expect([...RISK_EXCLUSION_STATES]).toEqual([
      'none_observed',
      'active',
      'expired',
      'unverified',
    ]);
    expect([...RISK_STATES]).toEqual(['available', 'disabled', 'denied', 'no_client_identity']);
  });
});
