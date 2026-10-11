/** Business Development owns this vocabulary. Legacy values remain readable
 * and writable by legacy callers until the human supplies a migration mapping. */
export const LEGACY_PROSPECT_STAGES = [
  'researching',
  'qualified',
  'outreach',
  'meeting',
  'proposal',
  'won',
  'lost',
  'parked',
] as const;
export const PORTFOLIO_PROSPECT_STAGES = [
  { value: 'identified', label: 'Identified' },
  { value: 'initiated', label: 'Initiated' },
  { value: 'engaged', label: 'Engaged' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'closed_won', label: 'Closed won' },
  { value: 'closed_lost', label: 'Closed lost' },
] as const;
export const BIZDEV_STAGES = [
  ...new Set([...LEGACY_PROSPECT_STAGES, ...PORTFOLIO_PROSPECT_STAGES.map((stage) => stage.value)]),
];
export type BizDevStage = (typeof BIZDEV_STAGES)[number];
export function isPortfolioProspectStage(stage: string): boolean {
  return PORTFOLIO_PROSPECT_STAGES.some((item) => item.value === stage);
}
export function prospectStageCatalog() {
  return {
    version: 'portfolio-3.1',
    createStage: 'identified',
    legacyMapping: 'pending',
    allowLegacyTransitions: false,
    stages: PORTFOLIO_PROSPECT_STAGES,
  } as const;
}
