import type { MeriContext } from '@capiro/meriv2-core';
import {
  buildMeriExternalEntityResolution,
  type MeriEntityResolutionSource,
  type MeriExternalEntityResolution,
} from '../retrieval/meri-external-entity-resolution.js';
import { meriToolRows } from '../retrieval/meri-retrieval-coverage.js';
import type {
  MeriRetrievalPlan,
  MeriRetrievalRecipeTool,
} from '../retrieval/meri-retrieval-plan.js';

export interface MeriRetrievalToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type MeriUnderlyingToolInvoker = (
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface MeriRetrievalRecipeContext {
  plan: MeriRetrievalPlan;
  meriContext: MeriContext;
  invoke: MeriUnderlyingToolInvoker;
}

interface MeriRecipeEvidence {
  id: string;
  title: string;
  url: string | null;
  snippet: string;
  sourceTool: string;
  clientId?: string;
  clientName?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

interface SourceResult {
  tool: string;
  result: unknown;
}

const stringSchema = (description: string) => ({ type: 'string', description });
const integerSchema = (description: string) => ({ type: 'integer', description });

export const MERI_RETRIEVAL_TOOL_SCHEMAS: MeriRetrievalToolSchema[] = [
  {
    name: 'query_relationship_brief',
    description:
      'Deterministically retrieve an entity-aware relationship and inbox brief across resolved aliases/domains, synchronized email, contacts, internal research, memory, and client-specific operational records when the entity is a client. Use FIRST for “everything I should know”, “catch me up”, relationship-history, and inbox-brief requests. Returns evidence plus a coverage manifest; zero matches are not proof of absence when coverage.complete is false.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('Company, organization, or person to investigate'),
        withinDays: integerSchema('Optional recency window in days (1-3650)'),
      },
      required: ['entity'],
    },
  },
  {
    name: 'query_portfolio_changes',
    description:
      'Deterministically scan the authorized active client portfolio for recent tasks, action items, outreach, mail, debriefs, and tracked-bill movement. Use FIRST for “what changed across my clients”, weekly portfolio briefs, and portfolio catch-ups. Returns dated changes, carryover attention items, client fan-out coverage, pagination gaps, and unavailable sources.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        withinDays: integerSchema('Window in days (default 7, max 365)'),
        from: stringSchema('Optional ISO date/time lower bound'),
        to: stringSchema('Optional ISO date/time upper bound'),
      },
    },
  },
  {
    name: 'research_external_company',
    description:
      'Resolve and research a company whether or not it is a Capiro client. Searches internal identity signals, LDA/SEC/award registries, public web results, SAM opportunities, grants, and authorized internal context. Use FIRST for external-company profiles and federal-market strategy requests, then use specialist PE/budget tools to validate any program recommendations.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('Company or organization name, alias, or domain'),
      },
      required: ['entity'],
    },
  },
  {
    name: 'query_portfolio_overlap',
    description:
      'Resolve/research an external company, scan every authorized active client profile, and rank portfolio overlap from actual client capabilities, programs, sectors, submissions, and company evidence. Use FIRST for partner, teaming, overlap, or “search across clients” requests. This is not keyword-only search and reports exactly how many clients were scanned.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: stringSchema('External company or organization to compare against the portfolio'),
      },
      required: ['entity'],
    },
  },
];

const NAME_FIELDS = [
  'title',
  'name',
  'subject',
  'companyName',
  'clientName',
  'registrantName',
  'identifier',
  'billNumber',
  'headline',
] as const;
const ID_FIELDS = [
  'id',
  'clientId',
  'billId',
  'threadId',
  'messageId',
  'accessionNumber',
  'identifier',
  'solicitationNumber',
] as const;
const URL_FIELDS = [
  'url',
  'link',
  'sourceUrl',
  'webUrl',
  'officialWebsite',
  'website',
  'documentUrl',
] as const;
const SNIPPET_FIELDS = [
  'bodyText',
  'body',
  'preview',
  'summary',
  'description',
  'snippet',
  'abstract',
  'latestAction',
  'text',
] as const;
const DATE_FIELDS = [
  'updatedAt',
  'createdAt',
  'occurredAt',
  'sentAt',
  'receivedAt',
  'startsAt',
  'endedAt',
  'date',
  'actionDate',
  'latestActionDate',
  'statusAt',
  'publishedAt',
  'filingDate',
  'dueDate',
] as const;
const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'and',
  'are',
  'been',
  'before',
  'being',
  'between',
  'client',
  'company',
  'could',
  'from',
  'have',
  'into',
  'more',
  'other',
  'our',
  'their',
  'they',
  'this',
  'through',
  'using',
  'with',
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

