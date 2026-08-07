import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  FORECAST_ACTIONS,
  FORECAST_FORBIDDEN_ACTIONS,
  ForecastOpportunityReadService,
  containsWholeToken,
  deriveForecastSignals,
  toDecision,
  toForecastRelevanceInput,
  type ForecastReadPort,
  type ForecastRow,
  type ForecastSignalProfile,
  type ProfileForForecast,
  type WorkflowRow,
} from './forecast-opportunity-read.service.js';
import { toInboxForecastFacts } from './funding-opportunity-inbox.service.js';
import { HUMAN_DECISIONS } from './funding-opportunities.types.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const AS_OF = new Date('2026-08-07T12:00:00Z');

function forecastRow(over: Partial<ForecastRow> = {}): ForecastRow {
  return {
    tangoForecastId: 'FCST-1',
    externalId: 'APFS-9001',
    title: 'Depot-level turbofan sustainment services',
    description: 'The Department anticipates a follow-on requirement for engine overhaul.',
    agency: 'DEPT OF THE NAVY',
    departmentName: 'Department of Defense',
    organizationAgencyName: 'Department of the Navy',
    officeName: 'NAVSUP FLC',
    naicsCode: '336412',
    // ALWAYS null on a real record (D-45). Overridden explicitly where a test
    // needs to prove what WOULD happen if the provider ever supplied one.
    pscCode: null,
    setAside: 'Total Small Business',
    contractVehicle: 'To Be Determined',
    placeOfPerformance: 'Jacksonville, FL',
    primaryContactName: null,
    primaryContactEmail: null,
    primaryContactPhone: null,
    primaryContactTitle: null,
    sourceUrl: null,
    anticipatedAwardDate: new Date('2027-03-01T00:00:00Z'),
    estimatedPeriod: 'Q2 FY27',
    fiscalYear: 2027,
    sourceSystem: 'APFS',
    status: 'Forecasted',
    isActive: true,
    lastSyncedAt: new Date('2026-08-06T02:00:00Z'),
    providerModifiedAt: new Date('2026-07-30T18:20:00Z'),
    ...over,
  };
}

function signalProfile(over: Partial<ForecastSignalProfile> = {}): ForecastSignalProfile {
  return {
    naicsCodes: ['336412'],
    pscCodes: ['2840'],
    capabilityKeywords: ['turbofan', 'sustainment'],
    programElementCodes: ['0204163N'],
    priorAgencies: ['DEPT OF THE NAVY'],
    facilityStates: ['FL'],
    ...over,
  };
}

const THIN_PROFILE: ForecastSignalProfile = {
  naicsCodes: [],
  pscCodes: [],
  capabilityKeywords: [],
  programElementCodes: [],
  priorAgencies: [],
  facilityStates: [],
};

const VEHICLE_ON = { knownVehicleAccess: true, vehicleFitEnabled: true };
const VEHICLE_OFF = { knownVehicleAccess: false, vehicleFitEnabled: false };

// ── containsWholeToken ──────────────────────────────────────────────────────

describe('capability matching is a whole-token fact check, never a substring', () => {
  test('a keyword matches as a whole token run', () => {
    expect(containsWholeToken('Depot turbofan sustainment services', 'turbofan')).toBe(true);
    expect(containsWholeToken('Depot turbofan sustainment services', 'turbofan sustainment')).toBe(
      true,
    );
  });

  test('a keyword that is only a SUBSTRING of a longer word does not match', () => {
    // The whole point: "air" inside "repair" is not evidence the client does
    // aviation work, and a substring matcher would call it one.
    expect(containsWholeToken('Aircraft repair and overhaul', 'air')).toBe(false);
    expect(containsWholeToken('Millionaire outreach programme', 'air')).toBe(false);
    expect(containsWholeToken('Airport ground support', 'airport ground')).toBe(true);
  });

  test('punctuation and case do not matter, but token boundaries do', () => {
    expect(containsWholeToken('Turbofan/engine — SUSTAINMENT.', 'engine sustainment')).toBe(true);
    expect(containsWholeToken('Turbofan-engine sustainment', 'TURBOFAN ENGINE')).toBe(true);
  });

  test('a keyword of two characters or fewer never matches, however present', () => {
    // 'IT' and 'AI' appear somewhere in almost every federal description. A
    // signal that fires on almost everything reads as evidence and is not.
    expect(containsWholeToken('IT services and AI research', 'IT')).toBe(false);
    expect(containsWholeToken('IT services and AI research', 'AI')).toBe(false);
    expect(containsWholeToken('IT services and AI research', 'research')).toBe(true);
  });

  test('an empty or null side never matches', () => {
    expect(containsWholeToken(null, 'turbofan')).toBe(false);
    expect(containsWholeToken('turbofan', null)).toBe(false);
    expect(containsWholeToken('   ', 'turbofan')).toBe(false);
  });
});

