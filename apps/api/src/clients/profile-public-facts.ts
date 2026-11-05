import type { FacilityProfileFields } from './facility-profile-fields.js';

const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
export const PUBLIC_SITE_ROLES = [
  'headquarters',
  'manufacturing',
  'research',
  'engineering',
  'testing',
  'office',
  'other',
] as const;
export const PUBLIC_SITE_STATUSES = [
  'operating',
  'announced',
  'under_construction',
  'proposed',
  'closed',
  'unknown',
] as const;
const SOURCE_KINDS = [
  'company',
  'registration',
  'filing',
  'award',
  'news',
  'job_posting',
  'other',
] as const;
export const publicLocationSchema = {
  type: 'array',
  maxItems: 40,
  items: {
    type: 'object',
    additionalProperties: false,
    required: [
      'name',
      'addressLine',
      'city',
      'state',
      'zip',
      'country',
      'siteRole',
      'siteStatus',
      'sourceKind',
      'quote',
      'evidenceUrl',
    ],
    properties: {
      name: { type: 'string' },
      addressLine: nullable,
      city: nullable,
      state: nullable,
      zip: nullable,
      country: { anyOf: [{ type: 'string', pattern: '^[A-Z]{2}$' }, { type: 'null' }] },
      siteRole: { anyOf: [{ type: 'string', enum: [...PUBLIC_SITE_ROLES] }, { type: 'null' }] },
      siteStatus: { type: 'string', enum: [...PUBLIC_SITE_STATUSES] },
      sourceKind: { type: 'string', enum: [...SOURCE_KINDS] },
      quote: { type: 'string', minLength: 1, maxLength: 4000 },
      evidenceUrl: { type: 'string' },
    },
  },
};
export const publicNewsSchema = {
  type: 'array',
  maxItems: 12,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary', 'publishedAt', 'evidenceUrl', 'quote', 'dateQuote'],
    properties: {
      title: { type: 'string', maxLength: 300 },
      summary: { type: 'string', maxLength: 3000 },
      publishedAt: nullable,
      evidenceUrl: { type: 'string' },
      quote: { type: 'string', minLength: 1, maxLength: 4000 },
      dateQuote: nullable,
    },
  },
};
export interface PublicFactSource {
  url: string;
  text: string;
  publishedAt?: string | null;
}
export function combinePublicFactSources(sources: PublicFactSource[]) {
  const combined = new Map<string, PublicFactSource>();
  for (const source of sources) {
    const previous = combined.get(source.url);
    combined.set(source.url, {
      url: source.url,
      text: [previous?.text, source.text].filter(Boolean).join('\n'),
      publishedAt: source.publishedAt || previous?.publishedAt,
    });
  }
  return [...combined.values()];
}
export interface ExtractedLocation {
  name: string;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country?: string | null;
  siteRole?: string | null;
  siteStatus?: string | null;
  sourceKind?: string | null;
  quote?: string | null;
  evidenceUrl: string;
}
export interface ExtractedNews {
  title: string;
  summary: string;
  publishedAt: string | null;
  evidenceUrl: string;
  quote?: string | null;
  dateQuote?: string | null;
}
const textKey = (text: string) => text.replace(/\s+/g, ' ').trim();
function supportedQuote(quote: string | null | undefined, source: PublicFactSource) {
  return Boolean(
    quote?.trim() && quote.length <= 4000 && textKey(source.text).includes(textKey(quote)),
  );
}

/** Research is a proposal, never proof that a company operates a site. */
export function sourcedLocation(
  row: ExtractedLocation,
  source: PublicFactSource,
  observedAt: string,
) {
  if (!row.name.trim() || !supportedQuote(row.quote, source)) return null;
  if (row.country && !/^[A-Z]{2}$/i.test(row.country)) return null;
  if (
    row.siteRole &&
    !PUBLIC_SITE_ROLES.includes(row.siteRole as (typeof PUBLIC_SITE_ROLES)[number])
  )
    return null;
  if (
    row.siteStatus &&
    !PUBLIC_SITE_STATUSES.includes(row.siteStatus as (typeof PUBLIC_SITE_STATUSES)[number])
  )
    return null;
  const jobOnly =
    row.sourceKind === 'job_posting' ||
    /(?:^|[/.\-_])(?:jobs?|careers?|recruiting)(?:[/.\-_]|$)/i.test(
      new URL(source.url).hostname + new URL(source.url).pathname,
    );
  return {
    name: row.name.trim(),
    addressLine: row.addressLine?.trim() || null,
    city: row.city?.trim() || null,
    state: row.state?.trim().toUpperCase() || null,
    zip: row.zip?.trim() || null,
    ...(row.country ? { country: row.country.toUpperCase() } : {}),
    ...(row.siteRole ? { siteRole: row.siteRole as FacilityProfileFields['siteRole'] } : {}),
    siteStatus: (jobOnly
      ? 'unknown'
      : row.siteStatus || 'unknown') as FacilityProfileFields['siteStatus'],
    siteVerificationStatus: 'unverified' as const,
    sourceObservedAt: observedAt,
    sourceEvidence: [
      {
        sourceType: jobOnly ? 'job_posting' : row.sourceKind || 'public_web',
        sourceUrl: source.url,
        evidence: row.quote!,
      },
    ],
  };
}

function sourceDateMatches(row: ExtractedNews, source: PublicFactSource, date: Date) {
  const providerDate = new Date(source.publishedAt ?? '');
  if (
    Number.isFinite(providerDate.getTime()) &&
    providerDate.toISOString().slice(0, 10) === date.toISOString().slice(0, 10)
  )
    return true;
  if (!row.dateQuote || !textKey(source.text).includes(textKey(row.dateQuote))) return false;
  // Written calendar dates have no timezone. Parse them in UTC so a server's
  // local timezone cannot shift an October 20 source into October 19.
  const quoted = new Date(
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(row.dateQuote) ? row.dateQuote : `${row.dateQuote} UTC`,
  );
  return (
    Number.isFinite(quoted.getTime()) &&
    quoted.toISOString().slice(0, 10) === date.toISOString().slice(0, 10)
  );
}
const governmentRelevance = (text: string) =>
  (
    text.match(
      /\b(?:defense|military|government|federal|contract|award|navy|army|air force|congress|agency|appropriation|budget|grant|procurement)\b/gi,
    ) ?? []
  ).length;

/** Source dates, not discovery time, determine the rolling twelve-month news window. */
export function sourcedNews(rows: ExtractedNews[], sources: PublicFactSource[], now: Date) {
  const since = new Date(now);
  since.setUTCFullYear(since.getUTCFullYear() - 1);
  const found = rows.flatMap((row) => {
    const source = sources.find((source) => source.url === row.evidenceUrl);
    const date = new Date(row.publishedAt ?? '');
    if (
      !source ||
      !row.title.trim() ||
      row.title.length > 300 ||
      row.summary.length > 3000 ||
      !Number.isFinite(date.getTime()) ||
      date < since ||
      date > now ||
      !supportedQuote(row.quote, source) ||
      !sourceDateMatches(row, source, date)
    )
      return [];
    return [
      {
        title: row.title.trim(),
        summary: row.summary.trim(),
        publishedAt: date.toISOString(),
        publisher: new URL(source.url).hostname,
        url: source.url,
        quote: row.quote!,
        relevance: governmentRelevance(`${row.title} ${row.summary}`),
      },
    ];
  });
  return [...new Map(found.map((row) => [`${row.url}:${row.title}`, row])).values()]
    .sort((a, b) => b.relevance - a.relevance || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 12)
    .map(({ relevance: _relevance, ...row }) => row);
}
