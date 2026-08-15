import type { MeriContext } from '@capiro/meriv2-core';
import {
  buildMeriExternalEntityResolution,
  type MeriEntityResolutionSource,
  type MeriExternalEntityResolution,
} from '../retrieval/meri-external-entity-resolution.js';
import { meriToolRows } from '../retrieval/meri-retrieval-coverage.js';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import { meriToolCoverageCatalogEntry } from '../retrieval/meri-tool-catalog.js';

export type MeriUnderlyingToolInvoker = (
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface MeriRetrievalRecipeContext {
  plan: MeriRetrievalPlan;
  meriContext: MeriContext;
  invoke: MeriUnderlyingToolInvoker;
}

export interface MeriRecipeEvidence {
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

export interface SourceResult {
  tool: string;
  result: unknown;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
/**
 * Occurrence timestamps are ordered ahead of generic row mutation times.
 * Deadline fields are deliberately NOT in this list: a future dueDate is not
 * evidence that something happened during a requested change window.
 */
const DATE_FIELDS = [
  'occurredAt',
  'sentAt',
  'receivedAt',
  'lastMessageAt',
  'actionDate',
  'latestActionDate',
  'statusAt',
  'startsAt',
  'endedAt',
  'completedAt',
  'publishedAt',
  'filingDate',
  'createdAt',
  'updatedAt',
  'date',
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

export function resultRows(result: unknown): unknown[] {
  const rows = meriToolRows(result);
  if (rows.length) return rows;
  if (!isRecord(result)) return [];
  if (
    firstString(result, [...NAME_FIELDS, ...SNIPPET_FIELDS]) ||
    Array.isArray(result.topContracts) ||
    Array.isArray(result.topGrants)
  ) {
    return [result];
  }
  return [];
}

function selectedMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'status',
    'type',
    'fromEmail',
    'fromName',
    'recipientCount',
    'overdue',
    'priority',
    'dueDate',
    'deadline',
    'agency',
    'amount',
    'uei',
    'cageCode',
    'naics',
    'naicsCode',
    'naicsCodes',
    'psc',
    'pscCode',
    'peCode',
    'policyArea',
    'service',
    'serviceBranch',
    'threadId',
    'mailbox',
    'folder',
    'hasAttachments',
  ]) {
    if (record[key] !== undefined && record[key] !== null) out[key] = record[key];
  }
  if (isRecord(record.from)) {
    out.from = {
      email: stringValue(record.from.email),
      name: stringValue(record.from.name),
    };
  }
  for (const key of ['to', 'cc', 'toRecipients']) {
    if (Array.isArray(record[key])) out[key] = record[key].slice(0, 8);
  }
  return out;
}

export function evidenceRows(tool: string, result: unknown, max = 8): MeriRecipeEvidence[] {
  const rows = resultRows(result);
  const out: MeriRecipeEvidence[] = [];
  rows.slice(0, max).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const id = firstString(raw, ID_FIELDS) ?? `${tool}-${index + 1}`;
    const title = firstString(raw, NAME_FIELDS) ?? `${tool} result ${index + 1}`;
    const snippet = firstString(raw, SNIPPET_FIELDS) ?? `Structured record returned by ${tool}.`;
    const clientId =
      stringValue(raw.clientId) ??
      (isRecord(raw.client) ? stringValue(raw.client.id) : null);
    const clientName = firstClientName(raw);
    const occurredAt = firstIsoDate(raw);
    const metadata = selectedMetadata(raw);
    out.push({
      id,
      title: title.slice(0, 200),
      url: firstUrl(raw),
      snippet: snippet.slice(0, 600),
      sourceTool: tool,
      ...(clientId ? { clientId } : {}),
      ...(clientName ? { clientName } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
  });
  return out;
}

export function uniqueEvidence(rows: readonly MeriRecipeEvidence[]): MeriRecipeEvidence[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.sourceTool}:${row.id}:${row.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resultHasError(result: unknown): boolean {
  return isRecord(result) && typeof result.error === 'string';
}

export function resultHasMore(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const returned = numberValue(result.returned) ?? resultRows(result).length;
  const total = numberValue(result.total) ?? numberValue(result.totalMatches);
  return result.hasMore === true || result.nextCursor != null || (total != null && total > returned);
}

function hasExplicitCompleteness(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result.paginationComplete === true) return true;
  return isRecord(result.coverage) && result.coverage.complete === true;
}

export async function safeInvoke(
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

export async function safePagedLda(
  invoke: MeriUnderlyingToolInvoker,
  input: Record<string, unknown>,
  maxPages = 4,
): Promise<SourceResult> {
  const limit = Math.min(Math.max(numberValue(input.limit) ?? 25, 1), 50);
  let page = Math.max(numberValue(input.page) ?? 1, 1);
  let total: number | null = null;
  let last: Record<string, unknown> = {};
  const combined: unknown[] = [];
  let hasMore = false;
  let pagesScanned = 0;

  for (let index = 0; index < maxPages; index += 1) {
    const source = await safeInvoke(invoke, 'search_lda_filings', { ...input, page, limit });
    if (resultHasError(source.result)) {
      if (!combined.length) return source;
      last = { error: (source.result as Record<string, unknown>).error };
      hasMore = true;
      break;
    }
    if (!isRecord(source.result)) break;
    last = source.result;
    pagesScanned += 1;
    const rows = resultRows(source.result);
    combined.push(...rows);
    total = numberValue(source.result.total) ?? numberValue(source.result.totalMatches) ?? total;
    hasMore =
      source.result.hasMore === true ||
      source.result.nextCursor != null ||
      (total != null ? total > combined.length : rows.length >= limit);
    if (!hasMore) break;
    page += 1;
  }

  return {
    tool: 'search_lda_filings',
    result: {
      ...last,
      results: combined,
      returned: combined.length,
      ...(total != null ? { total } : {}),
      hasMore,
      paginationComplete: !hasMore,
      pagesScanned,
    },
  };
}

export async function parallelMapLimit<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!values.length) return [];
  const out = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        out[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function resolvedEntityOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.resolvedEntity) ? value.resolvedEntity : null;
}

export function resolutionTerms(target: string, resolution: unknown): string[] {
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
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))].slice(0, 5);
}