// ── deriveForecastSignals ───────────────────────────────────────────────────

describe('every signal is established by EXACT comparison, or not at all', () => {
  test('an exact NAICS code matches', () => {
    const s = deriveForecastSignals(forecastRow(), signalProfile(), VEHICLE_OFF);
    expect(s.exactNaicsMatch).toBe(true);
  });

  test('a NAICS INDUSTRY-GROUP near miss is NOT a match', () => {
    // sam-opportunity-relevance.ts deliberately bands a 4-digit group as a
    // MODERATE signal for live notices. ForecastRelevanceInput's field is named
    // `exactNaicsMatch`, so scoring a near miss as one here would silently
    // redefine "exact" for the only caller P25's scorer has.
    const s = deriveForecastSignals(
      forecastRow({ naicsCode: '336413' }),
      signalProfile({ naicsCodes: ['336412'] }),
      VEHICLE_OFF,
    );
    expect(s.exactNaicsMatch).toBe(false);
  });

  test('NAICS comparison ignores punctuation and case, not digits', () => {
    const s = deriveForecastSignals(
      forecastRow({ naicsCode: ' 33-64.12 ' }),
      signalProfile({ naicsCodes: ['336412'] }),
      VEHICLE_OFF,
    );
    expect(s.exactNaicsMatch).toBe(true);
  });

  test('a forecast with no NAICS at all matches nothing rather than everything', () => {
    const s = deriveForecastSignals(
      forecastRow({ naicsCode: null }),
      signalProfile({ naicsCodes: ['336412'] }),
      VEHICLE_OFF,
    );
    expect(s.exactNaicsMatch).toBe(false);
  });

  test('a client with no NAICS recorded matches nothing rather than everything', () => {
    const s = deriveForecastSignals(forecastRow(), signalProfile({ naicsCodes: [] }), VEHICLE_OFF);
    expect(s.exactNaicsMatch).toBe(false);
  });

  test('PSC is reported UNAVAILABLE, not false, because the provider states none', () => {
    const s = deriveForecastSignals(forecastRow(), signalProfile(), VEHICLE_OFF);
    expect(s.exactPscMatch).toBe(false);
    expect(s.unavailable).toEqual(
      expect.arrayContaining([expect.objectContaining({ signal: 'exactPscMatch' })]),
    );
    // The reason names the SOURCE, never the client — "we cannot compare" is a
    // different fact from "the client's codes do not match".
    const reason = s.unavailable.find((u) => u.signal === 'exactPscMatch')!.reason;
    expect(reason).toMatch(/states no product\/service code/i);
    expect(reason).not.toMatch(/does not match/i);
  });

  test('a PSC the provider DID supply is matched exactly, and is no longer unavailable', () => {
    const s = deriveForecastSignals(
      forecastRow({ pscCode: '2840' }),
      signalProfile({ pscCodes: ['2840'] }),
      VEHICLE_OFF,
    );
    expect(s.exactPscMatch).toBe(true);
    expect(s.unavailable.map((u) => u.signal)).not.toContain('exactPscMatch');
  });

  test('a capability keyword in the DESCRIPTION counts, not only in the title', () => {
    const s = deriveForecastSignals(
      forecastRow({ title: 'Follow-on requirement', description: 'Engine overhaul services.' }),
      signalProfile({ capabilityKeywords: ['overhaul'] }),
      VEHICLE_OFF,
    );
    expect(s.capabilityMatch).toBe(true);
  });

  test('prior agency history survives the closed dept/HQ rewrite set', () => {
    const s = deriveForecastSignals(
      forecastRow({ agency: 'DEPT OF THE NAVY', departmentName: null, organizationAgencyName: null }),
      signalProfile({ priorAgencies: ['DEPARTMENT OF THE NAVY'] }),
      VEHICLE_OFF,
    );
    expect(s.priorAgencyHistory).toBe(true);
  });

  test('prior agency history is matched against EVERY hierarchy level the provider states', () => {
    const s = deriveForecastSignals(
      forecastRow({ agency: 'VA', departmentName: 'Department of Veterans Affairs' }),
      signalProfile({ priorAgencies: ['Department of Veterans Affairs'] }),
      VEHICLE_OFF,
    );
    expect(s.priorAgencyHistory).toBe(true);
  });

  test('a DIFFERENT agency is not prior history, however similar the name', () => {
    const s = deriveForecastSignals(
      forecastRow({ agency: 'DEPT OF THE ARMY', departmentName: null, organizationAgencyName: null }),
      signalProfile({ priorAgencies: ['DEPT OF THE NAVY'] }),
      VEHICLE_OFF,
    );
    expect(s.priorAgencyHistory).toBe(false);
  });

  test('a PE link needs the client’s own code VERBATIM in the forecast text', () => {
    const s = deriveForecastSignals(
      forecastRow({ description: 'Supports PE 0204163N depot maintenance.' }),
      signalProfile({ programElementCodes: ['0204163N'] }),
      VEHICLE_OFF,
    );
    expect(s.programElementLinkedSourceBacked).toBe(true);
  });

  test('a subject-matter coincidence is NOT a PE link', () => {
    // The same bar sam-opportunity-matcher.ts enforces: it caps a non-verbatim
    // match at 'quarantined' and never auto-accepts one.
    const s = deriveForecastSignals(
      forecastRow({ description: 'Depot maintenance for naval aviation.' }),
      signalProfile({ programElementCodes: ['0204163N'] }),
      VEHICLE_OFF,
    );
    expect(s.programElementLinkedSourceBacked).toBe(false);
  });

  test('a short PE-shaped string cannot fire the PE signal', () => {
    const s = deriveForecastSignals(
      forecastRow({ description: 'Task order 12 for depot work.' }),
      signalProfile({ programElementCodes: ['12'] }),
      VEHICLE_OFF,
    );
    expect(s.programElementLinkedSourceBacked).toBe(false);
  });

  test('location matches on a two-letter state the free text actually names', () => {
    const s = deriveForecastSignals(forecastRow(), signalProfile({ facilityStates: ['FL'] }), VEHICLE_OFF);
    expect(s.locationMatch).toBe(true);
  });

  test('a city name alone is not a location match — there is no geocoding here', () => {
    const s = deriveForecastSignals(
      forecastRow({ placeOfPerformance: 'Jacksonville' }),
      signalProfile({ facilityStates: ['FL'] }),
      VEHICLE_OFF,
    );
    expect(s.locationMatch).toBe(false);
  });

  test('a forecast with no place of performance has no location match', () => {
    const s = deriveForecastSignals(
      forecastRow({ placeOfPerformance: null }),
      signalProfile(),
      VEHICLE_OFF,
    );
    expect(s.locationMatch).toBe(false);
  });

  test('vehicle access is reported UNAVAILABLE when the vehicle-fit flag is off', () => {
    const s = deriveForecastSignals(forecastRow(), signalProfile(), {
      // Even if a caller passed true, a disabled flag means the value was never
      // read and must not be reported as established.
      knownVehicleAccess: true,
      vehicleFitEnabled: false,
    });
    expect(s.knownVehicleAccess).toBe(false);
    expect(s.unavailable.map((u) => u.signal)).toContain('knownVehicleAccess');
  });

  test('vehicle access is used, and no longer unavailable, when the flag is on', () => {
    const s = deriveForecastSignals(forecastRow(), signalProfile(), VEHICLE_ON);
    expect(s.knownVehicleAccess).toBe(true);
    expect(s.unavailable.map((u) => u.signal)).not.toContain('knownVehicleAccess');
  });

  test('reviewed strategic priority is ALWAYS unavailable, and never a claim about the client', () => {
    const s = deriveForecastSignals(forecastRow(), signalProfile(), VEHICLE_ON);
    expect(s.reviewedStrategicPriority).toBe(false);
    const entry = s.unavailable.find((u) => u.signal === 'reviewedStrategicPriority')!;
    expect(entry.reason).toMatch(/no reviewed strategic-priority watch list exists/i);
  });

  test('a client with nothing recorded establishes NO signal at all', () => {
    const s = deriveForecastSignals(forecastRow(), THIN_PROFILE, VEHICLE_OFF);
    expect(s.exactNaicsMatch).toBe(false);
    expect(s.exactPscMatch).toBe(false);
    expect(s.capabilityMatch).toBe(false);
    expect(s.priorAgencyHistory).toBe(false);
    expect(s.programElementLinkedSourceBacked).toBe(false);
    expect(s.locationMatch).toBe(false);
    expect(s.knownVehicleAccess).toBe(false);
  });
});