function firstIsoDate(record: Record<string, unknown>): string | null {
  for (const field of DATE_FIELDS) {
    const raw = record[field];
    const value = raw instanceof Date ? raw.toISOString() : stringValue(raw);
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function firstClientName(record: Record<string, unknown>): string | null {
  const direct = stringValue(record.clientName);
  if (direct) return direct;
  if (isRecord(record.client)) return stringValue(record.client.name);
  return null;
}

function firstUrl(record: Record<string, unknown>): string | null {
  const value = firstString(record, URL_FIELDS);
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function selectedMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'status',
    'type',
    'fromEmail',
    'fromName',
    'toRecipients',
    'recipientCount',
    'overdue',
    'priority',
    'agency',
    'amount',
    'uei',
    'cageCode',
    'naicsCode',
    'naicsCodes',
    'peCode',
    'policyArea',
  ]) {
    if (record[key] !== undefined && record[key] !== null) out[key] = record[key];
  }
  return out;
}

function evidenceRows(tool: string, result: unknown, max = 8): MeriRecipeEvidence[] {
  const rows = meriToolRows(result);
  const out: MeriRecipeEvidence[] = [];
  rows.slice(0, max).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const id = firstString(raw, ID_FIELDS) ?? `${tool}-${index + 1}`;
    const title = firstString(raw, NAME_FIELDS) ?? `${tool} result ${index + 1}`;
    const snippet =
      firstString(raw, SNIPPET_FIELDS) ??
      `Structured record returned by ${tool}.`;
    const clientId = stringValue(raw.clientId) ?? (isRecord(raw.client) ? stringValue(raw.client.id) : null);
    const clientName = firstClientName(raw);
    const occurredAt = firstIsoDate(raw);
    const metadata = selectedMetadata(raw);
    out.push({
      id,
      title: title.slice(0, 200),
      url: firstUrl(raw),
      snippet: snippet.slice(0, 420),
      sourceTool: tool,
      ...(clientId ? { clientId } : {}),
      ...(clientName ? { clientName } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
  });
  return out;
}

function uniqueEvidence(rows: readonly MeriRecipeEvidence[]): MeriRecipeEvidence[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.sourceTool}:${row.id}:${row.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resultHasError(result: unknown): boolean {
  return isRecord(result) && typeof result.error === 'string';
}

function resultHasMore(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const returned = typeof result.returned === 'number' ? result.returned : meriToolRows(result).length;
  const total =
    typeof result.total === 'number'
      ? result.total
      : typeof result.totalMatches === 'number'
        ? result.totalMatches
        : null;
  return result.hasMore === true || result.nextCursor != null || (total != null && total > returned);
}

async function safeInvoke(
  invoke: MeriUnderlyingToolInvoker,
  tool: string,
  input: Record<string, unknown>,
): Promise<SourceResult> {
  try {
    return { tool, result: await invoke(tool, input) };
  } catch (error) {
    return {
      tool,
      result: { error: error instanceof Error ? error.message : `${tool} failed` },
    };
  }
}

async function parallelMapLimit<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!values.length) return [];
  const out = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

function resolvedEntityOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.resolvedEntity) ? value.resolvedEntity : null;
}

