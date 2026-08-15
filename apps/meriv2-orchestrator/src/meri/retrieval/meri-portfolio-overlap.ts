import type { MeriFederalMarketSignals } from './meri-federal-market-signals.js';

export interface MeriClientOverlapSignals {
  capabilityTerms: string[];
  agencies: string[];
  serviceBranches: string[];
  naicsCodes: string[];
  pscCodes: string[];
  peCodes: string[];
  profileGaps: string[];
}

export interface MeriPortfolioOverlapScore {
  score: number;
  evidenceCoverage: number;
  confidence: 'high' | 'medium' | 'low';
  dimensions: {
    capability: number | null;
    programElement: number | null;
    agency: number | null;
    serviceBranch: number | null;
    naics: number | null;
    psc: number | null;
  };
  matchedTerms: string[];
  matchedPeCodes: string[];
  matchedAgencies: string[];
  matchedServiceBranches: string[];
  matchedNaicsCodes: string[];
  matchedPscCodes: string[];
  reasons: string[];
}

const STOPWORDS = new Set([
  'about',
  'against',
  'also',
  'and',
  'are',
  'client',
  'company',
  'federal',
  'from',
  'have',
  'other',
  'services',
  'solutions',
  'their',
  'this',
  'with',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringsFrom(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringsFrom);
  return [];
}

function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function addCode(target: Set<string>, raw: string, kind: 'naics' | 'psc' | 'pe'): void {
  for (const part of raw.split(/[\s,;|/]+/)) {
    const value = part.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (kind === 'naics' && /^\d{6}$/.test(value)) target.add(value);
    if (kind === 'psc' && /^[A-Z0-9]{4}$/.test(value)) target.add(value);
    if (
      kind === 'pe' &&
      (/^\d{7}[A-Z]$/.test(value) || /^\d{4}[A-Z]\d{4}$/.test(value))
    ) {
      target.add(value);
    }
  }
}

export function extractMeriClientOverlapSignals(
  clientContext: unknown,
  opportunityContext?: unknown,
): MeriClientOverlapSignals {
  const capabilityText: string[] = [];
  const agencies = new Set<string>();
  const services = new Set<string>();
  const naics = new Set<string>();
  const psc = new Set<string>();
  const pe = new Set<string>();
  const profileGaps = new Set<string>();

  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((item) => walk(item, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, raw] of Object.entries(value)) {
      const lower = key.toLowerCase();
      const strings = stringsFrom(raw);
      if (
        /name|title|description|product|capabilit|sector|mission|appropriation|program|outcome/.test(
          lower,
        )
      ) {
        capabilityText.push(...strings);
      }
      if (/agency|department|command|customer/.test(lower)) {
        strings.forEach((item) => agencies.add(item));
      }
      if (/servicebranch|service_branch|militaryservice/.test(lower)) {
        strings.forEach((item) => services.add(item));
      }
      if (/naics/.test(lower)) strings.forEach((item) => addCode(naics, item, 'naics'));
      if (/psc|productservicecode/.test(lower)) strings.forEach((item) => addCode(psc, item, 'psc'));
      if (/pecode|penumber|penumbers|programelement/.test(lower)) {
        strings.forEach((item) => addCode(pe, item, 'pe'));
      }
      if (/missing.*field|profilegap|missingprofile/.test(lower)) {
        strings.forEach((item) => profileGaps.add(item));
      }
      if (typeof raw === 'object') walk(raw, depth + 1);
    }
  };

  walk(clientContext, 0);
  walk(opportunityContext, 0);

  const tokenCounts = new Map<string, number>();
  for (const text of capabilityText) {
    for (const token of new Set(normalizedTokens(text))) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }

  return {
    capabilityTerms: [...tokenCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30)
      .map(([term]) => term),
    agencies: [...agencies].slice(0, 30),
    serviceBranches: [...services].slice(0, 12),
    naicsCodes: [...naics].slice(0, 20),
    pscCodes: [...psc].slice(0, 20),
    peCodes: [...pe].slice(0, 30),
    profileGaps: [...profileGaps].slice(0, 20),
  };
}

function normalized(value: string): string {
  return value.toLowerCase().trim();
}