export function resolvedClientId(resolution: unknown): string | null {
  const entity = resolvedEntityOf(resolution);
  return stringValue(entity?.clientId);
}

export function recipeCoverage(
  requestedDomains: string[],
  sources: readonly SourceResult[],
  requestedEntityCount?: number,
  searchedEntityCount?: number,
) {
  const errors = sources.filter((source) => resultHasError(source.result));
  const hasMore = sources.some((source) => resultHasMore(source.result));
  const partialSources = sources
    .filter(
      (source) =>
        resultHasMore(source.result) ||
        (!hasExplicitCompleteness(source.result) &&
          !meriToolCoverageCatalogEntry(source.tool).exhaustive),
    )
    .map((source) => source.tool);
  return {
    complete:
      errors.length === 0 &&
      !hasMore &&
      partialSources.length === 0 &&
      (requestedEntityCount == null || (searchedEntityCount ?? 0) >= requestedEntityCount),
    requestedDomains,
    searchedDomains: [
      ...new Set(sources.flatMap((source) => meriToolCoverageCatalogEntry(source.tool).domains)),
    ],
    requestedEntityCount,
    searchedEntityCount,
    paginationComplete: !hasMore,
    partialSources: [...new Set(partialSources)],
    unavailableSources: errors.map((source) => ({
      source: source.tool,
      reason: isRecord(source.result) ? String(source.result.error ?? 'error') : 'error',
    })),
  };
}

export function parseWindow(
  input: Record<string, unknown>,
  plan: MeriRetrievalPlan,
): { from: Date; to: Date; withinDays: number } {
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

export function withinWindow(row: MeriRecipeEvidence, from: Date, to: Date): boolean {
  if (!row.occurredAt) return false;
  const timestamp = new Date(row.occurredAt).getTime();
  return Number.isFinite(timestamp) && timestamp >= from.getTime() && timestamp <= to.getTime();
}

export function attentionItem(row: MeriRecipeEvidence): boolean {
  const status = String(row.metadata?.status ?? '').toLowerCase();
  return row.metadata?.overdue === true || /new|open|todo|in_progress|blocked/.test(status);
}

export function actualClientId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const context = isRecord(result.context) ? result.context : null;
  const client = context && isRecord(context.client) ? context.client : null;
  const value = stringValue(client?.id);
  return value && UUID_RE.test(value) ? value : null;
}

export function clientNameFromContext(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const context = isRecord(result.context) ? result.context : null;
  const client = context && isRecord(context.client) ? context.client : null;
  return stringValue(client?.name);
}

export function opportunityPosture(
  result: unknown,
  clientId: string,
  clientName: string,
): Record<string, unknown> | null {
  if (!isRecord(result) || resultHasError(result)) return null;
  const pickArray = (key: string) => (Array.isArray(result[key]) ? result[key].slice(0, 3) : []);
  return {
    clientId,
    clientName,
    ...(result.counts !== undefined ? { counts: result.counts } : {}),
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
    ...(result.nextDeadline !== undefined ? { nextDeadline: result.nextDeadline } : {}),
    topGrants: pickArray('topGrants'),
    topContracts: pickArray('topContracts'),
    ...(result.sourceFreshness !== undefined ? { sourceFreshness: result.sourceFreshness } : {}),
    ...(result.freshness !== undefined ? { freshness: result.freshness } : {}),
    ...(Array.isArray(result.missingProfileFields)
      ? { missingProfileFields: result.missingProfileFields.slice(0, 20) }
      : {}),
  };
}

export function sourceCount(sources: readonly SourceResult[], tool: string): number {
  return sources
    .filter((source) => source.tool === tool)
    .reduce((sum, source) => sum + resultRows(source.result).length, 0);
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