function resolutionTerms(target: string, resolution: unknown): string[] {
  const entity = resolvedEntityOf(resolution);
  const candidates = [target, stringValue(entity?.canonicalName)];
  if (Array.isArray(entity?.domains)) {
    for (const domain of entity.domains) candidates.push(stringValue(domain));
  }
  if (isRecord(resolution) && Array.isArray(resolution.candidates)) {
    for (const candidate of resolution.candidates.slice(0, 2)) {
      if (isRecord(candidate)) candidates.push(stringValue(candidate.canonicalName));
    }
  }
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))].slice(0, 4);
}

function resolvedClientId(resolution: unknown): string | null {
  const entity = resolvedEntityOf(resolution);
  return stringValue(entity?.clientId);
}

function coverage(
  requestedDomains: string[],
  sources: readonly SourceResult[],
  requestedEntityCount?: number,
  searchedEntityCount?: number,
) {
  const errors = sources.filter((source) => resultHasError(source.result));
  const hasMore = sources.some((source) => resultHasMore(source.result));
  return {
    complete:
      errors.length === 0 &&
      !hasMore &&
      (requestedEntityCount == null || (searchedEntityCount ?? 0) >= requestedEntityCount),
    requestedDomains,
    searchedDomains: [...new Set(sources.map((source) => source.tool))],
    requestedEntityCount,
    searchedEntityCount,
    paginationComplete: !hasMore,
    unavailableSources: errors.map((source) => ({
      source: source.tool,
      reason: isRecord(source.result) ? String(source.result.error ?? 'error') : 'error',
    })),
  };
}

function parseWindow(input: Record<string, unknown>, plan: MeriRetrievalPlan): { from: Date; to: Date; withinDays: number } {
  const now = new Date();
  const requestedDays =
    typeof input.withinDays === 'number' && Number.isFinite(input.withinDays)
      ? Math.min(Math.max(Math.floor(input.withinDays), 1), 365)
      : plan.timeWindow?.withinDays ?? 7;
  const parsedFrom = typeof input.from === 'string' ? new Date(input.from) : null;
  const parsedTo = typeof input.to === 'string' ? new Date(input.to) : null;
  const to = parsedTo && Number.isFinite(parsedTo.getTime()) ? parsedTo : now;
  const from =
    parsedFrom && Number.isFinite(parsedFrom.getTime())
      ? parsedFrom
      : new Date(to.getTime() - requestedDays * 24 * 60 * 60 * 1000);
  return { from, to, withinDays: requestedDays };
}

function withinWindow(row: MeriRecipeEvidence, from: Date, to: Date): boolean {
  if (!row.occurredAt) return false;
  const timestamp = new Date(row.occurredAt).getTime();
  return Number.isFinite(timestamp) && timestamp >= from.getTime() && timestamp <= to.getTime();
}

function attentionItem(row: MeriRecipeEvidence): boolean {
  const status = String(row.metadata?.status ?? '').toLowerCase();
  return row.metadata?.overdue === true || /new|open|todo|in_progress|blocked/.test(status);
}

function textTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token)),
  );
}

function clientSummary(value: unknown, fallbackName: string): { name: string; text: string } {
  if (!isRecord(value)) return { name: fallbackName, text: fallbackName };
  const context = isRecord(value.context) ? value.context : null;
  const client = context && isRecord(context.client) ? context.client : null;
  const profile = isRecord(value.profile) ? value.profile : null;
  const name = stringValue(client?.name) ?? fallbackName;
  const parts = [name, stringValue(client?.description), stringValue(client?.productDescription)];
  for (const key of ['capabilities', 'submissionHistory', 'facilities', 'people']) {
    const rows = profile && Array.isArray(profile[key]) ? profile[key] : [];
    for (const row of rows.slice(0, 30)) {
      if (!isRecord(row)) continue;
      parts.push(
        firstString(row, ['name', 'title', 'description', 'type', 'sector', 'outcomeType']),
      );
      if (Array.isArray(row.peNumbers)) parts.push(row.peNumbers.filter((item) => typeof item === 'string').join(' '));
    }
  }
  return { name, text: parts.filter((part): part is string => Boolean(part)).join(' ') };
}

