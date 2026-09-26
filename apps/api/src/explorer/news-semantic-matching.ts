import type { Prisma } from '@prisma/client';

/**
 * Shared vocabulary for news search. A user-facing filter is a concept, not
 * an exact database token: stored RSS labels and prose vary by outlet.
 * Keep this deterministic and explainable; it is deliberately not an LLM
 * call or a browser-side post-filter.
 */
const CONCEPT_ALIASES: Record<string, readonly string[]> = {
  'counter uas': ['counter uas', 'counter unmanned aircraft systems', 'counter drone', 'c-uas'],
  'counter-uas': ['counter uas', 'counter unmanned aircraft systems', 'counter drone', 'c-uas'],
  procurement: ['procurement', 'acquisition', 'contracting', 'solicitation', 'awarding'],
  contracts: ['contract', 'contracting', 'procurement', 'acquisition', 'award'],
  budget: ['budget', 'appropriation', 'funding', 'fiscal plan', 'spending'],
  grants: ['grant', 'grants', 'funding opportunity', 'notice of funding', 'cooperative agreement'],
  legislation: ['legislation', 'legislative', 'bill', 'act', 'measure', 'lawmakers'],
  regulation: ['regulation', 'regulatory', 'rulemaking', 'federal register', 'rule'],
  hearings: ['hearing', 'markup', 'committee', 'testimony'],
  defense: ['defense', 'national security', 'military', 'armed forces', 'dod', 'department of defense'],
  'department of defense': ['department of defense', 'defense department', 'dod', 'pentagon'],
  dod: ['dod', 'department of defense', 'defense department', 'pentagon'],
  army: ['army', 'u.s. army', 'department of the army'],
  navy: ['navy', 'u.s. navy', 'department of the navy'],
  'air force': ['air force', 'u.s. air force', 'department of the air force'],
  'space force': ['space force', 'u.s. space force'],
  'artificial intelligence': ['artificial intelligence', 'ai', 'machine learning', 'automation'],
  autonomy: ['autonomy', 'autonomous', 'unmanned', 'robotic'],
  autonomous: ['autonomous', 'autonomy', 'unmanned', 'robotic'],
  vehicle: ['vehicle', 'vehicles', 'ground vehicle', 'ground vehicles', 'platform', 'platforms'],
  vehicles: ['vehicle', 'vehicles', 'ground vehicle', 'ground vehicles', 'platform', 'platforms'],
  ground: ['ground', 'terrestrial', 'land'],
  politico: ['politico', 'politico congress'],
  'roll call': ['roll call', 'roll_call'],
  'the hill': ['the hill', 'the_hill'],
  axios: ['axios'],
  brookings: ['brookings'],
};

export interface SemanticNewsFilterInput {
  query?: string;
  sources?: string[];
  topics?: string[];
  agencies?: string[];
}

export function expandNewsTerms(value: string): string[] {
  const normalized = normalize(value);
  if (!normalized) return [];
  const aliases = CONCEPT_ALIASES[normalized] ?? [];
  return unique([normalized, ...aliases]);
}

export function matchesSemanticNewsText(
  concept: string,
  text: { title?: string | null; summary?: string | null; topics?: readonly string[]; agencies?: readonly string[] } = {},
): boolean {
  const haystack = normalize([
    text.title ?? '',
    text.summary ?? '',
    ...(text.topics ?? []),
    ...(text.agencies ?? []),
  ].join(' '));
  const phraseMatches = expandNewsTerms(concept).some((term) => haystack.includes(normalize(term)));
  if (phraseMatches) return true;
  const tokens = normalize(concept).split(/\s+/).filter((token) => token.length > 2);
  return tokens.length > 1 && tokens.every((token) => expandNewsTerms(token).some((term) => haystack.includes(normalize(term))));
}

/** Prisma predicate: AND across selected filters, OR across concept aliases. */
export function buildSemanticIntelArticleWhere(
  input: SemanticNewsFilterInput,
): Prisma.IntelArticleWhereInput {
  const and: Prisma.IntelArticleWhereInput[] = [];
  const query = input.query?.trim();
  if (query) and.push({ OR: query.split(',').flatMap((term) => textConditions(term)) });
  if (input.sources?.length) {
    and.push({ OR: input.sources.flatMap((source) => sourceConditions(source)) });
  }
  if (input.topics?.length) {
    and.push({ OR: input.topics.flatMap((topic) => [...textConditions(topic), ...arrayConditions(topic, 'topics')]) });
  }
  if (input.agencies?.length) {
    and.push({ OR: input.agencies.flatMap((agency) => [...textConditions(agency), ...arrayConditions(agency, 'agencies')]) });
  }
  return and.length ? { AND: and } : {};
}

function textConditions(value: string, fields: Array<'title' | 'summary' | 'source'> = ['title', 'summary']): Prisma.IntelArticleWhereInput[] {
  const phraseConditions = expandNewsTerms(value).flatMap((term) => fields.map((field) => ({ [field]: { contains: term, mode: 'insensitive' as const } })));
  const tokens = normalize(value).split(/\s+/).filter((token) => token.length > 2);
  if (tokens.length <= 1) return phraseConditions;
  const tokenConditions = tokens.map((token) => ({
    OR: expandNewsTerms(token).flatMap((term) => fields.map((field) => ({ [field]: { contains: term, mode: 'insensitive' as const } }))),
  }));
  return [...phraseConditions, { AND: tokenConditions }];
}