// ── toForecastRelevanceInput ────────────────────────────────────────────────

describe('the scorer input carries the signals through unchanged', () => {
  test('every derived signal reaches scoreForecastRelevance verbatim', () => {
    const facts = toInboxForecastFacts(forecastRow());
    const signals = deriveForecastSignals(forecastRow(), signalProfile(), VEHICLE_ON);
    const input = toForecastRelevanceInput(facts, signals, false, AS_OF);
    expect(input).toMatchObject({
      isActive: true,
      profileTooThin: false,
      exactNaicsMatch: true,
      capabilityMatch: true,
      priorAgencyHistory: true,
      programElementLinkedSourceBacked: false,
      locationMatch: true,
      knownVehicleAccess: true,
      reviewedStrategicPriority: false,
      anticipatedAwardDate: '2027-03-01',
      asOf: AS_OF,
    });
  });

  test('there is no eligibility and no deadline anywhere in the input', () => {
    const facts = toInboxForecastFacts(forecastRow());
    const input = toForecastRelevanceInput(facts, deriveForecastSignals(forecastRow(), signalProfile(), VEHICLE_OFF), false, AS_OF);
    expect(Object.keys(input)).not.toContain('eligibility');
    expect(Object.keys(input).join(' ')).not.toMatch(/deadline/i);
  });
});

