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

function conceptConditions(value: string): Prisma.IntelArticleWhereInput[] {
  return textConditions(value);
}

function sourceConditions(value: string): Prisma.IntelArticleWhereInput[] {
  const terms = expandNewsTerms(value);
  return terms.map((term) => ({
    source: { equals: term.replace(/[^a-z0-9]+/g, '_'), mode: 'insensitive' as const },
  }));
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