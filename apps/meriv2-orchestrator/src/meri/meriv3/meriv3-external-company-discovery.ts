import type { MeriExternalEntityResolution } from '../retrieval/meri-external-entity-resolution.js';
import {
  executeMeriExternalEntityResolution,
  isRecord,
  resultRows,
  safeInvoke,
  stringValue,
  type MeriUnderlyingToolInvoker,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

export type MeriExternalCompanyIdentityStatus =
  | 'resolved'
  | 'provisional'
  | 'ambiguous'
  | 'not_found';

export interface MeriExternalCompanyCandidate {
  canonicalName: string;
  normalizedName: string;
  domains: string[];
  urls: string[];
  supportingQueries: string[];
  evidenceCount: number;
  similarity: number;
  score: number;
}

export interface MeriExternalCompanyDiscovery {
  input: string;
  normalizedInput: string;
  queryVariants: string[];
  correctionApplied: boolean;
  identityStatus: MeriExternalCompanyIdentityStatus;
  researchName: string;
  resolution: MeriExternalEntityResolution;
  candidates: MeriExternalCompanyCandidate[];
  selectedCandidate: MeriExternalCompanyCandidate | null;
  officialSite: SourceResult | null;
  sources: SourceResult[];
  ambiguityReason: string | null;
}

const CORPORATE_SUFFIXES = new Set([
  'co',
  'company',
  'corp',
  'corporation',
  'inc',
  'incorporated',
  'llc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'plc',
]);

const JOINED_WORD_SUFFIXES = [
  'technologies',
  'technology',
  'industries',
  'industry',
  'solutions',
  'systems',
  'advisors',
  'consulting',
  'partners',
  'aerospace',
  'defense',
  'robotics',
  'analytics',
  'logistics',
  'engineering',
  'communications',
  'software',
  'group',
  'labs',
] as const;

const NON_OFFICIAL_DOMAINS = new Set([
  'bloomberg.com',
  'crunchbase.com',
  'facebook.com',
  'highergov.com',
  'linkedin.com',
  'opencorporates.com',
  'pitchbook.com',
  'sam.gov',
  'sec.gov',
  'usaspending.gov',
  'wikipedia.org',
  'x.com',
  'youtube.com',
  'zoominfo.com',
]);

const GENERIC_TITLES = new Set([
  'company',
  'home',
  'homepage',
  'official site',
  'official website',
  'welcome',
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizedComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(the|official|website|homepage|home)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function splitJoinedCompanyWords(value: string): string {
  let current = value;
  for (const suffix of JOINED_WORD_SUFFIXES) {
    const pattern = new RegExp(`([a-z0-9])(${suffix})\\b`, 'i');
    current = current.replace(pattern, '$1 $2');
  }
  return current;
}

/**
 * Humanize URL-like and malformed organization inputs without pretending the
 * resulting spelling is authoritative. `kindeticindustries.inc` becomes
 * `kindetic industries inc`, while a real `.com` input remains available as a
 * domain hypothesis in the generated query set.
 */
export function humanizeExternalCompanyInput(raw: string): string {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original string when it is not valid URI encoding.
  }
  value = value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^mailto:/i, '')
    .split(/[/?#]/, 1)[0] ?? value;
  if (value.includes('@')) value = value.split('@').pop() ?? value;

  // Corporate suffixes are commonly typed as if they were a TLD. Preserve
  // actual web TLDs as domains, but turn `.inc`, `.llc`, `.corp`, etc. into
  // words so search engines can correct the company spelling.
  value = value.replace(/\.(inc|llc|corp|corporation|ltd|limited|plc)$/i, ' $1');
  value = value.replace(/[._-]+/g, ' ');
  value = splitJoinedCompanyWords(value);
  return normalizeWhitespace(value);
}

function withoutCorporateSuffix(value: string): string {
  const tokens = normalizeWhitespace(value).split(' ');
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1]!.toLowerCase())) {
    tokens.pop();
  }
  return tokens.join(' ');
}

function probableDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
  value = value.split(/[/?#]/, 1)[0] ?? value;
  if (value.includes('@')) value = value.split('@').pop() ?? value;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,24}$/.test(value)) return null;
  if (/\.(inc|llc|corp|ltd|plc)$/.test(value)) return null;
  return value;
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function externalCompanyQueryVariants(raw: string): string[] {
  const humanized = humanizeExternalCompanyInput(raw);
  const base = withoutCorporateSuffix(humanized);
  const domain = probableDomain(raw);
  return unique([
    raw,
    humanized,
    base,
    `${humanized} company`,
    `${base} official website`,
    `${base} products capabilities services`,
    `${base} federal contractor government`,
    domain ? `${domain} company` : null,
  ]).slice(0, 8);
}

function domainFromUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function registrableDomain(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}

function isLikelyOfficialDomain(domain: string): boolean {
  const root = registrableDomain(domain);
  return ![...NON_OFFICIAL_DOMAINS].some(
    (blocked) => root === blocked || root.endsWith(`.${blocked}`),
  );
}

function candidateNameFromDomain(domain: string): string | null {
  const label = domain.split('.')[0];
  if (!label || label.length < 3) return null;
  return normalizeWhitespace(splitJoinedCompanyWords(label.replace(/[-_]+/g, ' ')));
}

function cleanSearchTitle(value: string): string | null {
  let title = value
    .replace(/\s+[|•]\s+.*$/, '')
    .replace(/\s+[—–]\s+.*$/, '')
    .replace(/\s+-\s+(official|home|company|about).*$/i, '')
    .replace(/\s+\|\s+.*$/, '')
    .trim();
  title = title.replace(/\s*\((official|company)\)\s*$/i, '').trim();
  if (!title || GENERIC_TITLES.has(title.toLowerCase())) return null;
  if (title.length > 160) return null;
  return title;
}

function rowString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function similarity(left: string, right: string): number {
  const a = normalizedComparable(left);
  const b = normalizedComparable(right);
  if (!a || !b) return 0;
  const distance = levenshtein(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length));
}

function canonicalCandidateKey(name: string, domains: string[]): string {
  const domain = domains[0];
  return domain ? `domain:${registrableDomain(domain)}` : `name:${normalizedComparable(name)}`;
}

interface MutableCandidate {
  canonicalName: string;
  domains: Set<string>;
  urls: Set<string>;
  supportingQueries: Set<string>;
  evidenceCount: number;
  similarity: number;
}

