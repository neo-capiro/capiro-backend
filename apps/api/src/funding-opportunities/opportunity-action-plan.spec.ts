import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  ACTION_CATEGORIES,
  STAGE_ALLOWED_INTENTS,
  assertStageAllowsIntents,
  buildActionPlan,
  hasPursuitAction,
  planStageFor,
  type PlanInput,
  type PlanStage,
  type ProposedAction,
} from './opportunity-action-plan.js';
import {
  GovernmentLandscapeService,
  type LandscapePort,
} from './government-landscape.service.js';
import type { LandscapeItem } from './government-landscape.types.js';

/**
 * The deterministic action plan (P34).
 *
 * Five properties carry the phase:
 *   1. the same packet and the same `asOf` produce a byte-identical plan;
 *   2. no target is named without a SOURCE-BACKED reason;
 *   3. a closed or informational notice — and a forecast — never proposes a
 *      pursuit;
 *   4. an unmet dependency is stated as a prerequisite rather than assumed;
 *   5. accepting an action routes through P08's existing idempotent action,
 *      and this module writes nothing at all.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const SAM_ID = '44444444-4444-4444-4444-444444444444';
const FORECAST_ID = '55555555-5555-5555-5555-555555555555';
const AS_OF = new Date('2026-08-07T12:00:00.000Z');
const DEADLINE = '2026-10-01T17:00:00.000Z';

function acceptedPe(over: Partial<LandscapeItem> = {}): LandscapeItem {
  return {
    source: 'program_element',
    sourceId: 'match-accepted',
    label: 'Program Element 0204163N, linked by a reviewed and accepted match.',
    basis: 'source_backed',
    matchedOn: '0204163N',
    evidenceRef: 'sam_opportunity_match:match-accepted',
    asOf: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function quarantinedPe(over: Partial<LandscapeItem> = {}): LandscapeItem {
  return {
    ...acceptedPe(),
    sourceId: 'match-quarantined',
    basis: 'inferred',
    matchedOn: '0605898N',
    label: 'Program Element 0605898N, an UNREVIEWED match. Not evidence of a link.',
    ...over,
  };
}

function district(over: Partial<LandscapeItem> = {}): LandscapeItem {
  return {
    source: 'congressional_district',
    sourceId: 'fac-1:04',
    label: 'FL-04: a recorded client facility sits in the state this notice names.',
    basis: 'source_backed',
    matchedOn: 'FL-04',
    evidenceRef: 'client_facility:fac-1',
    asOf: null,
    ...over,
  };
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    source: 'sam_gov',
    sourceRecordId: SAM_ID,
    clientId: CLIENT,
    kind: 'solicitation',
    isActive: true,
    isPursuable: true,
    responseDeadline: DEADLINE,
    landscape: [],
    hasRequirements: false,
    hasVehicleAccess: false,
    asOf: AS_OF,
    ...over,
  };
}

// ── 1 ─ Determinism ──────────────────────────────────────────────────────────

describe('action plan — determinism', () => {
  it('produces a byte-identical plan for the same packet and the same asOf', () => {
    const a = buildActionPlan(input({ landscape: [acceptedPe(), district()] }));
    const b = buildActionPlan(input({ landscape: [acceptedPe(), district()] }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('orders actions the same way regardless of the order the rules added them', () => {
    // Reversing the landscape input cannot reorder the plan: the district rule
    // appends last, and the total order re-sorts everything by category.
    const forward = buildActionPlan(input({ landscape: [acceptedPe(), district()] }));
    const reversed = buildActionPlan(input({ landscape: [district(), acceptedPe()] }));
    expect(reversed.actions.map((a) => a.id)).toEqual(forward.actions.map((a) => a.id));
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });

  it('sorts by the declared category rank, not alphabetically', () => {
    const plan = buildActionPlan(input({ landscape: [district()] }));
    const rank = (c: string) => ACTION_CATEGORIES.indexOf(c as never);
    const ranks = plan.actions.map((a) => rank(a.category));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });

  it('gives every action a stable id derived from the plan inputs', () => {
    const first = buildActionPlan(input());
    const again = buildActionPlan(input());
    expect(first.actions.map((a) => a.id)).toEqual(again.actions.map((a) => a.id));
    // Ids are per-pair: the SAME action title on a different opportunity is a
    // different action, which is what keeps a UI from marking both as dealt with.
    const other = buildActionPlan(input({ sourceRecordId: '66666666-6666-6666-6666-666666666666' }));
    expect(other.actions.map((a) => a.id)).not.toEqual(first.actions.map((a) => a.id));
  });

  it('does not move the fingerprint when only the observation time changes', () => {
    const noon = buildActionPlan(input());
    const evening = buildActionPlan(input({ asOf: new Date('2026-08-07T20:00:00.000Z') }));
    expect(evening.fingerprint).toBe(noon.fingerprint);
    // …and generatedAt DOES move, so the caller can still tell them apart.
    expect(evening.generatedAt).not.toBe(noon.generatedAt);
  });

  it('moves the fingerprint when a prerequisite resolves', () => {
    const without = buildActionPlan(input({ hasRequirements: false }));
    const withReqs = buildActionPlan(input({ hasRequirements: true }));
    expect(withReqs.fingerprint).not.toBe(without.fingerprint);
  });

  it('reads no clock of its own', () => {
    const source = readFileSync(join(__dirname, 'opportunity-action-plan.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/new Date\(\s*\)/);
    expect(code).not.toMatch(/Date\.now\(/);
  });
});

// ── 2 ─ No target without a source-backed reason ─────────────────────────────

describe('action plan — targets', () => {
  it('names a programme office when an ACCEPTED PE match supplies one', () => {
    const plan = buildActionPlan(
      input({ source: 'agency_forecast', sourceRecordId: FORECAST_ID, landscape: [acceptedPe()] }),
    );
    const briefing = plan.actions.find((a) => a.title.includes('capability briefing'));
    expect(briefing?.suggestedTarget).toBe('Programme office for 0204163N');
    expect(briefing?.evidence).toEqual([
      { source: 'program_element', sourceId: 'match-accepted', matchedOn: '0204163N' },
    ]);
  });

  it('names NO target from an inferred PE match', () => {
    // A quarantined match is what a NAICS or keyword coincidence produces.
    // Suggesting an office on the strength of one is the fabricated relationship
    // the phase exists to prevent.
    const plan = buildActionPlan(
      input({
        source: 'agency_forecast',
        sourceRecordId: FORECAST_ID,
        landscape: [quarantinedPe()],
      }),
    );
    for (const action of plan.actions) expect(action.suggestedTarget).toBeNull();
    const briefing = plan.actions.find((a) => a.title.includes('capability briefing'));
    expect(briefing?.evidence).toEqual([]);
    expect(briefing?.unresolvedPrerequisites.join(' ')).toContain('SAM.gov notices only');
  });

  it('never emits an action whose evidence includes an inferred item', () => {
    const plan = buildActionPlan(
      input({ landscape: [acceptedPe(), quarantinedPe(), district()] }),
    );
    const inferredIds = new Set(['match-quarantined']);
    for (const action of plan.actions) {
      for (const e of action.evidence) expect(inferredIds.has(e.sourceId)).toBe(false);
    }
  });

  it('never names a person, only an office or a delegation', () => {
    const plan = buildActionPlan(input({ landscape: [acceptedPe(), district()] }));
    const targets = plan.actions.map((a) => a.suggestedTarget).filter(Boolean) as string[];
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t).toMatch(/^(Programme office for|Congressional delegation for) /);
    }
  });

  it('derives a district target from the state overlap and says delegation, not district', () => {
    const plan = buildActionPlan(input({ landscape: [district()] }));
    const brief = plan.actions.find((a) => a.title.includes('congressional offices'));
    expect(brief?.suggestedTarget).toBe('Congressional delegation for FL-04');
    expect(brief?.evidence).toEqual([
      { source: 'congressional_district', sourceId: 'fac-1:04', matchedOn: 'FL-04' },
    ]);
  });

  it('emits no district action at all when no facility overlaps', () => {
    const plan = buildActionPlan(input({ landscape: [acceptedPe()] }));
    expect(plan.actions.some((a) => a.title.includes('congressional offices'))).toBe(false);
  });

  it('de-duplicates and sorts several PE codes into one target', () => {
    const plan = buildActionPlan(
      input({
        source: 'agency_forecast',
        sourceRecordId: FORECAST_ID,
        landscape: [
          acceptedPe({ sourceId: 'a', matchedOn: '0605898N' }),
          acceptedPe({ sourceId: 'b', matchedOn: '0204163N' }),
          acceptedPe({ sourceId: 'c', matchedOn: '0204163N' }),
        ],
      }),
    );
    const briefing = plan.actions.find((a) => a.title.includes('capability briefing'));
    expect(briefing?.suggestedTarget).toBe('Programme office for 0204163N, 0605898N');
  });
});

// ── 3 ─ Closed and informational notices never propose a pursuit ─────────────

describe('action plan — stage', () => {
  const stageCases: Array<[Partial<PlanInput>, PlanStage]> = [
    [{ kind: 'sources_sought' }, 'sources_sought'],
    [{ kind: 'presolicitation' }, 'presolicitation'],
    [{ kind: 'solicitation' }, 'solicitation'],
    [{ kind: 'combined_synopsis_solicitation' }, 'solicitation'],
    [{ kind: 'amendment' }, 'amendment'],
    [{ kind: 'grant' }, 'grant'],
    [{ kind: 'cooperative_agreement' }, 'grant'],
    [{ kind: 'award_notice', isPursuable: false }, 'closed_or_informational'],
    [{ kind: 'special_notice', isPursuable: false }, 'closed_or_informational'],
    [{ kind: 'other' }, 'closed_or_informational'],
    [{ kind: 'solicitation', isActive: false }, 'closed_or_informational'],
    [{ source: 'agency_forecast', sourceRecordId: FORECAST_ID }, 'forecast'],
  ];

  it.each(stageCases)('maps %j to its stage', (over, expected) => {
    expect(planStageFor(input(over))).toBe(expected);
    expect(buildActionPlan(input(over)).stage).toBe(expected);
  });

  it('a forecast stays a forecast even when the row is marked inactive', () => {
    // Source wins. A withdrawn forecast is still not a notice to respond to, and
    // routing it to `closed_or_informational` would swap shaping advice for
    // "watch for a repost" — which is advice about a solicitation that never was.
    expect(
      planStageFor(input({ source: 'agency_forecast', sourceRecordId: FORECAST_ID, isActive: false })),
    ).toBe('forecast');
  });

  it('proposes only monitor and reference work for a closed notice', () => {
    const plan = buildActionPlan(input({ isActive: false }));
    expect(plan.actions.map((a) => a.category).sort()).toEqual(['monitor', 'reference']);
    expect(hasPursuitAction(plan)).toBe(false);
  });

  it('proposes no pursuit for an award notice however strong the landscape', () => {
    const plan = buildActionPlan(
      input({ kind: 'award_notice', isPursuable: false, landscape: [acceptedPe(), district()] }),
    );
    expect(hasPursuitAction(plan)).toBe(false);
  });

  it('proposes no pursuit for a forecast', () => {
    const plan = buildActionPlan(
      input({ source: 'agency_forecast', sourceRecordId: FORECAST_ID, landscape: [acceptedPe()] }),
    );
    expect(hasPursuitAction(plan)).toBe(false);
    expect(plan.actions.map((a) => a.category).sort()).toEqual(['monitor', 'research', 'shape']);
  });

  it('refuses structurally when a rule produces a forbidden intent', () => {
    // The guarantee is enforced, not merely intended. A silent downgrade would
    // ship the buggy rule with a plausible plan on top of it.
    const rogue = { title: 'Pursue anyway', intent: 'pursuit' } as ProposedAction;
    expect(() => assertStageAllowsIntents('forecast', [rogue])).toThrow(/forecast/);
    expect(() => assertStageAllowsIntents('closed_or_informational', [rogue])).toThrow(/pursuit/);
    expect(() => assertStageAllowsIntents('solicitation', [rogue])).not.toThrow();
  });

  it('excludes pursuit from exactly the two non-pursuable stages', () => {
    const banned = Object.entries(STAGE_ALLOWED_INTENTS)
      .filter(([, allowed]) => !allowed.has('pursuit'))
      .map(([stage]) => stage)
      .sort();
    expect(banned).toEqual(['closed_or_informational', 'forecast']);
  });

  it('gives a solicitation the full response set, decision first', () => {
    const plan = buildActionPlan(input({ kind: 'solicitation' }));
    expect(plan.actions.map((a) => a.title)).toEqual([
      // `qualify` outranks `respond`, so the cheap decision precedes the
      // expensive writing rather than sorting alphabetically beneath it.
      'Make the bid/no-bid decision',
      'Build the compliance matrix',
      'Set the submission milestones',
      'Submit questions to the contracting officer',
    ]);
  });

  it('gives an amendment a reassessment rather than a fresh capture plan', () => {
    const plan = buildActionPlan(input({ kind: 'amendment' }));
    expect(plan.actions.map((a) => a.title)).toEqual([
      'Reassess the affected requirements and dates',
    ]);
  });

  it('gives a grant eligibility, partners and the programme office', () => {
    const plan = buildActionPlan(input({ kind: 'grant' }));
    expect(plan.actions.map((a) => a.title)).toEqual([
      'Confirm eligibility and cost share',
      'Line up the required partners',
      'Contact the programme office',
    ]);
  });
});

// ── 4 ─ Due dates and prerequisites ──────────────────────────────────────────

describe('action plan — due dates', () => {
  it('states what every due date is derived from', () => {
    const plan = buildActionPlan(input());
    for (const action of plan.actions) {
      if (action.dueDate == null) expect(action.dueDateBasis).toBeNull();
      else expect(action.dueDateBasis).toMatch(/before the stated response deadline/);
    }
  });

  it('derives the bid/no-bid date 21 days before the deadline', () => {
    const plan = buildActionPlan(input());
    const decision = plan.actions.find((a) => a.title.includes('bid/no-bid'));
    expect(decision?.dueDate).toBe('2026-09-10T17:00:00.000Z');
  });

  it('invents no due date when the notice states no deadline', () => {
    const plan = buildActionPlan(input({ responseDeadline: null }));
    for (const action of plan.actions) {
      expect(action.dueDate).toBeNull();
      expect(action.dueDateBasis).toBeNull();
    }
  });

  it('invents no due date from an unparseable deadline', () => {
    const plan = buildActionPlan(input({ responseDeadline: 'sometime in the autumn' }));
    for (const action of plan.actions) expect(action.dueDate).toBeNull();
  });

  it('returns a past due date rather than hiding an impossible deadline', () => {
    // Clamping to today would quietly turn "you have already missed the window
    // to decide" into "decide today", which is the opposite of the fact.
    const plan = buildActionPlan(input({ responseDeadline: '2026-08-10T17:00:00.000Z' }));
    const decision = plan.actions.find((a) => a.title.includes('bid/no-bid'));
    expect(decision?.dueDate).toBe('2026-07-20T17:00:00.000Z');
    expect(new Date(decision!.dueDate!).getTime()).toBeLessThan(AS_OF.getTime());
  });

  it('gives a forecast no due date at all', () => {
    const plan = buildActionPlan(
      input({
        source: 'agency_forecast',
        sourceRecordId: FORECAST_ID,
        // Even if a caller hands one over: the provider states no solicitation
        // date, so anything derived here would be Capiro's invention.
        responseDeadline: DEADLINE,
      }),
    );
    for (const action of plan.actions) expect(action.dueDate).toBeNull();
  });
});

describe('action plan — prerequisites', () => {
  it('says the compliance matrix has nothing to build from', () => {
    const plan = buildActionPlan(input({ hasRequirements: false }));
    const matrix = plan.actions.find((a) => a.title.includes('compliance matrix'));
    expect(matrix?.unresolvedPrerequisites).toEqual([
      'No requirements have been extracted from this solicitation’s documents yet.',
    ]);
  });

  it('drops the prerequisite once requirements exist', () => {
    const plan = buildActionPlan(input({ hasRequirements: true }));
    const matrix = plan.actions.find((a) => a.title.includes('compliance matrix'));
    expect(matrix?.unresolvedPrerequisites).toEqual([]);
  });

  it('distinguishes a derived question date from the agency’s own', () => {
    const plan = buildActionPlan(input({ hasRequirements: false }));
    const questions = plan.actions.find((a) => a.title.includes('questions'));
    expect(questions?.dueDate).not.toBeNull();
    expect(questions?.unresolvedPrerequisites.join(' ')).toContain('question deadline has not been extracted');
  });

  it('states the vehicle gap on a sources-sought plan', () => {
    const plan = buildActionPlan(input({ kind: 'sources_sought', hasVehicleAccess: false }));
    const route = plan.actions.find((a) => a.title.includes('acquisition route'));
    expect(route?.unresolvedPrerequisites).toEqual([
      'No current, usable contract-vehicle position is recorded for this client.',
    ]);
    expect(route?.rationale).toContain('no confirmed vehicle access');
  });

  it('changes the rationale rather than the action when a vehicle exists', () => {
    const plan = buildActionPlan(input({ kind: 'sources_sought', hasVehicleAccess: true }));
    const route = plan.actions.find((a) => a.title.includes('acquisition route'));
    expect(route?.unresolvedPrerequisites).toEqual([]);
    expect(route?.rationale).toContain('current, usable vehicle position');
  });
});

// ── 5 ─ Nothing here writes, and acceptance goes through P08 ─────────────────

describe('action plan — proposals only', () => {
  it('uses only P08’s own intents, plus an explicit non-action', () => {
    const everyStage = [
      input({ kind: 'sources_sought' }),
      input({ kind: 'presolicitation' }),
      input({ kind: 'solicitation' }),
      input({ kind: 'amendment' }),
      input({ kind: 'grant' }),
      input({ isActive: false }),
      input({ source: 'agency_forecast', sourceRecordId: FORECAST_ID }),
    ].flatMap((i) => buildActionPlan(i).actions);
    expect(everyStage.length).toBeGreaterThan(10);
    for (const action of everyStage) {
      expect(['review', 'pursuit', 'none']).toContain(action.intent);
    }
  });

  it('marks the reference action as creating nothing', () => {
    const plan = buildActionPlan(input({ isActive: false }));
    const reference = plan.actions.find((a) => a.category === 'reference');
    expect(reference?.intent).toBe('none');
  });

  it('contains no persistence, no HTTP and no model call', () => {
    const source = readFileSync(join(__dirname, 'opportunity-action-plan.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    // Scoped to real persistence. A bare `.update(` search cannot tell
    // `createHash(...).update(...)` — a hash being built — from a row being
    // written, and matching it would make the assertion meaningless.
    expect(code).not.toMatch(/\bprisma\b/i);
    expect(code).not.toMatch(/\btx\.\w+\./);
    expect(code).not.toMatch(/\$queryRaw|\.findMany\(|\.upsert\(|\.createMany\(/);
    expect(code).not.toMatch(/fetch\(|axios|https?:\/\//i);
    expect(code).not.toMatch(/anthropic|openai|\bllm\b/i);
  });

  it('gives every action a rationale composed of sentences, not a score', () => {
    const plan = buildActionPlan(input({ landscape: [acceptedPe(), district()] }));
    for (const action of plan.actions) {
      expect(action.rationale.length).toBeGreaterThan(40);
      expect(action.rationale.trim().endsWith('.')).toBe(true);
    }
  });
});

// ── The composition path ─────────────────────────────────────────────────────

function makeService(over: Partial<LandscapePort> = {}) {
  const base: LandscapePort = {
    visibleClientIds: async () => [CLIENT],
    readProgramElementLinks: async () => [
      {
        id: 'match-accepted',
        peCode: '0204163N',
        reviewStatus: 'accepted',
        matchBasis: 'verbatim_pe_code',
        asOf: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
    readClientFacilities: async () => [
      { id: 'fac-1', name: 'Jacksonville Depot', state: 'FL', congressionalDistrict: '04' },
    ],
    readNoticePlace: async () => ({ state: 'FL' }),
    readPlanLifecycle: async () => ({
      kind: 'solicitation',
      isActive: true,
      responseDeadline: new Date(DEADLINE),
    }),
    readRequirementCount: async () => 0,
    readClientVehiclePositions: async () => 0,
  };
  return new GovernmentLandscapeService({} as never).withPort({ ...base, ...over });
}

describe('composeActionPlan', () => {
  it('composes a plan whose evidence comes from the landscape packet', async () => {
    const service = makeService();
    const result = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(result.state).toBe('available');
    const targets = result.plan!.actions.map((a) => a.suggestedTarget).filter(Boolean);
    expect(targets).toContain('Congressional delegation for FL-04');
  });

  it('denies without naming a stage, and without confirming the client exists', async () => {
    const service = makeService({ visibleClientIds: async () => [] });
    const result = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(result.state).toBe('denied');
    expect(result.plan).toBeNull();
    expect(result.explanation).toBe('Not available for this client.');
  });

  it('reads nothing on behalf of a client the actor cannot see', async () => {
    let reads = 0;
    const count = <T>(value: T) => {
      reads += 1;
      return Promise.resolve(value);
    };
    const service = makeService({
      visibleClientIds: async () => [],
      readPlanLifecycle: () =>
        count({ kind: 'solicitation' as const, isActive: true, responseDeadline: null }),
      readRequirementCount: () => count(3),
      readClientVehiclePositions: () => count(1),
      readProgramElementLinks: () => count([]),
      readClientFacilities: () => count([]),
    });
    await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(reads).toBe(0);
  });

  it('reports an unknown record rather than guessing a stage', async () => {
    const service = makeService({ readPlanLifecycle: async () => null });
    const result = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(result.state).toBe('unknown_record');
    expect(result.plan).toBeNull();
    expect(result.explanation).toContain('says nothing about whether the notice exists');
  });

  it('refuses a pursuit action for a non-pursuable kind read from the row', async () => {
    const service = makeService({
      readPlanLifecycle: async () => ({
        kind: 'award_notice',
        isActive: true,
        responseDeadline: null,
      }),
    });
    const result = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(result.plan!.stage).toBe('closed_or_informational');
    expect(hasPursuitAction(result.plan!)).toBe(false);
  });

  it('builds a forecast plan without composing a landscape', async () => {
    let landscapeReads = 0;
    const service = makeService({
      readProgramElementLinks: async () => {
        landscapeReads += 1;
        return [];
      },
      readPlanLifecycle: async () => ({ kind: 'other', isActive: true, responseDeadline: null }),
    });
    const result = await service.composeActionPlan(
      TENANT,
      USER,
      CLIENT,
      'agency_forecast',
      FORECAST_ID,
      AS_OF,
    );
    expect(result.state).toBe('available');
    expect(result.plan!.stage).toBe('forecast');
    expect(landscapeReads).toBe(0);
    expect(hasPursuitAction(result.plan!)).toBe(false);
  });

  it('reads no requirements for a forecast, because there are no documents', async () => {
    let requirementReads = 0;
    const service = makeService({
      readRequirementCount: async () => {
        requirementReads += 1;
        return 5;
      },
      readPlanLifecycle: async () => ({ kind: 'other', isActive: true, responseDeadline: null }),
    });
    await service.composeActionPlan(TENANT, USER, CLIENT, 'agency_forecast', FORECAST_ID, AS_OF);
    expect(requirementReads).toBe(0);
  });

  it('refuses a grants.gov source rather than composing an empty plan', async () => {
    const service = makeService();
    await expect(
      service.composeActionPlan(TENANT, USER, CLIENT, 'grants_gov', SAM_ID, AS_OF),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports that acceptance is wired for a notice', async () => {
    const service = makeService();
    const result = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(result.acceptance.wired).toBe(true);
  });

  it('reports that acceptance is NOT wired for a forecast, and says why', async () => {
    // A UI that offered an Accept button here would hand the user a 400 from
    // P08's source guard with no explanation.
    const service = makeService({
      readPlanLifecycle: async () => ({ kind: 'other', isActive: true, responseDeadline: null }),
    });
    const result = await service.composeActionPlan(
      TENANT,
      USER,
      CLIENT,
      'agency_forecast',
      FORECAST_ID,
      AS_OF,
    );
    expect(result.acceptance.wired).toBe(false);
    expect(result.acceptance.explanation).toContain('a forecast is not one');
  });

  it('states the acceptance rule even when it denies', async () => {
    // Constant per source, so the denied response is shaped identically to an
    // available one and cannot be told apart by its keys.
    const service = makeService({ visibleClientIds: async () => [] });
    const result = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(Object.keys(result).sort()).toEqual(['acceptance', 'explanation', 'plan', 'state']);
  });

  it('evaluates whether the notice is open against the caller’s asOf', async () => {
    // Otherwise the same packet and the same asOf could yield two different
    // plans depending on when the request happened to run, which is precisely
    // the determinism the phase asks for.
    const seen: Date[] = [];
    const service = makeService({
      readPlanLifecycle: async (_source, _id, asOf) => {
        seen.push(asOf);
        return { kind: 'solicitation', isActive: true, responseDeadline: new Date(DEADLINE) };
      },
    });
    await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(seen).toEqual([AS_OF]);
  });

  it('is deterministic across two composes of the same facts', async () => {
    const service = makeService();
    const a = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    const b = await service.composeActionPlan(TENANT, USER, CLIENT, 'sam_gov', SAM_ID, AS_OF);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('turns a vehicle position into a resolved prerequisite', async () => {
    const withVehicle = makeService({
      readClientVehiclePositions: async () => 2,
      readPlanLifecycle: async () => ({
        kind: 'sources_sought',
        isActive: true,
        responseDeadline: new Date(DEADLINE),
      }),
    });
    const result = await withVehicle.composeActionPlan(
      TENANT,
      USER,
      CLIENT,
      'sam_gov',
      SAM_ID,
      AS_OF,
    );
    const route = result.plan!.actions.find((a) => a.title.includes('acquisition route'));
    expect(route?.unresolvedPrerequisites).toEqual([]);
  });
});
