/**
 * Blueprint picker catalog. Seven templates are published for the picker; only
 * Hill Day Schedule is implemented — the rest route to the existing placeholder
 * (requirements §3 step 1, §10). Firm-scope blueprints published in Template
 * Studio are appended at read time by the document service.
 */
export interface HillDayBlueprint {
  id: string;
  slug: string;
  name: string;
  description: string;
  meta: string;
  icon: string;
  sources: string[];
  stepCount: number;
  scope: 'global' | 'firm';
  implemented: boolean;
  isNew: boolean;
}

export const HILL_DAY_BLUEPRINT_SLUG = 'hill-day-schedule';
export const HILL_DAY_BLUEPRINT_ID = 'bp_hill_day_schedule';
export const HILL_DAY_BLUEPRINT_NAME = 'Hill Day Schedule';

export const BLUEPRINT_CATALOG: readonly HillDayBlueprint[] = [
  {
    id: HILL_DAY_BLUEPRINT_ID,
    slug: HILL_DAY_BLUEPRINT_SLUG,
    name: HILL_DAY_BLUEPRINT_NAME,
    description:
      'One context-rich prep section per congressional meeting, assembled from the sponsor’s calendar.',
    meta: '6 steps · Meri drafts Focus and Background',
    icon: 'CalendarCheck01',
    sources: ['Calendar', 'Directory', 'Portfolio', 'Intelligence'],
    stepCount: 6,
    scope: 'global',
    implemented: true,
    isNew: true,
  },
  {
    id: 'bp_client_strategy_brief',
    slug: 'client-strategy-brief',
    name: 'Client strategy brief',
    description: 'Recommendation, funding position, plan of action, risks and decision gates.',
    meta: '5 steps · quarterly cadence',
    icon: 'Diamond01',
    sources: ['Portfolio', 'Strategies', 'LegiWatch'],
    stepCount: 5,
    scope: 'global',
    implemented: false,
    isNew: false,
  },
  {
    id: 'bp_meeting_prep',
    slug: 'meeting-prep',
    name: 'Meeting prep',
    description:
      'A single office, briefed from the Directory record and the member’s legislative history.',
    meta: '3 steps',
    icon: 'ClipboardCheck',
    sources: ['Directory', 'Intelligence'],
    stepCount: 3,
    scope: 'global',
    implemented: false,
    isNew: false,
  },
  {
    id: 'bp_coalition_memo',
    slug: 'coalition-memo',
    name: 'Coalition memo',
    description: 'Shared position, member-by-member status and the next action per office.',
    meta: '4 steps · firm scope',
    icon: 'Users01',
    sources: ['Portfolio', 'Directory'],
    stepCount: 4,
    scope: 'global',
    implemented: false,
    isNew: false,
  },
  {
    id: 'bp_testimony_prep',
    slug: 'testimony-prep',
    name: 'Testimony prep',
    description:
      'Written and oral testimony drafted from the record and the member’s own framing.',
    meta: '4 steps · hearing cycle',
    icon: 'ClipboardCheck',
    sources: ['Directory', 'Intelligence'],
    stepCount: 4,
    scope: 'global',
    implemented: false,
    isNew: false,
  },
  {
    id: 'bp_quarterly_client_report',
    slug: 'quarterly-client-report',
    name: 'Quarterly client report',
    description: 'Activity, outcomes and position across the client’s full portfolio.',
    meta: '4 steps · quarterly cadence',
    icon: 'BarChartSquare02',
    sources: ['Portfolio', 'Engagement'],
    stepCount: 4,
    scope: 'global',
    implemented: false,
    isNew: false,
  },
  {
    id: 'bp_client_onboarding_brief',
    slug: 'client-onboarding-brief',
    name: 'Client onboarding brief',
    description: 'Who the client is, what they build, and how the firm will represent them.',
    meta: '3 steps · firm scope',
    icon: 'File04',
    sources: ['Portfolio', 'Directory'],
    stepCount: 3,
    scope: 'global',
    implemented: false,
    isNew: false,
  },
];

export function findBlueprint(idOrSlug: string): HillDayBlueprint | null {
  const key = idOrSlug.trim().toLowerCase();
  return (
    BLUEPRINT_CATALOG.find((b) => b.id.toLowerCase() === key || b.slug === key) ?? null
  );
}