function webCandidates(
  input: string,
  queryResults: Array<{ query: string; source: SourceResult }>,
): MeriExternalCompanyCandidate[] {
  const target = withoutCorporateSuffix(humanizeExternalCompanyInput(input));
  const candidates = new Map<string, MutableCandidate>();

  for (const { query, source } of queryResults) {
    for (const raw of resultRows(source.result).slice(0, 20)) {
      if (!isRecord(raw)) continue;
      const url = rowString(raw, ['url', 'link', 'sourceUrl', 'officialWebsite', 'website']);
      const domain = domainFromUrl(url);
      const title = rowString(raw, ['companyName', 'name', 'title', 'headline']);
      const titleName = title ? cleanSearchTitle(title) : null;
      const domainName = domain && isLikelyOfficialDomain(domain) ? candidateNameFromDomain(domain) : null;
      const name = titleName ?? domainName;
      if (!name) continue;
      const domains = domain && isLikelyOfficialDomain(domain) ? [domain] : [];
      const key = canonicalCandidateKey(name, domains);
      const existing = candidates.get(key) ?? {
        canonicalName: name,
        domains: new Set<string>(),
        urls: new Set<string>(),
        supportingQueries: new Set<string>(),
        evidenceCount: 0,
        similarity: 0,
      };
      if (titleName && titleName.length > existing.canonicalName.length) {
        existing.canonicalName = titleName;
      }
      domains.forEach((item) => existing.domains.add(item));
      if (url) existing.urls.add(url);
      existing.supportingQueries.add(query);
      existing.evidenceCount += 1;
      existing.similarity = Math.max(
        existing.similarity,
        similarity(target, name),
        domainName ? similarity(target, domainName) : 0,
      );
      candidates.set(key, existing);
    }
  }

  return [...candidates.values()]
    .map((candidate) => {
      const domains = [...candidate.domains];
      const evidenceBoost = Math.min(0.18, Math.max(0, candidate.evidenceCount - 1) * 0.045);
      const officialDomainBoost = domains.length ? 0.12 : 0;
      const corporateNameBoost = /\b(inc|llc|corp|corporation|ltd|limited|group|industries|systems|solutions|technologies)\b/i.test(
        candidate.canonicalName,
      )
        ? 0.04
        : 0;
      const score = Math.min(
        1,
        candidate.similarity * 0.72 + evidenceBoost + officialDomainBoost + corporateNameBoost,
      );
      return {
        canonicalName: candidate.canonicalName,
        normalizedName: normalizedComparable(candidate.canonicalName),
        domains,
        urls: [...candidate.urls],
        supportingQueries: [...candidate.supportingQueries],
        evidenceCount: candidate.evidenceCount,
        similarity: Number(candidate.similarity.toFixed(3)),
        score: Number(score.toFixed(3)),
      };
    })
    .filter((candidate) => candidate.similarity >= 0.42 || candidate.score >= 0.58)
    .sort((left, right) => right.score - left.score || right.evidenceCount - left.evidenceCount)
    .slice(0, 6);
}

function resolutionIsResolved(value: MeriExternalEntityResolution): boolean {
  return value.resolutionStatus === 'resolved' && Boolean(value.resolvedEntity);
}

function resolvedName(value: MeriExternalEntityResolution): string | null {
  return value.resolvedEntity?.canonicalName?.trim() || null;
}

function resolvedDomains(value: MeriExternalEntityResolution): string[] {
  return Array.isArray(value.resolvedEntity?.domains)
    ? value.resolvedEntity!.domains.filter((item): item is string => typeof item === 'string')
    : [];
}

function selectedCandidateForResolution(
  candidates: MeriExternalCompanyCandidate[],
  resolution: MeriExternalEntityResolution,
): MeriExternalCompanyCandidate | null {
  const name = resolvedName(resolution);
  const domains = resolvedDomains(resolution).map(registrableDomain);
  if (!name && !domains.length) return candidates[0] ?? null;
  return (
    candidates.find((candidate) => {
      if (name && similarity(name, candidate.canonicalName) >= 0.82) return true;
      return candidate.domains.some((domain) => domains.includes(registrableDomain(domain)));
    }) ??
    candidates[0] ??
    null
  );
}

function provisionalCandidate(
  candidates: MeriExternalCompanyCandidate[],
): { candidate: MeriExternalCompanyCandidate | null; ambiguityReason: string | null } {
  const first = candidates[0];
  if (!first) return { candidate: null, ambiguityReason: 'No credible company candidate was found.' };
  const second = candidates[1];
  const lead = second ? first.score - second.score : first.score;
  const corroborated = first.evidenceCount >= 2 || first.supportingQueries.length >= 2;
  const hasOfficialDomain = first.domains.length > 0;
  if (first.score >= 0.72 && corroborated && hasOfficialDomain && (!second || lead >= 0.1)) {
    return { candidate: first, ambiguityReason: null };
  }
  if (second && lead < 0.1) {
    return {
      candidate: null,
      ambiguityReason: `Multiple similarly plausible companies remain (${first.canonicalName} and ${second.canonicalName}).`,
    };
  }
  return {
    candidate: null,
    ambiguityReason: `The strongest candidate (${first.canonicalName}) lacks enough independent identity evidence.`,
  };
}