// ── toInboxForecastFacts ────────────────────────────────────────────────────

describe('a DATE column is serialized as a date, not an instant', () => {
  test('anticipatedAwardDate renders as YYYY-MM-DD', () => {
    // toISOString() would give 2027-03-01T00:00:00.000Z, which a browser in any
    // negative-offset timezone displays as 28 February — an agency's stated
    // award month shifted by a day for every user west of Greenwich.
    expect(toInboxForecastFacts(forecastRow()).anticipatedAwardDate).toBe('2027-03-01');
  });

  test('the two genuinely-instant fields keep their full ISO form', () => {
    const facts = toInboxForecastFacts(forecastRow());
    expect(facts.lastSyncedAt).toBe('2026-08-06T02:00:00.000Z');
    expect(facts.providerModifiedAt).toBe('2026-07-30T18:20:00.000Z');
  });

  test('anticipatedSolicitationDate is an EXPLICIT null, never omitted', () => {
    const facts = toInboxForecastFacts(forecastRow());
    expect('anticipatedSolicitationDate' in facts).toBe(true);
    expect(facts.anticipatedSolicitationDate).toBeNull();
  });

  test('an unstated date stays null rather than becoming an epoch', () => {
    const facts = toInboxForecastFacts(
      forecastRow({ anticipatedAwardDate: null, providerModifiedAt: null }),
    );
    expect(facts.anticipatedAwardDate).toBeNull();
    expect(facts.providerModifiedAt).toBeNull();
  });

  test('isActive null stays null — "never stated" is not "closed"', () => {
    expect(toInboxForecastFacts(forecastRow({ isActive: null })).isActive).toBeNull();
    expect(toInboxForecastFacts(forecastRow({ isActive: false })).isActive).toBe(false);
  });
});