export async function executeMeriExternalEntityResolution(
  query: string,
  invoke: MeriUnderlyingToolInvoker,
): Promise<MeriExternalEntityResolution> {
  const calls: Array<Promise<SourceResult>> = [
    safeInvoke(invoke, 'resolve_entity', { query, type: 'company', limit: 8 }),
    safeInvoke(invoke, 'lookup_client_registry', { name: query }),
    safeInvoke(invoke, 'search_research_sources', { query, limit: 25 }),
    safeInvoke(invoke, 'search_lda_filings', { clientName: query, limit: 25, page: 1 }),
    safeInvoke(invoke, 'search_sec_filings', { query, limit: 25 }),
    safeInvoke(invoke, 'search_federal_awards', { query, limit: 25 }),
    safeInvoke(invoke, 'search_public_web', {
      query: `"${query}" company official website`,
      limit: 10,
    }),
  ];
  const results = await Promise.all(calls);
  const sources: MeriEntityResolutionSource[] = results.map((source) => ({
    tool: source.tool,
    result: source.result,
  }));
  return buildMeriExternalEntityResolution(query, sources);
}

async function relationshipBrief(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };
  const resolution = await executeMeriExternalEntityResolution(target, ctx.invoke);
  const terms = resolutionTerms(target, resolution);
  const withinDays =
    typeof input.withinDays === 'number'
      ? Math.min(Math.max(Math.floor(input.withinDays), 1), 3650)
      : undefined;
  const sources: SourceResult[] = [{ tool: 'resolve_entity', result: resolution }];

  const emailCalls = terms.slice(0, 3).map((term) =>
    safeInvoke(ctx.invoke, 'search_emails', {
      ...(term.includes('.') && !term.includes(' ') ? { participant: term } : { query: term }),
      ...(withinDays ? { withinDays } : {}),
      limit: 50,
    }),
  );
  const domain = resolution.resolvedEntity?.domains[0];
  const baseCalls = [
    safeInvoke(ctx.invoke, 'find_contacts', {
      ...(domain ? { domain } : { query: resolution.resolvedEntity?.canonicalName ?? target }),
      limit: 100,
    }),
    safeInvoke(ctx.invoke, 'search_research_sources', {
      query: resolution.resolvedEntity?.canonicalName ?? target,
      limit: 25,
    }),
    safeInvoke(ctx.invoke, 'search_memory', {
      query: `relationship, decisions, commitments, and history with ${resolution.resolvedEntity?.canonicalName ?? target}`,
      k: 15,
    }),
  ];
  sources.push(...(await Promise.all([...emailCalls, ...baseCalls])));

  const clientId = resolution.resolvedEntity?.clientId ?? resolvedClientId(resolution);
  if (clientId) {
    sources.push(
      ...(await Promise.all([
        safeInvoke(ctx.invoke, 'get_client_context', { clientId }),
        safeInvoke(ctx.invoke, 'query_debriefs', { clientId }),
        safeInvoke(ctx.invoke, 'query_tasks', { clientId, limit: 50 }),
        safeInvoke(ctx.invoke, 'query_outreach', { clientId, limit: 50 }),
        safeInvoke(ctx.invoke, 'search_tracked_bills', { clientId }),
      ])),
    );
  }

  const evidence = uniqueEvidence(sources.flatMap((source) => evidenceRows(source.tool, source.result, 8)));
  const manifest = coverage(
    ['identity', 'mail', 'contacts', 'internal_research', 'memory'],
    sources,
    1,
    resolution.resolutionStatus === 'not_found' ? 0 : 1,
  );
  return {
    tool: 'query_relationship_brief',
    subject: target,
    resolvedEntity: resolution.resolvedEntity,
    resolutionStatus: resolution.resolutionStatus,
    sections: Object.fromEntries(
      [...new Set(sources.map((source) => source.tool))].map((tool) => [
        tool,
        sources
          .filter((source) => source.tool === tool)
          .reduce((sum, source) => sum + meriToolRows(source.result).length, 0),
      ]),
    ),
    results: evidence.slice(0, 40),
    coverage: manifest,
    note:
      manifest.complete
        ? 'The synchronized sources used by this recipe were fully enumerated for the requested entity and window.'
        : 'The brief is evidence-rich but not exhaustive. Inspect coverage before making a negative claim.',
  };
}

