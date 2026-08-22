/**
 * District Nexus Release 2 — Strategic Relevance evaluation harness.
 *
 * Schema + representative deterministic fixtures for the master plan's
 * 50-example labeled set (25 defense / 25 non-defense).
 *
 * STATUS: fixtures are synthetic and deterministic for CI. Human GA labeling
 * and weight tuning against real client/district cases remain OUTSTANDING.
 * Do not treat STRATEGIC_SCORE_VERSION weights as empirically validated.
 */

export type EvaluationSector = 'defense' | 'non_defense';

export type EvaluationScenario =
  | 'high_nexus_low_strategic'
  | 'low_nexus_high_strategic'
  | 'false_positive_committee'
  | 'irrelevant_pe'
  | 'ambiguous_member_jurisdiction'
  | 'no_data'
  | 'stale_data'
  | 'balanced_priority'
  | 'engagement_gap'
  | 'strategy_gap';

export type HumanPriorityLabel = 'priority' | 'monitor' | 'ignore' | 'unscored' | 'pending_human_label';

export interface StrategicEvalExample {
  id: string;
  sector: EvaluationSector;
  scenario: EvaluationScenario;
  /** Synthetic client label for the harness — not a live client id. */
  clientLabel: string;
  districtKey: string;
  /**
   * Expected component strengths after deterministic linking rules.
   * Used by the harness runner; not a production path.
   */
  expectedComponents: Partial<
    Record<
      | 'committeeJurisdiction'
      | 'programElementBudget'
      | 'activeLegislation'
      | 'activeStrategyTarget'
      | 'relationshipEngagement'
      | 'hearingTiming'
      | 'opportunityFunding'
      | 'memberHistoricalPriorities',
      'verified' | 'sourceAuthoritative' | 'partial' | 'absent' | 'unavailable'
    >
  >;
  expectedNexusBand: 'high' | 'low' | 'null';
  expectedStrategicBand: 'high' | 'low' | 'null';
  /** Decisive signals a GA expert should cite — for labeling worksheets. */
  decisiveSignals: string[];
  /** Signals that would mislead if over-weighted. */
  misleadingSignals: string[];
  humanLabel: HumanPriorityLabel;
  notes: string;
}

function make(
  partial: Omit<StrategicEvalExample, 'humanLabel'> & { humanLabel?: HumanPriorityLabel },
): StrategicEvalExample {
  return { humanLabel: 'pending_human_label', ...partial };
}