function overlap(
  left: readonly string[],
  right: readonly string[],
): { score: number | null; matches: string[] } {
  if (!left.length || !right.length) return { score: null, matches: [] };
  const leftByNormalized = new Map<string, string>();
  for (const value of left) {
    const key = normalized(value);
    if (key && !leftByNormalized.has(key)) leftByNormalized.set(key, value.trim());
  }
  const rightSet = new Set(right.map(normalized).filter(Boolean));
  const matches = [...leftByNormalized.entries()]
    .filter(([key]) => rightSet.has(key))
    .map(([, display]) => display);
  return {
    score: matches.length / Math.max(1, Math.min(leftByNormalized.size, rightSet.size)),
    matches,
  };
}

export function scoreMeriPortfolioOverlap(
  company: MeriFederalMarketSignals,
  client: MeriClientOverlapSignals,
): MeriPortfolioOverlapScore {
  const capability = overlap(company.capabilityTerms, client.capabilityTerms);
  const programElement = overlap(company.peCodes, client.peCodes);
  const agency = overlap(company.agencies, client.agencies);
  const serviceBranch = overlap(company.serviceBranches, client.serviceBranches);
  const naics = overlap(company.naicsCodes, client.naicsCodes);
  const psc = overlap(company.pscCodes, client.pscCodes);

  const weighted = [
    { weight: 0.4, value: capability.score },
    { weight: 0.2, value: programElement.score },
    { weight: 0.15, value: agency.score },
    { weight: 0.1, value: serviceBranch.score },
    { weight: 0.1, value: naics.score },
    { weight: 0.05, value: psc.score },
  ] as const;
  const availableWeight = weighted.reduce(
    (sum, item) => sum + (item.value == null ? 0 : item.weight),
    0,
  );
  const raw = availableWeight
    ? weighted.reduce(
        (sum, item) => sum + (item.value == null ? 0 : item.value * item.weight),
        0,
      ) / availableWeight
    : 0;
  const calibrated = raw * (0.65 + 0.35 * availableWeight);
  const structuredMatches =
    programElement.matches.length +
    agency.matches.length +
    serviceBranch.matches.length +
    naics.matches.length +
    psc.matches.length;
  const confidence: MeriPortfolioOverlapScore['confidence'] =
    availableWeight >= 0.65 && structuredMatches >= 2
      ? 'high'
      : structuredMatches >= 1 ||
          (availableWeight >= 0.55 && capability.matches.length >= 3)
        ? 'medium'
        : 'low';

  const reasons: string[] = [];
  if (capability.matches.length) {
    reasons.push(`Capability overlap: ${capability.matches.slice(0, 8).join(', ')}`);
  }
  if (programElement.matches.length) {
    reasons.push(`Shared Program Elements: ${programElement.matches.join(', ')}`);
  }
  if (agency.matches.length) {
    reasons.push(`Shared agency/customer signals: ${agency.matches.join(', ')}`);
  }
  if (serviceBranch.matches.length) {
    reasons.push(`Shared service focus: ${serviceBranch.matches.join(', ')}`);
  }
  if (naics.matches.length) reasons.push(`Shared NAICS: ${naics.matches.join(', ')}`);
  if (psc.matches.length) reasons.push(`Shared PSC: ${psc.matches.join(', ')}`);
  if (!reasons.length) {
    reasons.push('No corroborated structured overlap was found in the retrieved profiles.');
  }

  return {
    score: Number(calibrated.toFixed(3)),
    evidenceCoverage: Number(availableWeight.toFixed(3)),
    confidence,
    dimensions: {
      capability: capability.score == null ? null : Number(capability.score.toFixed(3)),
      programElement:
        programElement.score == null ? null : Number(programElement.score.toFixed(3)),
      agency: agency.score == null ? null : Number(agency.score.toFixed(3)),
      serviceBranch:
        serviceBranch.score == null ? null : Number(serviceBranch.score.toFixed(3)),
      naics: naics.score == null ? null : Number(naics.score.toFixed(3)),
      psc: psc.score == null ? null : Number(psc.score.toFixed(3)),
    },
    matchedTerms: capability.matches.slice(0, 20),
    matchedPeCodes: programElement.matches,
    matchedAgencies: agency.matches,
    matchedServiceBranches: serviceBranch.matches,
    matchedNaicsCodes: naics.matches,
    matchedPscCodes: psc.matches,
    reasons,
  };
}
