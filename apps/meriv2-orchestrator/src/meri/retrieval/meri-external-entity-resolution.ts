import { meriToolRows } from './meri-retrieval-coverage.js';

export interface MeriEntityResolutionSource {
  tool: string;
  result: unknown;
}

export interface MeriExternalEntityCandidate {
  canonicalName: string;
  normalizedName: string;
  domains: string[];
  identifiers: Record<string, string>;
  clientId?: string;
  confidence: number;
  sourceTools: string[];
  matchReasons: string[];
}

export interface MeriExternalEntityResolution {
  tool: 'resolve_entity';
  query: string;
  resolutionStatus: 'resolved' | 'ambiguous' | 'not_found';
  resolvedEntity: MeriExternalEntityCandidate | null;
  candidates: MeriExternalEntityCandidate[];
  results: Array<{
    id: string;
    title: string;
    url: string | null;
    snippet: string;
    sourceTool: string;
  }>;
  note: string;
}

const NAME_FIELDS = [
  'canonicalName',
  'companyName',
  'clientName',
  'recipientName',
  'registrantName',
  'foreignPrincipal',
  'name',
  'title',
] as const;
const ID_FIELDS: Array<[string, string]> = [
  ['uei', 'uei'],
  ['ueiNumber', 'uei'],
  ['cageCode', 'cage'],
  ['cage', 'cage'],
  ['cik', 'cik'],
  ['ldaClientId', 'ldaClientId'],
  ['recipientId', 'usaspendingRecipientId'],
  ['samEntityId', 'samEntityId'],
];
const URL_FIELDS = ['officialWebsite', 'website', 'url', 'link', 'sourceUrl', 'webUrl'] as const;
const LEGAL_SUFFIX_RE =
  /\b(?:incorporated|inc|llc|l\.l\.c|corp(?:oration)?|company|co|limited|ltd|lp|llp|pllc|holdings?|group)\b/g;
const NON_COMPANY_TYPES = new Set([
  'bill',
  'committee',
  'member',
  'person',
  'staffer',
  'state_bill',
  'state_legislator',
]);
const AUTHORITATIVE_IDENTITY_TOOLS = new Set([
  'lookup_client_registry',
  'search_federal_awards',
  'search_lda_filings',
  'search_sec_filings',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = stringValue(record[field]);
    if (value) return value;
  }
  return null;
}

function rowEntityType(row: Record<string, unknown>): string | null {
  return (
    stringValue(row.entityType) ??
    stringValue(row.type) ??
    stringValue(row.kind)
  )?.toLowerCase() ?? null;
}

function rowMayRepresentCompany(tool: string, row: Record<string, unknown>): boolean {
  const type = rowEntityType(row);
  if (type && NON_COMPANY_TYPES.has(type)) return false;
  // The canonical Capiro resolver primarily returns members, committees and
  // bills. Unknown/untyped rows from other company registries remain usable,
  // but a typed non-company result from this tool must never be promoted into
  // a company identity simply because its title resembles the query.
  if (tool === 'resolve_entity' && type) {
    return ['client', 'company', 'organization', 'vendor', 'recipient'].includes(type);
  }
  return true;
}

/**
 * Most Meri readers expose `results`, but lookup_client_registry deliberately
 * returns named identity slots because it must distinguish an existing Capiro
 * client from an LDA candidate. Normalize those slots here rather than changing
 * the underlying write-oriented registry contract.
 */
function sourceRows(source: MeriEntityResolutionSource): unknown[] {
  const rows = [...meriToolRows(source.result)];
  if (!isRecord(source.result)) return rows;
  for (const key of ['existingClient', 'ldaExactMatch'] as const) {
    const value = source.result[key];
    if (isRecord(value)) rows.push(value);
  }
  for (const key of ['ldaCandidates', 'candidates'] as const) {
    const value = source.result[key];
    if (Array.isArray(value)) rows.push(...value);
  }
  return rows.filter(
    (row, index, all) =>
      all.findIndex((candidate) => candidate === row) === index,
  );
}