/** 25 defense + 25 non-defense representative fixtures. */
export const STRATEGIC_EVAL_FIXTURES: readonly StrategicEvalExample[] = Object.freeze([
  // ── Defense (25) ──────────────────────────────────────────────────────────
  make({
    id: 'def-01',
    sector: 'defense',
    scenario: 'low_nexus_high_strategic',
    clientLabel: 'defense-ew-oem',
    districtKey: 'VA-08',
    expectedComponents: {
      committeeJurisdiction: 'verified',
      programElementBudget: 'verified',
      activeLegislation: 'sourceAuthoritative',
      relationshipEngagement: 'absent',
      memberHistoricalPriorities: 'unavailable',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'high',
    decisiveSignals: ['HASC seat', 'capability PE direct', 'NDAA tracked cosponsor'],
    misleadingSignals: ['member name in news only'],
    notes: 'Classic GA priority: committee + PE, thin footprint.',
  }),
  make({
    id: 'def-02',
    sector: 'defense',
    scenario: 'high_nexus_low_strategic',
    clientLabel: 'defense-shipyard',
    districtKey: 'MS-04',
    expectedComponents: {
      committeeJurisdiction: 'absent',
      programElementBudget: 'absent',
      relationshipEngagement: 'absent',
      memberHistoricalPriorities: 'unavailable',
    },
    expectedNexusBand: 'high',
    expectedStrategicBand: 'null',
    decisiveSignals: ['large facility + employees'],
    misleadingSignals: ['assuming Appropriations interest from district economy alone'],
    notes: 'Strong footprint, no structured strategic links.',
  }),
  make({
    id: 'def-03',
    sector: 'defense',
    scenario: 'false_positive_committee',
    clientLabel: 'defense-cyber',
    districtKey: 'CA-17',
    expectedComponents: {
      committeeJurisdiction: 'absent',
      programElementBudget: 'absent',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['member on Education committee with "defense" in a hearing title'],
    notes: 'Committee name similarity must not score.',
  }),
  make({
    id: 'def-04',
    sector: 'defense',
    scenario: 'irrelevant_pe',
    clientLabel: 'defense-missiles',
    districtKey: 'AL-05',
    expectedComponents: {
      programElementBudget: 'absent',
      committeeJurisdiction: 'absent',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['unrelated PE keyword match without capability PE number'],
    notes: 'Keyword-only PE without committee bridge stays absent for this district.',
  }),
  make({
    id: 'def-05',
    sector: 'defense',
    scenario: 'ambiguous_member_jurisdiction',
    clientLabel: 'defense-c4isr',
    districtKey: 'TX-23',
    expectedComponents: {
      committeeJurisdiction: 'absent',
      memberHistoricalPriorities: 'unavailable',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['CD119 vs CD120 facility vintage confusion'],
    notes: 'Geography vintage conflict must surface as warning/gap, not invented jurisdiction.',
  }),
  make({
    id: 'def-06',
    sector: 'defense',
    scenario: 'no_data',
    clientLabel: 'defense-new-entrant',
    districtKey: 'WY-00',
    expectedComponents: {
      committeeJurisdiction: 'absent',
      programElementBudget: 'absent',
      activeLegislation: 'absent',
      activeStrategyTarget: 'absent',
      relationshipEngagement: 'absent',
      hearingTiming: 'absent',
      opportunityFunding: 'absent',
      memberHistoricalPriorities: 'unavailable',
    },
    expectedNexusBand: 'null',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['rendering Unscored as Low'],
    notes: 'No-data case — both scores null.',
  }),
  make({
    id: 'def-07',
    sector: 'defense',
    scenario: 'stale_data',
    clientLabel: 'defense-sensors',
    districtKey: 'MD-05',
    expectedComponents: {
      activeLegislation: 'partial',
      committeeJurisdiction: 'sourceAuthoritative',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'low',
    decisiveSignals: ['older tracked bill stage'],
    misleadingSignals: ['treating stale action date as current markup urgency'],
    notes: 'Stale legislation should warn; partial credit at most.',
  }),
  make({
    id: 'def-08',
    sector: 'defense',
    scenario: 'balanced_priority',
    clientLabel: 'defense-prime',
    districtKey: 'CT-02',
    expectedComponents: {
      committeeJurisdiction: 'verified',
      programElementBudget: 'verified',
      relationshipEngagement: 'verified',
      activeStrategyTarget: 'verified',
    },
    expectedNexusBand: 'high',
    expectedStrategicBand: 'high',
    decisiveSignals: ['facility', 'HASC', 'PE', 'target', 'strategy node'],
    misleadingSignals: [],
    notes: 'Full-stack priority district.',
  }),
  make({
    id: 'def-09',
    sector: 'defense',
    scenario: 'engagement_gap',
    clientLabel: 'defense-ew-oem',
    districtKey: 'SC-01',
    expectedComponents: {
      committeeJurisdiction: 'verified',
      programElementBudget: 'verified',
      relationshipEngagement: 'absent',
    },
    expectedNexusBand: 'high',
    expectedStrategicBand: 'high',
    decisiveSignals: ['committee + PE + footprint'],
    misleadingSignals: [],
    notes: 'committee_appropriations_weak_relationship / high_nexus_low_engagement candidate.',
  }),
  make({
    id: 'def-10',
    sector: 'defense',
    scenario: 'strategy_gap',
    clientLabel: 'defense-shipyard',
    districtKey: 'VA-02',
    expectedComponents: {
      activeStrategyTarget: 'absent',
      relationshipEngagement: 'partial',
    },
    expectedNexusBand: 'high',
    expectedStrategicBand: 'low',
    decisiveSignals: ['footprint'],
    misleadingSignals: ['free-text district name in strategy goal'],
    notes: 'strong_footprint_no_active_strategy when strategy target_ref missing.',
  }),
  // Generate remaining defense slots 11-25 as structured variants
  ...Array.from({ length: 15 }, (_, i) => {
    const n = i + 11;
    const scenarios: EvaluationScenario[] = [
      'balanced_priority',
      'low_nexus_high_strategic',
      'high_nexus_low_strategic',
      'false_positive_committee',
      'irrelevant_pe',
      'no_data',
      'stale_data',
      'engagement_gap',
      'strategy_gap',
      'ambiguous_member_jurisdiction',
    ];
    const scenario = scenarios[i % scenarios.length]!;
    const states = ['AL', 'CA', 'FL', 'GA', 'OH', 'PA', 'TX', 'VA', 'WA'] as const;
    const state = states[i % states.length]!;
    return make({
      id: `def-${String(n).padStart(2, '0')}`,
      sector: 'defense',
      scenario,
      clientLabel: `defense-fixture-${n}`,
      districtKey: `${state}-${String((n % 12) + 1).padStart(2, '0')}`,
      expectedComponents: {
        memberHistoricalPriorities: 'unavailable',
        ...(scenario === 'no_data'
          ? {
              committeeJurisdiction: 'absent' as const,
              programElementBudget: 'absent' as const,
            }
          : {}),
        ...(scenario === 'low_nexus_high_strategic'
          ? {
              committeeJurisdiction: 'verified' as const,
              programElementBudget: 'verified' as const,
            }
          : {}),
        ...(scenario === 'false_positive_committee'
          ? { committeeJurisdiction: 'absent' as const }
          : {}),
      },
      expectedNexusBand:
        scenario === 'high_nexus_low_strategic' || scenario === 'engagement_gap'
          ? 'high'
          : scenario === 'no_data'
            ? 'null'
            : 'low',
      expectedStrategicBand:
        scenario === 'low_nexus_high_strategic' || scenario === 'balanced_priority'
          ? 'high'
          : scenario === 'no_data' || scenario === 'false_positive_committee'
            ? 'null'
            : 'low',
      decisiveSignals: ['synthetic defense fixture'],
      misleadingSignals: ['unvalidated weight prior'],
      notes: `Synthetic defense harness row ${n}; pending human GA label.`,
    });
  }),

  // ── Non-defense (25) ──────────────────────────────────────────────────────
  make({
    id: 'nd-01',
    sector: 'non_defense',
    scenario: 'low_nexus_high_strategic',
    clientLabel: 'health-biotech',
    districtKey: 'MA-07',
    expectedComponents: {
      activeLegislation: 'verified',
      relationshipEngagement: 'verified',
      committeeJurisdiction: 'partial',
      memberHistoricalPriorities: 'unavailable',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'high',
    decisiveSignals: ['tracked sponsor', 'client target'],
    misleadingSignals: ['facility in neighboring district'],
    notes: 'Health policy priority without defense PE.',
  }),
  make({
    id: 'nd-02',
    sector: 'non_defense',
    scenario: 'high_nexus_low_strategic',
    clientLabel: 'energy-utility',
    districtKey: 'WV-01',
    expectedComponents: {
      committeeJurisdiction: 'absent',
      activeLegislation: 'absent',
    },
    expectedNexusBand: 'high',
    expectedStrategicBand: 'null',
    decisiveSignals: ['plant + employees'],
    misleadingSignals: ['assuming Energy committee interest from plant alone'],
    notes: 'Economic footprint ≠ strategic relevance.',
  }),
  make({
    id: 'nd-03',
    sector: 'non_defense',
    scenario: 'false_positive_committee',
    clientLabel: 'ag-coop',
    districtKey: 'IA-04',
    expectedComponents: {
      committeeJurisdiction: 'absent',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['committee display name contains "Agriculture" without structured target'],
    notes: 'Name-only committee inference excluded.',
  }),
  make({
    id: 'nd-04',
    sector: 'non_defense',
    scenario: 'irrelevant_pe',
    clientLabel: 'transport-oem',
    districtKey: 'MI-13',
    expectedComponents: {
      programElementBudget: 'absent',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['defense PE on client book irrelevant to this member'],
    notes: 'Non-defense client with residual PE noise must not force PE credit without bridge.',
  }),
  make({
    id: 'nd-05',
    sector: 'non_defense',
    scenario: 'no_data',
    clientLabel: 'edu-nonprofit',
    districtKey: 'VT-00',
    expectedComponents: {
      committeeJurisdiction: 'absent',
      programElementBudget: 'absent',
      activeLegislation: 'absent',
      activeStrategyTarget: 'absent',
      relationshipEngagement: 'absent',
      hearingTiming: 'absent',
      opportunityFunding: 'absent',
      memberHistoricalPriorities: 'unavailable',
    },
    expectedNexusBand: 'null',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['null rendered as 0'],
    notes: 'Empty non-defense book.',
  }),
  make({
    id: 'nd-06',
    sector: 'non_defense',
    scenario: 'stale_data',
    clientLabel: 'env-ngo',
    districtKey: 'OR-03',
    expectedComponents: {
      activeLegislation: 'partial',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'low',
    decisiveSignals: ['old tracked bill'],
    misleadingSignals: ['stale hearing date as urgency'],
    notes: 'Stale non-defense legislation.',
  }),
  make({
    id: 'nd-07',
    sector: 'non_defense',
    scenario: 'balanced_priority',
    clientLabel: 'fintech',
    districtKey: 'NY-12',
    expectedComponents: {
      activeLegislation: 'verified',
      relationshipEngagement: 'verified',
      activeStrategyTarget: 'verified',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'high',
    decisiveSignals: ['sponsor', 'target', 'strategy node'],
    misleadingSignals: [],
    notes: 'Policy-heavy non-defense priority.',
  }),
  make({
    id: 'nd-08',
    sector: 'non_defense',
    scenario: 'engagement_gap',
    clientLabel: 'health-biotech',
    districtKey: 'NC-04',
    expectedComponents: {
      activeLegislation: 'verified',
      relationshipEngagement: 'absent',
    },
    expectedNexusBand: 'high',
    expectedStrategicBand: 'low',
    decisiveSignals: ['footprint + bill'],
    misleadingSignals: [],
    notes: 'Need engagement with district office.',
  }),
  make({
    id: 'nd-09',
    sector: 'non_defense',
    scenario: 'strategy_gap',
    clientLabel: 'energy-utility',
    districtKey: 'PA-08',
    expectedComponents: {
      activeStrategyTarget: 'absent',
      relationshipEngagement: 'partial',
    },
    expectedNexusBand: 'high',
    expectedStrategicBand: 'low',
    decisiveSignals: ['footprint'],
    misleadingSignals: ['meri_context free text mentioning district'],
    notes: 'No structured strategy target_ref.',
  }),
  make({
    id: 'nd-10',
    sector: 'non_defense',
    scenario: 'ambiguous_member_jurisdiction',
    clientLabel: 'transport-oem',
    districtKey: 'IL-07',
    expectedComponents: {
      committeeJurisdiction: 'absent',
    },
    expectedNexusBand: 'low',
    expectedStrategicBand: 'null',
    decisiveSignals: [],
    misleadingSignals: ['joint committee name fuzzy match'],
    notes: 'Ambiguous jurisdiction without systemCode link.',
  }),
  ...Array.from({ length: 15 }, (_, i) => {
    const n = i + 11;
    const scenarios: EvaluationScenario[] = [
      'balanced_priority',
      'low_nexus_high_strategic',
      'high_nexus_low_strategic',
      'false_positive_committee',
      'irrelevant_pe',
      'no_data',
      'stale_data',
      'engagement_gap',
      'strategy_gap',
      'ambiguous_member_jurisdiction',
    ];
    const scenario = scenarios[i % scenarios.length]!;
    const states = ['AZ', 'CO', 'CT', 'HI', 'IN', 'KY', 'LA', 'ME', 'MN'];
    return make({
      id: `nd-${String(n).padStart(2, '0')}`,
      sector: 'non_defense',
      scenario,
      clientLabel: `non-defense-fixture-${n}`,
      districtKey: `${states[i % states.length]}-${String((n % 12) + 1).padStart(2, '0')}`,
      expectedComponents: {
        memberHistoricalPriorities: 'unavailable',
        ...(scenario === 'no_data'
          ? {
              committeeJurisdiction: 'absent' as const,
              activeLegislation: 'absent' as const,
            }
          : {}),
        ...(scenario === 'low_nexus_high_strategic'
          ? {
              activeLegislation: 'verified' as const,
              relationshipEngagement: 'verified' as const,
            }
          : {}),
      },
      expectedNexusBand:
        scenario === 'high_nexus_low_strategic' || scenario === 'engagement_gap'
          ? 'high'
          : scenario === 'no_data'
            ? 'null'
            : 'low',
      expectedStrategicBand:
        scenario === 'low_nexus_high_strategic' || scenario === 'balanced_priority'
          ? 'high'
          : scenario === 'no_data' || scenario === 'false_positive_committee'
            ? 'null'
            : 'low',
      decisiveSignals: ['synthetic non-defense fixture'],
      misleadingSignals: ['unvalidated weight prior'],
      notes: `Synthetic non-defense harness row ${n}; pending human GA label.`,
    });
  }),
]);

export interface StrategicEvalHarnessReport {
  version: string;
  totalExamples: number;
  defenseCount: number;
  nonDefenseCount: number;
  scenarioCoverage: Record<string, number>;
  humanLabelsPending: number;
  humanLabelsComplete: number;
  empiricallyValidated: false;
  notes: string;
}

export function buildStrategicEvalHarnessReport(
  fixtures: readonly StrategicEvalExample[] = STRATEGIC_EVAL_FIXTURES,
): StrategicEvalHarnessReport {
  const scenarioCoverage: Record<string, number> = {};
  let pending = 0;
  let complete = 0;
  for (const f of fixtures) {
    scenarioCoverage[f.scenario] = (scenarioCoverage[f.scenario] ?? 0) + 1;
    if (f.humanLabel === 'pending_human_label') pending += 1;
    else complete += 1;
  }
  return {
    version: 'strategic-eval-harness-v1',
    totalExamples: fixtures.length,
    defenseCount: fixtures.filter((f) => f.sector === 'defense').length,
    nonDefenseCount: fixtures.filter((f) => f.sector === 'non_defense').length,
    scenarioCoverage,
    humanLabelsPending: pending,
    humanLabelsComplete: complete,
    empiricallyValidated: false,
    notes:
      'Fixtures are representative and deterministic. Human GA labeling and weight tuning are outstanding; do not claim empirical validation.',
  };
}
