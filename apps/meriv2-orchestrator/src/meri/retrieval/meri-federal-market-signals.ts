import { meriToolRows } from './meri-retrieval-coverage.js';

export interface MeriFederalMarketSource {
  tool: string;
  result: unknown;
}

export interface MeriFederalMarketSignals {
  capabilityTerms: string[];
  agencies: string[];
  serviceBranches: string[];
  naicsCodes: string[];
  pscCodes: string[];
  peCodes: string[];
}

const TEXT_FIELDS = [
  'title',
  'name',
  'description',
  'summary',
  'snippet',
  'abstract',
  'text',
  'bodyText',
  'productDescription',
  'capability',
  'capabilities',
  'product',
  'products',
  'service',
  'services',
] as const;

const AGENCY_FIELDS = [
  'agency',
  'agencyName',
  'awardingAgency',
  'awardingAgencyName',
  'fundingAgency',
  'fundingAgencyName',
  'department',
  'departmentName',
  'subAgency',
  'subAgencyName',
] as const;

const NAICS_FIELDS = ['naics', 'naicsCode', 'naicsCodes'] as const;
const PSC_FIELDS = ['psc', 'pscCode', 'pscCodes', 'productServiceCode'] as const;
const PE_FIELDS = ['peCode', 'peNumber', 'peNumbers', 'programElement', 'programElementCode'] as const;

const STOPWORDS = new Set([
  'about',
  'across',
  'after',
  'against',
  'also',
  'and',
  'are',
  'award',
  'awards',
  'been',
  'being',
  'business',
  'company',
  'contract',
  'contracts',
  'corporation',
  'federal',
  'from',
  'government',
  'have',
  'incorporated',
  'including',
  'into',
  'more',
  'other',
  'provides',
  'services',
  'solutions',
  'their',
  'they',
  'this',
  'through',
  'using',
  'with',
]);

const AGENCY_PATTERNS: Array<[RegExp, string]> = [
  [/\bdepartment of defense\b|\bdefense department\b|\bdod\b/i, 'Department of Defense'],
  [/\bdepartment of the army\b|\bu\.s\. army\b|\bus army\b/i, 'Department of the Army'],
  [/\bdepartment of the navy\b|\bu\.s\. navy\b|\bus navy\b/i, 'Department of the Navy'],
  [/\bdepartment of the air force\b|\bu\.s\. air force\b|\bus air force\b/i, 'Department of the Air Force'],
  [/\bspace force\b|\bussf\b/i, 'U.S. Space Force'],
  [/\bmarine corps\b|\busmc\b/i, 'U.S. Marine Corps'],
  [/\bspecial operations command\b|\bussocom\b|\bsocom\b/i, 'U.S. Special Operations Command'],
  [/\bdepartment of homeland security\b|\bdhs\b/i, 'Department of Homeland Security'],
  [/\bdepartment of energy\b|\bdoe\b/i, 'Department of Energy'],
  [/\bnasa\b|\bnational aeronautics and space administration\b/i, 'NASA'],
  [/\bdepartment of transportation\b|\bdot\b/i, 'Department of Transportation'],
  [/\bdepartment of veterans affairs\b|\bva\b/i, 'Department of Veterans Affairs'],
];

const SERVICE_PATTERNS: Array<[RegExp, string]> = [
  [/\barmy\b/i, 'Army'],
  [/\bnavy\b/i, 'Navy'],
  [/\bair force\b/i, 'Air Force'],
  [/\bspace force\b/i, 'Space Force'],
  [/\bmarine corps\b|\bmarines\b/i, 'Marine Corps'],
  [/\bsocom\b|\bspecial operations\b/i, 'SOCOM'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringsFrom);
  return [];
}

function sourceRows(value: unknown): unknown[] {
  const rows = meriToolRows(value);
  if (rows.length) return rows;
  if (!isRecord(value)) return [];
  // scrape_web_page and a few detail readers return one structured record
  // rather than a results[] envelope. Treat that record as evidence only when
  // it carries actual content/identity fields, never for a bare coverage wrapper.
  if (
    TEXT_FIELDS.some((field) => stringsFrom(value[field]).length > 0) ||
    AGENCY_FIELDS.some((field) => stringsFrom(value[field]).length > 0) ||
    NAICS_FIELDS.some((field) => stringsFrom(value[field]).length > 0) ||
    PSC_FIELDS.some((field) => stringsFrom(value[field]).length > 0) ||
    PE_FIELDS.some((field) => stringsFrom(value[field]).length > 0)
  ) {
    return [value];
  }
  return [];
}