export function normalizeMeriEntityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.(?:com|net|org|io|ai|co|inc|gov|us)\/?$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalizeMeriEntityName(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

function levenshtein(a: string, b: string): number {
  if (!a) return b.length;
  if (!b) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? j;
      const left = previous[j - 1] ?? i;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(above + 1, left + 1, diagonal + cost);
      diagonal = above;
      previous[j] = next;
    }
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function textSimilarity(a: string, b: string): number {
  const left = normalizeMeriEntityName(a);
  const right = normalizeMeriEntityName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = union ? intersection / union : 0;
  const edit = 1 - levenshtein(left, right) / Math.max(left.length, right.length);
  return Math.max(jaccard, edit);
}

function domainFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    const match = value.toLowerCase().match(/(?:^|@)([a-z0-9.-]+\.[a-z]{2,})$/i);
    return match?.[1] ?? null;
  }
}

function sourceWeight(tool: string): number {
  if (tool === 'lookup_client_registry') return 0.1;
  if (tool === 'search_sec_filings') return 0.08;
  if (tool === 'search_lda_filings') return 0.07;
  if (tool === 'search_federal_awards') return 0.06;
  if (tool === 'search_research_sources') return 0.05;
  if (tool === 'search_public_web') return 0.03;
  return 0.01;
}

function candidateFromRow(
  query: string,
  tool: string,
  row: Record<string, unknown>,
): MeriExternalEntityCandidate | null {
  if (!rowMayRepresentCompany(tool, row)) return null;
  const canonicalName = firstString(row, NAME_FIELDS);
  if (!canonicalName) return null;
  const normalizedName = normalizeMeriEntityName(canonicalName);
  if (!normalizedName) return null;
  const domains = new Set<string>();
  for (const field of URL_FIELDS) {
    const domain = domainFromUrl(stringValue(row[field]));
    if (domain) domains.add(domain);
  }
  for (const field of ['domain', 'emailDomain']) {
    const domain = domainFromUrl(stringValue(row[field]));
    if (domain) domains.add(domain);
  }
  const identifiers: Record<string, string> = {};
  for (const [field, key] of ID_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) identifiers[key] = normalized;
    }
  }
  const similarity = textSimilarity(query, canonicalName);
  const queryDomain = domainFromUrl(query);
  const domainMatch = queryDomain ? domains.has(queryDomain) : false;
  const confidence = Math.min(
    0.99,
    Math.max(similarity, domainMatch ? 0.98 : 0) + sourceWeight(tool),
  );
  const clientId =
    stringValue(row.clientId) ??
    (row.type === 'client' ? stringValue(row.id) : null) ??
    (row.entityType === 'client' ? stringValue(row.id) : null) ??
    (tool === 'lookup_client_registry' && !row.ldaClientId ? stringValue(row.id) : null);
  return {
    canonicalName,
    normalizedName,
    domains: [...domains],
    identifiers,
    ...(clientId ? { clientId } : {}),
    confidence,
    sourceTools: [tool],
    matchReasons: [
      domainMatch ? 'exact-domain' : similarity >= 0.99 ? 'exact-name' : `name-similarity:${similarity.toFixed(2)}`,
    ],
  };
}

function sharesIdentifier(
  left: MeriExternalEntityCandidate,
  right: MeriExternalEntityCandidate,
): boolean {
  return Object.entries(left.identifiers).some(
    ([key, value]) => value && right.identifiers[key] === value,
  );
}

function sharedDomain(
  left: MeriExternalEntityCandidate,
  right: MeriExternalEntityCandidate,
): boolean {
  return left.domains.some((domain) => right.domains.includes(domain));
}

function hasConflictingDomains(
  left: MeriExternalEntityCandidate,
  right: MeriExternalEntityCandidate,
): boolean {
  return left.domains.length > 0 && right.domains.length > 0 && !sharedDomain(left, right);
}

function canMergeCandidates(
  left: MeriExternalEntityCandidate,
  right: MeriExternalEntityCandidate,
): boolean {
  if (sharesIdentifier(left, right) || sharedDomain(left, right)) return true;
  return left.normalizedName === right.normalizedName && !hasConflictingDomains(left, right);
}

