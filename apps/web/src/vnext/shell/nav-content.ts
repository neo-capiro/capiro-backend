/**
 * Static navigation copy from Figma (`820:2629`, `727:2588`).
 *
 * Deliberately free of data-layer imports: shell presentation components must
 * stay renderable in the Clerk-free visual harness, which never boots `env.ts`.
 */
export const SHELL_NAV_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'engagement-meetings': 'Calendar, prep, notes and debriefs',
  'engagement-library': 'Approved meeting artifacts across clients',
  'engagement-outreach': 'Governed targeting, drafts and delivery',
  'engagement-reports': 'Office activity, overrides and follow-up',
  'congressional-staff': 'Members, personal offices & staff',
  'committee-staff': 'Authorizing & appropriations staff',
  'department-of-war': 'Pentagon leadership & acquisition officials',
  'state-legislators': 'Statehouse chambers, members & sponsorship',
  'state-committees': 'Florida legislative committees, rosters & proceedings',
  'data-explorer': 'Cross-entity query and export',
  legiwatch: 'Federal and state legislative monitoring',
  'program-elements': 'Budget lines, funding and lifecycle',
  'funding-opportunities': 'Solicitations matched to your portfolio',
  'district-nexus': 'Geographic and district-level context',
};