// ── toDecision ──────────────────────────────────────────────────────────────

describe('a decision is reported only when it carries its actor and its moment', () => {
  const base: WorkflowRow = {
    id: 'wf-1',
    workflowStatus: 'saved',
    humanDecision: 'monitor',
    decisionReason: 'Watching for the solicitation.',
    decisionAt: new Date('2026-08-01T09:00:00Z'),
    decisionByUserId: USER,
    nextAction: 'Check APFS in October',
    nextActionDueAt: new Date('2026-10-01T00:00:00Z'),
  };

  test('a complete decision round-trips', () => {
    expect(toDecision(base)).toEqual({
      decision: 'monitor',
      reason: 'Watching for the solicitation.',
      decidedAt: '2026-08-01T09:00:00.000Z',
      decidedByUserId: USER,
      nextAction: 'Check APFS in October',
      nextActionDueAt: '2026-10-01T00:00:00.000Z',
    });
  });

  test('a decision with no actor or no timestamp is reported as NO decision', () => {
    // The three-way all-or-nothing client_funding_opportunity_decision_actor_chk
    // already enforces in the database. A decision nobody can be attributed to is
    // a decision nobody can be asked about later.
    expect(toDecision({ ...base, decisionByUserId: null })).toBeNull();
    expect(toDecision({ ...base, decisionAt: null })).toBeNull();
    expect(toDecision({ ...base, humanDecision: null })).toBeNull();
  });
});

// ── The action vocabulary ───────────────────────────────────────────────────

describe('a forecast never offers pursue or submit', () => {
  test('the four offered actions are exactly the plan’s four', () => {
    expect([...FORECAST_ACTIONS]).toEqual([
      'monitor',
      'assign_research',
      'plan_capability_briefing',
      'pass',
    ]);
  });

  test('neither forbidden action appears in the offered set', () => {
    for (const forbidden of FORECAST_FORBIDDEN_ACTIONS) {
      expect(FORECAST_ACTIONS as readonly string[]).not.toContain(forbidden);
    }
  });

  test('the two offered actions that ARE decisions are real HUMAN_DECISIONS values', () => {
    // monitor and pass must be storable; assign_research and
    // plan_capability_briefing are pursuit-plan actions, not decisions.
    expect(HUMAN_DECISIONS as readonly string[]).toContain('monitor');
    expect(HUMAN_DECISIONS as readonly string[]).toContain('pass');
    expect(HUMAN_DECISIONS as readonly string[]).not.toContain('assign_research');
  });
});

// ── The service ─────────────────────────────────────────────────────────────

