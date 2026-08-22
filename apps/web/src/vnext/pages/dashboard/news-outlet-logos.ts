/**
 * Dashboard Wire outlet marks for the shared intel_article corpus.
 *
 * Source values come from apps/api/scripts/sync-rss-intel.ts (`source` slugs).
 * Logos are Google's public favicon service (s2) against each outlet's
 * canonical domain — no first-party asset pack and no backend change. A
 * failed load falls back to initials in the Wire row.
 */

export interface NewsOutletMark {
  /** Human label shown next to the mark (e.g. "The Hill"). */
  label: string;
  /** Favicon URL, or null when we only know initials. */
  logoUrl: string | null;
}

/** Canonical slug → display name + homepage domain used for the favicon. */
const OUTLETS: Readonly<Record<string, { label: string; domain: string }>> = {
  roll_call: { label: 'Roll Call', domain: 'rollcall.com' },
  the_hill: { label: 'The Hill', domain: 'thehill.com' },
  politico: { label: 'Politico', domain: 'politico.com' },
  politico_congress: { label: 'Politico Congress', domain: 'politico.com' },
  axios: { label: 'Axios', domain: 'axios.com' },
  reuters_politics: { label: 'Reuters', domain: 'reuters.com' },
  dod: { label: 'DoD', domain: 'defense.gov' },
  hhs: { label: 'HHS', domain: 'hhs.gov' },
  usda: { label: 'USDA', domain: 'usda.gov' },
  doj: { label: 'DOJ', domain: 'justice.gov' },
  state_dept: { label: 'State Dept', domain: 'state.gov' },
  commerce: { label: 'Commerce', domain: 'commerce.gov' },
  va: { label: 'VA', domain: 'va.gov' },
  doe: { label: 'DOE', domain: 'energy.gov' },
  dhs: { label: 'DHS', domain: 'dhs.gov' },
  heritage: { label: 'Heritage', domain: 'heritage.org' },
  urban: { label: 'Urban Institute', domain: 'urban.org' },
  cato: { label: 'Cato', domain: 'cato.org' },
  brookings: { label: 'Brookings', domain: 'brookings.edu' },
  aei: { label: 'AEI', domain: 'aei.org' },
  bipartisan_policy: { label: 'Bipartisan Policy', domain: 'bipartisanpolicy.org' },
};

/** Normalize the various shapes the Wire may receive for `item.source`. */
export function normalizeNewsOutletKey(raw: string): string {
  const head = (raw.split(' · ')[0] ?? raw).trim();
  return head
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function faviconUrl(domain: string): string {
  // sz=64 keeps the 32px mark sharp on retina without a first-party pack.
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

/**
 * Resolve a Wire news source to a display label + logo URL.
 * Unknown sources keep a title-cased label and no logo (initials fallback).
 */
export function resolveNewsOutletMark(rawSource: string): NewsOutletMark {
  const key = normalizeNewsOutletKey(rawSource);
  const known = OUTLETS[key];
  if (known) {
    return { label: known.label, logoUrl: faviconUrl(known.domain) };
  }
  // Prefer a humanized form of the slug when we don't have a catalog entry.
  const head = (rawSource.split(' · ')[0] ?? rawSource).trim();
  const label = head
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  return { label: label || 'News', logoUrl: null };
}
