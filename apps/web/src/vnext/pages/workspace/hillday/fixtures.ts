/**
 * Hill Day module — static UI copy only.
 *
 * The prototype's sample data (meetings, staffers, threads, library rows) used
 * to live here while the backend was unbuilt. It is gone on purpose: every
 * read now comes from `/workspace-api/hillday/*` (see api.ts), and a source
 * that fails renders as unavailable — never as sample data (requirements §1).
 */

/** What the sponsoring client supplies (step 2 sidebar). */
export const SPONSOR_SUPPLIES = [
  {
    title: 'Calendar scope',
    body: 'Only events associated with this client’s people surface in the picker.',
  },
  {
    title: 'Objectives',
    body: 'Focus is written against the client’s Portfolio objectives and live Strategies.',
  },
  {
    title: 'Engagement history',
    body: 'Prior meetings with each office, and what was promised in them.',
  },
  {
    title: 'Branding',
    body: 'Client logo from the Portfolio profile, alongside the firm mark.',
  },
] as const;

export const DOW_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export const DAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Correspondence lookback windows offered in step 5. */
export const LOOKBACK_OPTIONS = [30, 60, 90, 180, 365] as const;