function makePort(
  opts: {
    forecast?: ForecastRow | null;
    visible?: string[];
    workflow?: WorkflowRow | null;
    profile?: ProfileForForecast | null;
    vehicle?: { enabled: boolean; hasAccess: boolean };
    vehicleThrows?: boolean;
  } = {},
) {
  const calls = { profile: 0, workflow: 0, visible: 0, vehicle: 0 };
  const port: ForecastReadPort = {
    readForecast: async () => (opts.forecast === undefined ? forecastRow() : opts.forecast),
    readVisibleClientIds: async () => {
      calls.visible += 1;
      return opts.visible ?? [CLIENT];
    },
    readWorkflow: async () => {
      calls.workflow += 1;
      return opts.workflow ?? null;
    },
    readProfile: async () => {
      calls.profile += 1;
      return opts.profile === undefined
        ? { signals: signalProfile(), tooThin: false, missingProfileFields: [] }
        : opts.profile;
    },
    readVehicleAccess: async () => {
      calls.vehicle += 1;
      if (opts.vehicleThrows) throw new Error('tango store unreachable');
      return opts.vehicle ?? { enabled: false, hasAccess: false };
    },
  };
  const service = new ForecastOpportunityReadService(
    {} as never,
    {} as never,
  ).withPort(port);
  return { service, calls };
}