async function portfolioChanges(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const window = parseWindow(input, ctx.plan);
  const activeClients = ctx.plan.activeClients;
  const scopedClients = activeClients.filter((client) => Boolean(client.id));
  const sources: SourceResult[] = await Promise.all([
    safeInvoke(ctx.invoke, 'query_tasks', { limit: 50 }),
    safeInvoke(ctx.invoke, 'query_action_items', { sort: 'priority', limit: 50 }),
    safeInvoke(ctx.invoke, 'query_outreach', { limit: 50 }),
    safeInvoke(ctx.invoke, 'list_emails', { limit: 50 }),
  ]);

  const fanout = await parallelMapLimit(scopedClients, 6, async (client) => {
    const clientSources = await Promise.all([
      safeInvoke(ctx.invoke, 'query_debriefs', { clientId: client.id }),
      safeInvoke(ctx.invoke, 'search_tracked_bills', { clientId: client.id }),
    ]);
    return clientSources.map((source) => ({ ...source, clientId: client.id, clientName: client.name }));
  });
  sources.push(...fanout.flat());

  const allEvidence = uniqueEvidence(
    sources.flatMap((source) => evidenceRows(source.tool, source.result, 50)),
  );
  const changes = allEvidence
    .filter((row) => withinWindow(row, window.from, window.to))
    .sort((a, b) => Date.parse(b.occurredAt ?? '') - Date.parse(a.occurredAt ?? ''));
  const carryover = allEvidence.filter((row) => !withinWindow(row, window.from, window.to) && attentionItem(row));
  const manifest = coverage(
    ['clients', 'mail', 'meetings', 'tasks', 'action_items', 'outreach', 'legislation'],
    sources,
    activeClients.length,
    scopedClients.length,
  );
  return {
    tool: 'query_portfolio_changes',
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      withinDays: window.withinDays,
    },
    summary: {
      activeClients: activeClients.length,
      clientsWithIds: scopedClients.length,
      datedChanges: changes.length,
      carryoverAttentionItems: carryover.length,
    },
    results: changes.slice(0, 50),
    carryoverAttention: carryover.slice(0, 20),
    coverage: manifest,
    note:
      manifest.complete
        ? 'All authorized active clients and required sources were scanned for this window.'
        : 'This scan is partial. Do not state that nothing changed across the portfolio unless coverage.complete is true.',
  };
}

async function externalCompanyResearch(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };
  const resolution = await executeMeriExternalEntityResolution(target, ctx.invoke);
  const canonical = resolution.resolvedEntity?.canonicalName ?? target;
  const sources: SourceResult[] = [{ tool: 'resolve_entity', result: resolution }];
  sources.push(
    ...(await Promise.all([
      safeInvoke(ctx.invoke, 'search_public_web', {
        query: `"${canonical}" official company capabilities products services`,
        limit: 10,
      }),
      safeInvoke(ctx.invoke, 'search_public_web', {
        query: `"${canonical}" government contracts federal customers awards`,
        limit: 10,
      }),
      safeInvoke(ctx.invoke, 'search_lda_filings', { clientName: canonical, limit: 25, page: 1 }),
      safeInvoke(ctx.invoke, 'search_sec_filings', { query: canonical, limit: 25 }),
      safeInvoke(ctx.invoke, 'search_federal_awards', { query: canonical, limit: 50 }),
      safeInvoke(ctx.invoke, 'search_sam_opportunities', { query: canonical, limit: 25 }),
      safeInvoke(ctx.invoke, 'search_federal_grants', { query: canonical, limit: 25 }),
      safeInvoke(ctx.invoke, 'search_research_sources', { query: canonical, limit: 25 }),
      safeInvoke(ctx.invoke, 'search_memory', {
        query: `internal relationships, capabilities, programs, and prior work involving ${canonical}`,
        k: 15,
      }),
    ])),
  );
  const evidence = uniqueEvidence(sources.flatMap((source) => evidenceRows(source.tool, source.result, 10)));
  const manifest = coverage(
    ['identity', 'public_web', 'registries', 'awards', 'opportunities'],
    sources,
    1,
    resolution.resolutionStatus === 'not_found' ? 0 : 1,
  );
  return {
    tool: 'research_external_company',
    subject: target,
    resolvedEntity: resolution.resolvedEntity,
    resolutionStatus: resolution.resolutionStatus,
    results: evidence.slice(0, 50),
    coverage: manifest,
    nextRecommendedTools: [
      'scrape_web_page for the official site returned above',
      'search_program_elements after extracting verified capability terms',
      'get_program_element/get_pe_budget_timeline for every recommended PE or budget line',
    ],
    note:
      'Separate verified company facts from inferred federal-market fit. A company-name search is not proof of eligibility or program alignment.',
  };
}