function mergeCandidates(candidates: MeriExternalEntityCandidate[]): MeriExternalEntityCandidate[] {
  const merged: MeriExternalEntityCandidate[] = [];
  for (const candidate of candidates) {
    const existing = merged.find((current) => canMergeCandidates(current, candidate));
    if (!existing) {
      merged.push({
        ...candidate,
        domains: [...candidate.domains],
        identifiers: { ...candidate.identifiers },
        sourceTools: [...candidate.sourceTools],
        matchReasons: [...candidate.matchReasons],
      });
      continue;
    }
    existing.domains = [...new Set([...existing.domains, ...candidate.domains])];
    existing.identifiers = { ...existing.identifiers, ...candidate.identifiers };
    existing.sourceTools = [...new Set([...existing.sourceTools, ...candidate.sourceTools])];
    existing.matchReasons = [...new Set([...existing.matchReasons, ...candidate.matchReasons])];
    existing.confidence = Math.min(
      0.99,
      Math.max(existing.confidence, candidate.confidence) +
        Math.min(0.08, 0.02 * (existing.sourceTools.length - 1)),
    );
    if (!existing.clientId && candidate.clientId) existing.clientId = candidate.clientId;
  }
  return merged.sort((a, b) => b.confidence - a.confidence);
}

function evidenceRow(tool: string, row: Record<string, unknown>, index: number) {
  const title = firstString(row, NAME_FIELDS) ?? `${tool} result ${index + 1}`;
  const url = firstString(row, URL_FIELDS);
  const id =
    stringValue(row.id) ??
    stringValue(row.clientId) ??
    stringValue(row.ldaClientId) ??
    stringValue(row.accessionNumber) ??
    `${tool}-${index + 1}`;
  const snippet =
    firstString(row, ['summary', 'description', 'snippet', 'subject', 'latestAction', 'text']) ??
    `Identity signal returned by ${tool}.`;
  return {
    id,
    title,
    url: url && /^https?:\/\//i.test(url) ? url : null,
    snippet: snippet.slice(0, 320),
    sourceTool: tool,
  };
}

function hasAuthoritativeIdentity(candidate: MeriExternalEntityCandidate): boolean {
  return candidate.sourceTools.some((tool) => AUTHORITATIVE_IDENTITY_TOOLS.has(tool));
}

export function buildMeriExternalEntityResolution(
  query: string,
  sources: readonly MeriEntityResolutionSource[],
): MeriExternalEntityResolution {
  const rawCandidates: MeriExternalEntityCandidate[] = [];
  const results: MeriExternalEntityResolution['results'] = [];
  for (const source of sources) {
    const rows = sourceRows(source);
    rows.slice(0, 25).forEach((raw, index) => {
      if (!isRecord(raw) || !rowMayRepresentCompany(source.tool, raw)) return;
      const candidate = candidateFromRow(query, source.tool, raw);
      if (candidate && candidate.confidence >= 0.45) rawCandidates.push(candidate);
      results.push(evidenceRow(source.tool, raw, index));
    });
  }
  const candidates = mergeCandidates(rawCandidates).slice(0, 8);
  const top = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  const exactDomain = top?.matchReasons.includes('exact-domain') === true;
  const exactName = top?.matchReasons.includes('exact-name') === true;
  const corroborated = (top?.sourceTools.length ?? 0) >= 2;
  const authoritative = top ? hasAuthoritativeIdentity(top) : false;
  const separatedFromRunnerUp =
    !runnerUp || (top ? top.confidence - runnerUp.confidence >= 0.06 : false);
  const identityStrength =
    exactDomain || corroborated || (authoritative && exactName && (top?.confidence ?? 0) >= 0.9);
  const confident = Boolean(
    top &&
      top.confidence >= 0.86 &&
      separatedFromRunnerUp &&
      identityStrength,
  );
  const resolutionStatus: MeriExternalEntityResolution['resolutionStatus'] = confident
    ? 'resolved'
    : candidates.length
      ? 'ambiguous'
      : 'not_found';
  return {
    tool: 'resolve_entity',
    query,
    resolutionStatus,
    resolvedEntity: confident ? top : null,
    candidates,
    results: results.slice(0, 30),
    note:
      resolutionStatus === 'resolved'
        ? `Resolved ${query} to ${top!.canonicalName} using ${top!.sourceTools.join(', ')}.`
        : resolutionStatus === 'ambiguous'
          ? 'Multiple plausible organizations remain, or the best match lacks enough independent identity evidence. Use the candidates and public evidence to disambiguate; do not silently choose a weak match.'
          : 'No organization could be resolved from the authorized internal sources, public registries, or web results returned.',
  };
}