describe('reading one forecast', () => {
  test('an empty forecast id is a 400, before any read', async () => {
    const { service } = makePort();
    await expect(service.getForecast(TENANT, USER, '   ', null, AS_OF)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('a forecast Capiro does not hold is a 404, not an empty record', async () => {
    // "We hold no such forecast" and "the agency forecast nothing" are
    // different facts, and only the first one is ever true.
    const { service } = makePort({ forecast: null });
    await expect(service.getForecast(TENANT, USER, 'FCST-404', CLIENT, AS_OF)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('the unscoped read returns source facts and NO client judgement', async () => {
    const { service, calls } = makePort();
    const out = await service.getForecast(TENANT, USER, 'FCST-1', null, AS_OF);
    expect(out.source).toBe('agency_forecast');
    expect(out.sourceRecordId).toBe('FCST-1');
    expect(out.title).toBe('Depot-level turbofan sustainment services');
    expect(out.recommendation).toBeNull();
    expect(out.decision).toBeNull();
    expect(out.clientId).toBeNull();
    expect(out.missingProfileFields).toEqual([]);
    // No client means no profile, no workflow and no wall read at all.
    expect(calls.profile).toBe(0);
    expect(calls.workflow).toBe(0);
    expect(calls.visible).toBe(0);
  });

  test('a walled or unknown clientId is DROPPED and reported as null, never 403’d', async () => {
    // A 403 would confirm the client exists, which is the one thing an ethical
    // wall is for. Same posture as the inbox's own clientId narrowing.
    const { service, calls } = makePort({ visible: [] });
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.clientId).toBeNull();
    expect(out.recommendation).toBeNull();
    expect(calls.profile).toBe(0);
    expect(calls.workflow).toBe(0);
  });

  test('a visible client gets a scored recommendation with its signal evidence', async () => {
    const { service } = makePort({ vehicle: { enabled: true, hasAccess: true } });
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.clientId).toBe(CLIENT);
    // Exact NAICS + capability match, prior agency history and vehicle access.
    expect(out.recommendation).toMatchObject({
      forecastRecommendation: 'shape_now',
      recommendationConfidence: 'high',
    });
    expect(out.recommendation!.reasonCodes).toEqual(
      expect.arrayContaining(['exact_naics_match', 'capability_match', 'prior_agency_history']),
    );
    expect(out.recommendation!.signals.knownVehicleAccess).toBe(true);
  });

  test('the common-vocabulary recommendation is NEVER pursue', async () => {
    const { service } = makePort({ vehicle: { enabled: true, hasAccess: true } });
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.recommendation!.machineRecommendation).not.toBe('pursue');
  });

  test('an inactive forecast is pass, whatever else matches', async () => {
    const { service } = makePort();
    const svc = service as unknown as { port: ForecastReadPort };
    svc.port = {
      ...svc.port,
      readForecast: async () => forecastRow({ isActive: false }),
    };
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.recommendation!.forecastRecommendation).toBe('pass');
  });

  test('a thin client profile is needs_review, not pass', async () => {
    const { service } = makePort({
      profile: { signals: THIN_PROFILE, tooThin: true, missingProfileFields: [] },
    });
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.recommendation!.forecastRecommendation).toBe('needs_review');
  });

  test('a client with no profile row at all yields no recommendation rather than a bad one', async () => {
    const { service } = makePort({ profile: null });
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.clientId).toBe(CLIENT);
    expect(out.recommendation).toBeNull();
  });

  test('a failing vehicle-access read degrades to UNAVAILABLE, not to a confident false', async () => {
    const { service } = makePort({ vehicleThrows: true });
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.recommendation).not.toBeNull();
    expect(out.recommendation!.signals.unavailable.map((u) => u.signal)).toContain(
      'knownVehicleAccess',
    );
  });

  test('an existing workflow row supplies the decision and the stage', async () => {
    const { service } = makePort({
      workflow: {
        id: 'wf-9',
        workflowStatus: 'saved',
        humanDecision: 'monitor',
        decisionReason: null,
        decisionAt: new Date('2026-08-02T00:00:00Z'),
        decisionByUserId: USER,
        nextAction: null,
        nextActionDueAt: null,
      },
    });
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect(out.workflow).toEqual({ id: 'wf-9', status: 'saved' });
    expect(out.decision!.decision).toBe('monitor');
  });

  test('the record has no eligibility, no deadline and no money field at all', async () => {
    const { service } = makePort();
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    const keys = Object.keys(out).join(' ');
    expect(keys).not.toMatch(/eligib/i);
    expect(keys).not.toMatch(/deadline/i);
    expect(keys).not.toMatch(/grantFunding|contractValue|estimatedValue/);
  });

  test('linkedOpportunity is an explicit null — "not yet linked", never "none followed"', async () => {
    const { service } = makePort();
    const out = await service.getForecast(TENANT, USER, 'FCST-1', CLIENT, AS_OF);
    expect('linkedOpportunity' in out).toBe(true);
    expect(out.linkedOpportunity).toBeNull();
  });

  test('a contact block appears only when the provider stated at least one part', async () => {
    const { service } = makePort();
    expect((await service.getForecast(TENANT, USER, 'FCST-1', null, AS_OF)).primaryContact).toBeNull();

    const withContact = makePort();
    const svc = withContact.service as unknown as { port: ForecastReadPort };
    svc.port = {
      ...svc.port,
      readForecast: async () => forecastRow({ primaryContactEmail: 'pco@navy.mil' }),
    };
    const out = await withContact.service.getForecast(TENANT, USER, 'FCST-1', null, AS_OF);
    expect(out.primaryContact).toEqual({
      name: null,
      email: 'pco@navy.mil',
      phone: null,
      title: null,
    });
  });

  test('generatedAt is the caller’s clock, never a fresh one', async () => {
    const { service } = makePort();
    const out = await service.getForecast(TENANT, USER, 'FCST-1', null, AS_OF);
    expect(out.generatedAt).toBe(AS_OF.toISOString());
  });
});

// ── Structural guarantees ───────────────────────────────────────────────────

describe('the forecast read is a READ', () => {
  const source = readFileSync(join(__dirname, 'forecast-opportunity-read.service.ts'), 'utf8');

  test('it never creates, updates or upserts anything', () => {
    expect(source).not.toMatch(/\.(create|update|upsert|delete|createMany|updateMany)\(/);
  });

  test('it never calls Tango — every read is local, per the program’s own boundary', () => {
    expect(source).not.toMatch(/tangoGateway|TANGO_GATEWAY|TangoGateway/);
  });

  test('it never invents a response deadline or an eligibility state', () => {
    // A PROPERTY, not a mention: this file's own doc explains at length why a
    // forecast has no `responseDeadline` and no `eligibility`, so a bare
    // substring search matches the explanation and proves nothing. What must
    // not exist is either name being SET or SELECTED.
    expect(source).not.toMatch(/\bresponseDeadline(Snapshot)?\s*:/);
    expect(source).not.toMatch(/\beligibility(State|Reason)?\s*:/);
    expect(source).not.toMatch(/computeEligibility|computeSamEligibility/);
  });
});