async function portfolioOverlap(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };
  const company = await externalCompanyResearch({ entity: target }, ctx);
  const companyEvidence = isRecord(company) && Array.isArray(company.results)
    ? (company.results as MeriRecipeEvidence[])
    : [];
  const companyText = companyEvidence.map((row) => `${row.title} ${row.snippet}`).join(' ');
  const companyTokens = textTokens(companyText);
  const activeClients = ctx.plan.activeClients;
  const scopedClients = activeClients.filter((client) => Boolean(client.id));
  const contexts = await parallelMapLimit(scopedClients, 6, async (client) => {
    const source = await safeInvoke(ctx.invoke, 'get_client_context', { clientId: client.id });
    const summary = clientSummary(source.result, client.name);
    const clientTokens = textTokens(summary.text);
    const overlap = [...companyTokens].filter((token) => clientTokens.has(token));
    const denominator = Math.max(1, Math.min(companyTokens.size, 40));
    const score = overlap.length / denominator;
    return {
      client,
      source,
      summary,
      score,
      matchedTerms: overlap.slice(0, 15),
    };
  });
  const ranked = contexts
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      id: entry.client.id ?? entry.client.name,
      title: entry.summary.name,
      url: null,
      snippet:
        entry.matchedTerms.length > 0
          ? `Normalized overlap signals: ${entry.matchedTerms.join(', ')}. Verify the underlying capabilities and strategy before recommending a partnership.`
          : 'No strong normalized capability overlap was found in the retrieved client profile.',
      sourceTool: 'get_client_context',
      clientId: entry.client.id,
      clientName: entry.summary.name,
      metadata: {
        overlapScore: Number(entry.score.toFixed(3)),
        matchedTerms: entry.matchedTerms,
      },
    }));
  const sourceResults = contexts.map((entry) => entry.source);
  const manifest = coverage(
    ['identity', 'clients', 'internal_research'],
    sourceResults,
    activeClients.length,
    scopedClients.length,
  );
  return {
    tool: 'query_portfolio_overlap',
    subject: target,
    companyResearch: company,
    results: ranked.slice(0, 40),
    coverage: manifest,
    note:
      'Overlap scores are deterministic candidate-generation signals, not strategy conclusions. ChatGPT should inspect the cited company and client evidence before recommending teaming.',
  };
}

export function isMeriRetrievalRecipeTool(name: string): name is MeriRetrievalRecipeTool {
  return MERI_RETRIEVAL_TOOL_SCHEMAS.some((schema) => schema.name === name);
}

export async function executeMeriRetrievalRecipe(
  name: MeriRetrievalRecipeTool,
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
): Promise<unknown> {
  switch (name) {
    case 'query_relationship_brief':
      return relationshipBrief(input, ctx);
    case 'query_portfolio_changes':
      return portfolioChanges(input, ctx);
    case 'research_external_company':
      return externalCompanyResearch(input, ctx);
    case 'query_portfolio_overlap':
      return portfolioOverlap(input, ctx);
  }
}
