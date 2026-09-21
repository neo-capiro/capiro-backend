/** Searchable tags already saved on a client's profile. This read-only projection
 * deliberately excludes free-form notes, contacts and private documents. */
export interface ClientProfileKeywordSource {
  sectorTag?: unknown;
  naicsCodes?: unknown;
  pscCodes?: unknown;
  issueCodes?: unknown;
  applicantTypes?: unknown;
  setAsideCertifications?: unknown;
  submissionTracks?: unknown;
  intakeData?: unknown;
}

export interface CapabilityKeywordSource {
  name?: unknown;
  sector?: unknown;
  tags?: unknown;
  keywords?: unknown;
  peNumber?: unknown;
  peNumbers?: unknown;
  issueCodes?: unknown;
  appropriationAccount?: unknown;
}

export interface ClientProfileKeywordGroup {
  label: string;
  terms: string[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function values(value: unknown): string[] {
  const input = Array.isArray(value) ? value : [value];
  return input.flatMap((item) => typeof item === 'string' ? [item] : []);
}

/** Groups retain their provenance in the import preview; all imported values
 * become independent, removable keyword chips in search criteria. */
export function clientProfileKeywordGroups(
  client: ClientProfileKeywordSource,
  capabilities: CapabilityKeywordSource[],
): ClientProfileKeywordGroup[] {
  const intake = object(client.intakeData);
  const seen = new Set<string>();
  const group = (label: string, candidates: unknown[]): ClientProfileKeywordGroup => {
    const terms: string[] = [];
    for (const candidate of candidates.flatMap(values)) {
      const term = candidate.trim().replace(/\s+/g, ' ');
      const key = term.toLocaleLowerCase();
      if (!term || term.length > 120 || seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
    return { label, terms };
  };
  return [
    group('Sectors and program areas', [client.sectorTag, intake.sectors, intake.sector, ...capabilities.map((capability) => capability.sector), intake.portfolio]),
    group('Profile and capability tags', [intake.tags, ...capabilities.map((capability) => capability.tags)]),
    group('Capabilities and keywords', capabilities.flatMap((capability) => [capability.name, capability.keywords])),
    group('Funding priorities', [intake.fundingPriorities]),
    group('Program elements', [intake.peNumber, ...capabilities.flatMap((capability) => [capability.peNumber, capability.peNumbers])]),
    group('Codes and classifications', [client.naicsCodes, client.pscCodes, client.issueCodes, client.applicantTypes, client.setAsideCertifications, client.submissionTracks, intake.primaryNaics, intake.additionalNaics, ...capabilities.flatMap((capability) => [capability.issueCodes, capability.appropriationAccount])]),
  ].filter((item) => item.terms.length > 0);
}
