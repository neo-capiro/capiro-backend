/**
 * Data Explorer vNext — the 18 data sources, in canonical order.
 *
 * Keys, labels and descriptions are copied verbatim from
 * `pages/explorer/DataExplorerPage.tsx`. Keys are load-bearing: `?source=<key>`
 * deep links (Dashboard "Needs Attention" → comment-deadlines, alert emails,
 * saved URLs) must resolve to the same tab on both surfaces.
 */

export type SourceKey =
  | 'lda'
  | 'contractors'
  | 'bills'
  | 'fedreg'
  | 'hearings'
  | 'gao'
  | 'crs'
  | 'fec'
  | 'fara'
  | 'sec'
  | 'sam-opps'
  | 'federal-awards'
  | 'federal-assistance-awards'
  | 'federal-grants'
  | 'state-legislators'
  | 'articles'
  | 'state-bills'
  | 'comment-deadlines';

export interface SourceMeta {
  key: SourceKey;
  label: string;
  description: string;
}

export const SOURCES: SourceMeta[] = [
  { key: 'articles', label: 'News Feed', description: 'Latest coverage from Politico, Roll Call, The Hill and other tracked outlets.' },
  { key: 'lda', label: 'LDA Filings', description: 'Lobbying Disclosure Act, 500K+ filings, 5 years.' },
  { key: 'contractors', label: 'Federal Contractors', description: 'Top contractors with no-bid totals + agency mix.' },
  { key: 'bills', label: 'Congress Bills', description: 'Bills with sponsor, latest action, subject tags.' },
  { key: 'fedreg', label: 'Federal Register', description: 'Proposed/final rules, comment-period deadlines.' },
  { key: 'hearings', label: 'Hearings', description: 'Committee hearings and markups by chamber + date.' },
  { key: 'gao', label: 'GAO Reports', description: 'GAO oversight reports + recommendations by topic.' },
  { key: 'crs', label: 'CRS Reports', description: 'Congressional Research Service briefings.' },
  { key: 'fec', label: 'FEC Contributions', description: 'Itemized political contributions, by cycle.' },
  { key: 'fara', label: 'FARA Filings', description: 'Foreign agent registrations by country/principal.' },
  { key: 'sec', label: 'SEC Filings', description: '8-K, 10-Q, S-1 from SEC EDGAR.' },
  { key: 'sam-opps', label: 'SAM.gov Opportunities', description: 'DoD contract opportunities & solicitations from SAM.gov.' },
  // Source keys are deep-linked — only the labels change here. "Federal Grants"
  // read as awarded money; this source is Grants.gov OPPORTUNITIES (NOFOs).
  // Awarded federal assistance is a separate source (Workstream I).
  { key: 'federal-awards', label: 'Federal Contract Awards (DoD)', description: 'USAspending contract award line items — agency, contractor, amount. DoD scope.' },
  { key: 'federal-assistance-awards', label: 'Federal Grant Awards', description: 'USAspending awarded grants and cooperative agreements — recipient, UEI, Assistance Listing, obligated vs outlayed. Awarded money, not opportunities.' },
  { key: 'federal-grants', label: 'Grant Opportunities', description: 'Grants.gov funding opportunities (NOFOs) by agency, deadline, ceiling — not awarded money.' },
  { key: 'state-bills', label: 'State Bills', description: 'State legislation via LegiScan.' },
  { key: 'state-legislators', label: 'State Legislators', description: 'State house & senate members by state, chamber, party.' },
  { key: 'comment-deadlines', label: 'Comment Deadlines', description: 'Open comment periods on federal rules, closing soonest.' },
];

export function isSourceKey(value: string | null): value is SourceKey {
  return value != null && SOURCES.some((s) => s.key === value);
}