function addCodes(target: Set<string>, value: unknown, kind: 'naics' | 'psc' | 'pe'): void {
  for (const raw of stringsFrom(value)) {
    const candidates = raw.split(/[\s,;|/]+/).filter(Boolean);
    for (const candidate of candidates) {
      const normalized = candidate.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (!normalized) continue;
      if (kind === 'naics' && /^\d{6}$/.test(normalized)) target.add(normalized);
      if (kind === 'psc' && /^[A-Z0-9]{4}$/.test(normalized)) target.add(normalized);
      if (
        kind === 'pe' &&
        (/^\d{7}[A-Z]$/.test(normalized) || /^\d{4}[A-Z]\d{4}$/.test(normalized))
      ) {
        target.add(normalized);
      }
    }
  }
}

function normalizedTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function capabilityTerms(texts: string[]): string[] {
  const tokenCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  for (const text of texts) {
    const tokens = normalizedTokens(text);
    const unique = new Set(tokens);
    for (const token of unique) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const left = tokens[index]!;
      const right = tokens[index + 1]!;
      if (left === right) continue;
      const phrase = `${left} ${right}`;
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }

  const phrases = [...phraseCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([phrase]) => phrase);
  const words = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 16)
    .map(([token]) => token);
  return [...new Set([...phrases, ...words])].slice(0, 20);
}

export function extractMeriFederalMarketSignals(
  sources: readonly MeriFederalMarketSource[],
): MeriFederalMarketSignals {
  const texts: string[] = [];
  const agencies = new Set<string>();
  const services = new Set<string>();
  const naicsCodes = new Set<string>();
  const pscCodes = new Set<string>();
  const peCodes = new Set<string>();

  for (const source of sources) {
    for (const raw of sourceRows(source.result)) {
      if (!isRecord(raw)) continue;
      for (const field of TEXT_FIELDS) texts.push(...stringsFrom(raw[field]));
      for (const field of AGENCY_FIELDS) {
        for (const agency of stringsFrom(raw[field])) agencies.add(agency);
      }
      for (const field of NAICS_FIELDS) addCodes(naicsCodes, raw[field], 'naics');
      for (const field of PSC_FIELDS) addCodes(pscCodes, raw[field], 'psc');
      for (const field of PE_FIELDS) addCodes(peCodes, raw[field], 'pe');
    }
  }

  const combinedText = texts.join(' ');
  for (const [pattern, agency] of AGENCY_PATTERNS) {
    if (pattern.test(combinedText)) agencies.add(agency);
  }
  for (const [pattern, service] of SERVICE_PATTERNS) {
    if (pattern.test(combinedText)) services.add(service);
  }

  return {
    capabilityTerms: capabilityTerms(texts),
    agencies: [...agencies].slice(0, 20),
    serviceBranches: [...services],
    naicsCodes: [...naicsCodes].slice(0, 20),
    pscCodes: [...pscCodes].slice(0, 20),
    peCodes: [...peCodes].slice(0, 30),
  };
}

export function meriFederalMarketSearchTerms(signals: MeriFederalMarketSignals): string[] {
  return [...new Set(signals.capabilityTerms)]
    .filter((term) => term.length >= 4)
    .slice(0, 6);
}

export function meriFederalMarketQualificationGaps(input: {
  resolutionStatus: string;
  identifiers?: Record<string, string> | null;
  signals: MeriFederalMarketSignals;
  historicalAwardCount: number;
}): string[] {
  const gaps: string[] = [];
  if (input.resolutionStatus !== 'resolved') {
    gaps.push('Company identity is not yet resolved with high confidence.');
  }
  const identifiers = input.identifiers ?? {};
  if (!identifiers.uei) gaps.push('UEI was not verified in retrieved evidence.');
  if (!identifiers.cage) gaps.push('CAGE code was not verified in retrieved evidence.');
  if (!input.signals.naicsCodes.length) gaps.push('No verified NAICS code was retrieved.');
  if (!input.signals.pscCodes.length) gaps.push('No verified PSC code was retrieved.');
  if (input.historicalAwardCount === 0) {
    gaps.push('No federal award history was retrieved; past-performance fit remains unverified.');
  }
  return gaps;
}
