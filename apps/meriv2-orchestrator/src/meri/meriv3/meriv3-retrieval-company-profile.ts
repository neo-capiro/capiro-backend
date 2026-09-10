import {
  evidenceRows,
  isRecord,
  resultHasError,
  resultRows,
  safeInvoke,
  stringValue,
  uniqueEvidence,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

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

function recordString(record: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = stringValue(record[field]);
    if (value) return value;
  }
  return null;
}

function recordsFrom(result: unknown): Record<string, unknown>[] {
  const rows = resultRows(result).filter(isRecord);
  if (!isRecord(result)) return rows;
  const extras = [
    isRecord(result.client) ? result.client : null,
    isRecord(result.context) ? result.context : null,
    isRecord(result.resolvedEntity) ? result.resolvedEntity : null,
  ].filter((value): value is Record<string, unknown> => Boolean(value));
  return [...extras, ...rows];
}

function hostname(value: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return null;
  }
}

function rootDomain(value: string): string {
  const parts = value.split('.').filter(Boolean);
  return parts.length <= 2 ? value : parts.slice(-2).join('.');
}

function usableOfficialDomain(value: string | null): value is string {
  if (!value) return false;
  const root = rootDomain(value);
  return ![...NON_OFFICIAL_DOMAINS].some(
    (blocked) => root === blocked || root.endsWith(`.${blocked}`),
  );
}

function domainsFrom(sources: readonly SourceResult[]): string[] {
  const candidates: string[] = [];
  for (const source of sources) {
    for (const record of recordsFrom(source.result)) {
      for (const field of [
        'domain',
        'verifiedDomain',
        'companyDomain',
        'website',
        'url',
        'officialWebsite',
      ]) {
        const raw = stringValue(record[field]);
        const domain = raw ? hostname(raw) : null;
        if (usableOfficialDomain(domain)) candidates.push(domain);
      }
      if (Array.isArray(record.domains)) {
        for (const raw of record.domains) {
          const domain = typeof raw === 'string' ? hostname(raw) : null;
          if (usableOfficialDomain(domain)) candidates.push(domain);
        }
      }
    }
  }
  return [...new Set(candidates)].slice(0, 5);
}

function canonicalName(target: string, sources: readonly SourceResult[]): string {
  for (const source of sources) {
    for (const record of recordsFrom(source.result)) {
      const name = recordString(record, [
        'canonicalName',
        'officialName',
        'companyName',
        'clientName',
        'name',
        'title',
      ]);
      if (name && !/^search_/i.test(name)) return name;
    }
  }
  return target;
}

function sourceHasEvidence(source: SourceResult): boolean {
  return !resultHasError(source.result) && recordsFrom(source.result).length > 0;
}

function sourceDomain(source: SourceResult): 'clients' | 'internal_research' | 'public_web' {
  if (source.tool === 'lookup_client_registry') return 'clients';
  if (source.tool === 'search_research_sources') return 'internal_research';
  return 'public_web';
}

/**
 * Bounded company profile retrieval for ordinary questions such as
 * "What does Overland AI do?". This intentionally does not search LDA, SEC,
 * awards, SAM, grants, Program Elements, or report language. Those lanes remain
 * available through the federal-market recipes when the user actually asks for
 * strategy, opportunities, contracts, grants, or budget alignment.
 */
export async function executeMeriQuickCompanyProfile(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };

  const [clientRegistry, internalResearch, publicWeb] = await Promise.all([
    safeInvoke(ctx.invoke, 'lookup_client_registry', { name: target }),
    safeInvoke(ctx.invoke, 'search_research_sources', { query: target, limit: 10 }),
    safeInvoke(ctx.invoke, 'search_public_web', {
      query: `${target} official company capabilities products services`,
      limit: 8,
    }),
  ]);
  const sources: SourceResult[] = [clientRegistry, internalResearch, publicWeb];
  const domains = domainsFrom(sources);
  if (domains[0]) {
    sources.push(await safeInvoke(ctx.invoke, 'scrape_web_page', { url: `https://${domains[0]}` }));
  }

  const name = canonicalName(target, sources);
  const evidence = uniqueEvidence(
    sources.flatMap((source) => evidenceRows(source.tool, source.result, 12)),
  );
  const successfulSources = sources.filter(sourceHasEvidence);
  const unavailable = sources.filter((source) => resultHasError(source.result));
  const complete = successfulSources.length > 0;

  return {
    tool: 'research_external_company',
    profileMode: 'quick',
    subject: target,
    researchSubject: name,
    resolvedEntity: {
      canonicalName: name,
      domains,
      identifiers: {},
      provenance: successfulSources.map((source) => source.tool),
    },
    resolutionStatus: complete ? 'resolved' : 'not_found',
    publicCapabilities: evidence.filter((row) =>
      ['search_public_web', 'scrape_web_page', 'search_research_sources'].includes(row.sourceTool),
    ),
    results: evidence.slice(0, 30),
    coverage: {
      complete,
      authoritative: true,
      requestedDomains: ['clients', 'internal_research', 'public_web'],
      searchedDomains: [...new Set(successfulSources.map(sourceDomain))],
      requestedEntityCount: 1,
      searchedEntityCount: complete ? 1 : 0,
      paginationComplete: true,
      partialSources: [],
      unavailableSources: complete
        ? []
        : unavailable.map((source) => ({
            source: source.tool,
            reason:
              isRecord(source.result) && typeof source.result.error === 'string'
                ? source.result.error
                : 'unavailable',
          })),
    },
    answerDirective:
      'Answer the company-description question directly and concisely from the retrieved client/official/public evidence. Explain the company’s core product or service, who it serves, and the practical outcome. Use only the numbered [N] citations supplied with this tool result; never expose internal [S:tool:id] markers. Do not discuss LDA, SEC, awards, SAM, grants, Program Elements, legislative context, entity fan-out, tool execution, coverage plumbing, or failed optional sources unless the user asked for those subjects.',
    nextRecommendedTools: [],
    note: 'This is the bounded company-profile lane. Federal-market and opportunity research was intentionally not run because the request did not require it.',
  };
}