function arrayConditions(value: string, field: 'topics' | 'agencies'): Prisma.IntelArticleWhereInput[] {
  const original = value.trim();
  const terms = unique([original, ...expandNewsTerms(value)]);
  return terms.flatMap((term) => [
    { [field]: { has: term } },
    { [field]: { has: titleCase(term) } },
  ]);
}

/**
 * Canonical `intel_article.source` slug (apps/api/scripts/sync-rss-intel.ts
 * feed slugs) → publisher hostnames seen on that feed's article links.
 *
 * Between 2026-09-04 and 2026-09-16 the LegiWatch retain() path stored the
 * article hostname in `source` instead of the slug, so the corpus carries both
 * spellings. A slug filter must keep matching those rows and a hostname a user
 * saved from the facet list during that window must keep matching slug rows.
 * The hostname list is also what `backfill-intel-article-sources` uses to
 * relabel rows that have no feed_url.
 */
export const SOURCE_HOST_ALIASES: Readonly<Record<string, readonly string[]>> = {
  roll_call: ['rollcall.com', 'www.rollcall.com'],
  the_hill: ['thehill.com', 'www.thehill.com'],
  politico: ['www.politico.com', 'politico.com', 'rss.politico.com'],
  politico_congress: ['www.politico.com', 'politico.com', 'rss.politico.com'],
  axios: ['www.axios.com', 'axios.com', 'api.axios.com'],
  reuters_politics: ['www.reutersagency.com', 'www.reuters.com', 'reuters.com'],
  // The DoD feed links out to component sites; these are the hosts observed
  // on it in production (2026-09-10 → 2026-09-16). The backfill relabels by
  // feed_url, so this list only has to cover filter-time matching.
  dod: [
    'www.defense.gov',
    'defense.gov',
    'media.defense.gov',
    'armedforcessports.defense.gov',
    'www.war.gov',
    'war.gov',
    'www.jbsa.mil',
    'ndupress.ndu.edu',
    'inss.ndu.edu',
    'www.dla.mil',
    'www.dcma.mil',
    'www.dcaa.mil',
    'www.dsca.mil',
    'www.jcs.mil',
    'www.stratcom.mil',
    'www.navsea.navy.mil',
    'www.jtfcs.northcom.mil',
    'www.travel.dod.mil',
    'www.il.ngb.army.mil',
    'va.ng.mil',
    'sfb.dodlive.mil',
  ],
  hhs: ['www.hhs.gov', 'hhs.gov'],
  usda: ['www.usda.gov', 'usda.gov'],
  doj: ['www.justice.gov', 'justice.gov'],
  state_dept: ['www.state.gov', 'state.gov'],
  commerce: ['www.commerce.gov', 'commerce.gov'],
  va: ['news.va.gov', 'www.va.gov', 'va.gov'],
  doe: ['www.energy.gov', 'energy.gov'],
  dhs: ['www.dhs.gov', 'dhs.gov'],
  heritage: ['www.heritage.org', 'heritage.org'],
  urban: ['www.urban.org', 'urban.org'],
  cato: ['www.cato.org', 'cato.org'],
  brookings: ['www.brookings.edu', 'brookings.edu'],
  aei: ['www.aei.org', 'aei.org'],
  bipartisan_policy: ['bipartisanpolicy.org', 'www.bipartisanpolicy.org'],
  florida_phoenix: ['floridaphoenix.com', 'www.floridaphoenix.com'],
  wusf: ['www.wusf.org', 'wusf.org'],
  florida_daily: ['floridadaily.com', 'www.floridadaily.com'],
  cbs_miami: ['www.cbsnews.com', 'cbsnews.com'],
};

/** Slugs a publisher hostname belongs to (empty when unknown). */
export function sourceSlugsForHost(host: string): string[] {
  const needle = normalize(host);
  return Object.entries(SOURCE_HOST_ALIASES)
    .filter(([, hosts]) => hosts.includes(needle))
    .map(([slug]) => slug);
}

/**
 * Every stored `source` spelling one user-facing source filter should match:
 * the value itself, its slug form, concept aliases (`politico` → also
 * `politico_congress`), and the hostnames/slugs paired with each of those.
 * Exact values only — the previous `equals` + `mode: 'insensitive'` compiled
 * to ILIKE, where the `_` in every slug is a one-character wildcard, so
 * matching worked by accident and could never be reasoned about.
 */
export function sourceFilterValues(value: string): string[] {
  const values = new Set<string>();
  for (const term of expandNewsTerms(value)) {
    const slug = slugify(term);
    values.add(term);
    values.add(slug);
    for (const host of SOURCE_HOST_ALIASES[slug] ?? []) values.add(host);
    for (const owner of sourceSlugsForHost(term)) {
      values.add(owner);
      for (const host of SOURCE_HOST_ALIASES[owner] ?? []) values.add(host);
    }
  }
  return [...values].filter(Boolean);
}

function sourceConditions(value: string): Prisma.IntelArticleWhereInput[] {
  const values = sourceFilterValues(value);
  return values.length ? [{ source: { in: values } }] : [];
}

function slugify(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))];
}