import { assembleCard, type AssembleCardFacts } from './action-card-assembly.js';
import type { ActionType } from './action-recommendation.types.js';

function baseFacts(overrides: Partial<AssembleCardFacts> = {}): AssembleCardFacts {
  return {
    actionType: 'protect_funding',
    clientName: 'Acme Defense Systems',
    peCode: '0603270F',
    peTitle: 'Electronic Warfare Development',
    programName: 'EW Development',
    delta: {
      deltaType: 'mark_vs_request',
      amountFrom: 120.5,
      amountTo: 145.0,
      deltaPct: 20.3,
      assertedFy: 2026,
      stageFrom: 'request',
      stageTo: 'hascMark',
    },
    relevancePaths: [
      { path: 'capability_pe_direct', evidence: ['client capability names PE 0603270F'] },
    ],
    deadline: '2026-07-15',
    deadlineSource: 'markup_window',
    ...overrides,
  };
}

describe('action-card-assembly (§10 deterministic narrative)', () => {
  test('a protect_funding card for a mark increase carries $ figures, stage + vehicle, FY and client name', () => {
    const card = assembleCard(baseFacts());

    // whatChanged carries the objective fact, all from inputs — stage labeled
    // with its legislative vehicle so the mark can never be read as money.
    expect(card.whatChanged).toBe(
      'Electronic Warfare Development (PE 0603270F) increased from $120.5M to $145M ' +
        '(+20%) in the HASC mark (authorization) position for FY26.',
    );

    // Figures come only from inputs — none invented.
    expect(card.whatChanged).toContain('$120.5M');
    expect(card.whatChanged).toContain('$145M');
    expect(card.whatChanged).toContain('FY26');

    // whyItMatters cites the client + the relevance path evidence.
    expect(card.whyItMatters).toContain('Acme Defense Systems');
    expect(card.whyItMatters).toContain('client capability names PE 0603270F');

    // recommendedAction and title reflect the action type.
    expect(card.issueTitle).toMatch(/Protect/i);
    expect(card.recommendedAction).toContain('FY26');
    expect(card.recommendedAction).toContain('2026-07-15');
    expect(card.suggestedArtifactType).toBe('committee_staff_memo');
  });

  test('renders an appropriations-mark decrease with the appropriations vehicle', () => {
    const card = assembleCard(
      baseFacts({
        actionType: 'restore_cut',
        delta: {
          deltaType: 'mark_vs_request',
          amountFrom: 200,
          amountTo: 150,
          deltaPct: -25,
          assertedFy: 2026,
          stageFrom: 'request',
          stageTo: 'sacDMark',
        },
      }),
    );
    expect(card.whatChanged).toContain('decreased from $200M to $150M');
    expect(card.whatChanged).toContain('(-25%)');
    expect(card.whatChanged).toContain('SAC-D mark (appropriations)');
  });

  test("the 'conference' delta ref is the NDAA conference report — authorization, never appropriations", () => {
    const card = assembleCard(
      baseFacts({
        delta: {
          deltaType: 'conference_vs_marks',
          amountFrom: 57.2,
          amountTo: 51.5,
          deltaPct: -10,
          assertedFy: 2027,
          stageFrom: 'hascMark',
          stageTo: 'conference',
        },
      }),
    );
    expect(card.whatChanged).toContain('NDAA conference report (authorization)');
    expect(card.whatChanged).not.toContain('appropriations');
  });

  test('quantity_change renders unit COUNTS, never dollars', () => {
    const card = assembleCard(
      baseFacts({
        actionType: 'client_alert',
        delta: {
          deltaType: 'quantity_change',
          amountFrom: 150,
          amountTo: 200,
          deltaPct: 33.3,
          assertedFy: 2027,
          stageFrom: 'fy2026:Airframe',
          stageTo: 'fy2027:Airframe',
        },
      }),
    );
    expect(card.whatChanged).toContain('procurement quantity for "Airframe"');
    expect(card.whatChanged).toContain('from 150 to 200 units');
    expect(card.whatChanged).not.toContain('$'); // a quantity is never money
  });

  test('unit_cost_change never claims $ millions (as-printed exhibit values)', () => {
    const card = assembleCard(
      baseFacts({
        actionType: 'client_alert',
        delta: {
          deltaType: 'unit_cost_change',
          amountFrom: 80_000,
          amountTo: 95_000,
          deltaPct: 18.75,
          assertedFy: 2027,
          stageFrom: 'fy2026:Airframe',
          stageTo: 'fy2027:Airframe',
        },
      }),
    );
    expect(card.whatChanged).toContain('unit cost for "Airframe" increased +19%');
    expect(card.whatChanged).toContain('units as published, not normalized to $ millions');
    expect(card.whatChanged).not.toContain('$80'); // never rendered as a $M figure
  });

  test('new_start and termination read as PB-cycle events, not congressional action', () => {
    const start = assembleCard(
      baseFacts({
        delta: {
          deltaType: 'new_start',
          amountFrom: 0,
          amountTo: 42.5,
          deltaPct: 0,
          assertedFy: 2027,
          stageTo: 'request',
        },
      }),
    );
    expect(start.whatChanged).toContain("NEW START at $42.5M in the President's request position");

    const term = assembleCard(
      baseFacts({
        delta: {
          deltaType: 'termination',
          amountFrom: 33.1,
          amountTo: 0,
          deltaPct: 0,
          assertedFy: 2027,
          stageFrom: 'pb_prior',
        },
      }),
    );
    expect(term.whatChanged).toContain("$33.1M in the prior President's Budget position");
    expect(term.whatChanged).toContain('now absent from the current President');
  });

  test('transfer_candidate is hedged as a candidate, never asserted', () => {
    const card = assembleCard(
      baseFacts({
        delta: {
          deltaType: 'transfer_candidate',
          amountFrom: 30,
          amountTo: 31,
          deltaPct: 0,
          assertedFy: 2027,
          stageFrom: '0604999A',
          stageTo: '0605000A',
        },
      }),
    );
    expect(card.whatChanged).toContain('PE 0604999A was terminated');
    expect(card.whatChanged).toContain('POSSIBLE transfer');
    expect(card.whatChanged).toContain('not an asserted fact');
  });

  test('a deadline-less card says "no known deadline" and never invents a date', () => {
    const card = assembleCard(baseFacts({ deadline: null, deadlineSource: null }));
    expect(card.recommendedAction).toContain('no known deadline');
    expect(card.recommendedAction).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test('only facts appear — the client name and PE are never fabricated', () => {
    const card = assembleCard(
      baseFacts({ clientName: 'Beta Corp', peCode: '0604999N', peTitle: 'Some Program' }),
    );
    expect(card.whatChanged).toContain('Some Program');
    expect(card.whatChanged).toContain('0604999N');
    expect(card.whyItMatters).toContain('Beta Corp');
    expect(card.whatChanged).not.toContain('Acme');
  });

  test('each actionType yields a distinct recommendedAction', () => {
    const types: ActionType[] = [
      'protect_funding',
      'restore_cut',
      'add_report_language',
      'oppose_restriction',
      'district_one_pager',
      'monitor_procurement',
      'client_alert',
      'schedule_outreach',
      'escalate_uncertainty',
      'update_compliance_notes',
    ];
    const actions = types.map((t) => assembleCard(baseFacts({ actionType: t })).recommendedAction);
    expect(new Set(actions).size).toBe(types.length);
  });

  test('escalate_uncertainty instructs not to contact anyone yet', () => {
    const card = assembleCard(baseFacts({ actionType: 'escalate_uncertainty' }));
    expect(card.recommendedAction).toMatch(/do not contact/i);
    expect(card.recommendedAction).toMatch(/confirm the program match/i);
  });

  test('handles a string FY (e.g. "FY2026") and empty relevance paths gracefully', () => {
    const card = assembleCard(
      baseFacts({
        delta: {
          deltaType: 'mark_increase',
          amountFrom: 10,
          amountTo: 12,
          deltaPct: 20,
          assertedFy: 'FY2026',
          stageTo: 'house_mark',
        },
        relevancePaths: [],
      }),
    );
    expect(card.whatChanged).toContain('FY26');
    expect(card.whyItMatters).toContain('Acme Defense Systems');
    expect(card.whyItMatters).toContain('tracked interest');
  });
});