/**
 * Resilient external-company discovery for Meri.
 *
 * This is deliberately a read-only skill layered over existing governed tools.
 * It does not persist canonical entities or write to the Knowledge Plane. The
 * workflow first attempts exact resolution, then runs typo-tolerant, unquoted
 * public discovery, derives candidate legal names/domains, re-runs registry
 * resolution on the best candidates, and finally verifies a likely official
 * site. Asking the user for an identifier is the last resort, not the first.
 */
export async function executeMeriExternalCompanyDiscovery(
  input: string,
  invoke: MeriUnderlyingToolInvoker,
): Promise<MeriExternalCompanyDiscovery> {
  const normalizedInput = humanizeExternalCompanyInput(input);
  const queryVariants = externalCompanyQueryVariants(input);
  const sources: SourceResult[] = [];

  const exactResolution = await executeMeriExternalEntityResolution(input, invoke);
  if (resolutionIsResolved(exactResolution)) {
    const domain = resolvedDomains(exactResolution)[0] ?? probableDomain(input);
    const officialSite = domain
      ? await safeInvoke(invoke, 'scrape_web_page', { url: `https://${domain}` })
      : null;
    if (officialSite) sources.push(officialSite);
    return {
      input,
      normalizedInput,
      queryVariants,
      correctionApplied: false,
      identityStatus: 'resolved',
      researchName: resolvedName(exactResolution) ?? normalizedInput,
      resolution: exactResolution,
      candidates: [],
      selectedCandidate: null,
      officialSite,
      sources,
      ambiguityReason: null,
    };
  }

  const webResults = await Promise.all(
    queryVariants.map(async (query) => ({
      query,
      source: await safeInvoke(invoke, 'search_public_web', { query, limit: 10 }),
    })),
  );
  sources.push(...webResults.map((item) => item.source));
  const candidates = webCandidates(input, webResults);

  const refined = await Promise.all(
    candidates.slice(0, 3).map(async (candidate) => ({
      candidate,
      resolution: await executeMeriExternalEntityResolution(candidate.canonicalName, invoke),
    })),
  );
  const resolvedRefinement = refined.find((item) => resolutionIsResolved(item.resolution));
  const resolution = resolvedRefinement?.resolution ?? exactResolution;
  const selectedFromResolution = resolvedRefinement
    ? selectedCandidateForResolution(candidates, resolution)
    : null;
  const provisional = selectedFromResolution
    ? { candidate: selectedFromResolution, ambiguityReason: null }
    : provisionalCandidate(candidates);
  const selectedCandidate = provisional.candidate;
  const domain =
    resolvedDomains(resolution)[0] ??
    selectedCandidate?.domains[0] ??
    probableDomain(input);
  const officialSite = domain
    ? await safeInvoke(invoke, 'scrape_web_page', { url: `https://${domain}` })
    : null;
  if (officialSite) sources.push(officialSite);

  const officialSiteUsable =
    officialSite != null &&
    !(
      isRecord(officialSite.result) &&
      typeof officialSite.result.error === 'string'
    );
  const resolved = resolutionIsResolved(resolution);
  const provisionalUsable = Boolean(selectedCandidate && officialSiteUsable);
  const identityStatus: MeriExternalCompanyIdentityStatus = resolved
    ? 'resolved'
    : provisionalUsable
      ? 'provisional'
      : candidates.length > 1 || provisional.ambiguityReason
        ? 'ambiguous'
        : 'not_found';
  const researchName =
    resolvedName(resolution) ?? selectedCandidate?.canonicalName ?? normalizedInput;

  return {
    input,
    normalizedInput,
    queryVariants,
    correctionApplied:
      normalizedComparable(researchName) !== normalizedComparable(input),
    identityStatus,
    researchName,
    resolution,
    candidates,
    selectedCandidate,
    officialSite,
    sources,
    ambiguityReason:
      identityStatus === 'resolved' || identityStatus === 'provisional'
        ? null
        : provisional.ambiguityReason,
  };
}
