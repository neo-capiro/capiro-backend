export type ApiToolReadOutcomeKind = 'complete' | 'empty' | 'partial' | 'unavailable' | 'failed';

export interface ApiToolReadOutcome {
  kind: ApiToolReadOutcomeKind;
  reason?: string;
}

type UnknownRecord = Record<string, unknown>;
type SourceStatus = 'healthy' | 'degraded' | 'unavailable';
type RetrievalSourceStatus = SourceStatus | 'unauthorized' | 'unsupported' | 'error';

const SOURCE_STATUSES = new Set<SourceStatus>(['healthy', 'degraded', 'unavailable']);
const RETRIEVAL_SOURCE_STATUSES = new Set<RetrievalSourceStatus>([
  'healthy',
  'degraded',
  'unavailable',
  'unauthorized',
  'unsupported',
  'error',
]);
const CLIENT_SECTION_STATUSES = new Set(['complete', 'partial', 'unavailable', 'not_requested']);
const MEMORY_CONTENT_STATUSES = new Set([
  'available',
  'empty',
  'metadata_only',
  'unavailable',
  'unavailable_or_ineligible',
]);
const BODY_COMPLETENESS = new Set(['full', 'preview', 'truncated', 'unknown']);

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function ownerFailure(payload: unknown): ApiToolReadOutcome | null {
  const value = record(payload);
  if (!value || typeof value.error !== 'string' || !value.error.trim()) return null;
  return { kind: 'failed', reason: value.error.trim() };
}

function invalidResult(toolName: string): ApiToolReadOutcome {
  return { kind: 'failed', reason: `${toolName}_result_contract_invalid` };
}

function classifyMailSearch(toolName: string, payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  const offset = value?.offset === undefined ? 0 : value.offset;
  if (
    !value ||
    !nonnegativeInteger(value.totalMatches) ||
    !nonnegativeInteger(value.returned) ||
    typeof value.hasMore !== 'boolean' ||
    !nonnegativeInteger(offset) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.searchedMailboxes)
  ) {
    return invalidResult(toolName);
  }
  const statuses: SourceStatus[] = [];
  for (const rawMailbox of value.searchedMailboxes) {
    const mailbox = record(rawMailbox);
    const coverage = record(mailbox?.mailCoverage);
    const status = coverage?.sourceStatus;
    if (typeof status !== 'string' || !SOURCE_STATUSES.has(status as SourceStatus)) {
      return invalidResult(toolName);
    }
    statuses.push(status as SourceStatus);
  }
  const noAvailableMailbox =
    statuses.length === 0 || statuses.every((status) => status === 'unavailable');
  if (noAvailableMailbox && value.returned === 0) {
    return { kind: 'unavailable', reason: 'mail_source_unavailable' };
  }
  if (value.hasMore || statuses.some((status) => status !== 'healthy')) {
    return { kind: 'partial', reason: 'mail_coverage_incomplete' };
  }
  if (value.totalMatches === 0 && value.returned === 0) return { kind: 'empty' };
  if (offset !== 0 || value.returned !== value.totalMatches) {
    return { kind: 'partial', reason: 'mail_coverage_incomplete' };
  }
  return { kind: 'complete' };
}

function classifyMailThread(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  const messageOffset = value?.messageOffset === undefined ? 0 : value.messageOffset;
  if (
    !value ||
    !nonnegativeInteger(value.totalMessages) ||
    !nonnegativeInteger(value.returned) ||
    typeof value.hasMore !== 'boolean' ||
    !nonnegativeInteger(messageOffset) ||
    !Array.isArray(value.messages)
  ) {
    return invalidResult('get_email_thread');
  }
  const messages: Array<{ bodyTruncated: boolean; bodyCompleteness: string }> = [];
  for (const rawMessage of value.messages) {
    const message = record(rawMessage);
    if (
      !message ||
      typeof message.bodyTruncated !== 'boolean' ||
      typeof message.bodyCompleteness !== 'string' ||
      !BODY_COMPLETENESS.has(message.bodyCompleteness)
    ) {
      return invalidResult('get_email_thread');
    }
    messages.push({
      bodyTruncated: message.bodyTruncated,
      bodyCompleteness: message.bodyCompleteness,
    });
  }
  if (value.totalMessages === 0 && value.returned === 0) return { kind: 'empty' };
  if (
    value.hasMore ||
    messageOffset !== 0 ||
    value.returned !== value.totalMessages ||
    messages.some((message) => message.bodyTruncated || message.bodyCompleteness !== 'full')
  ) {
    return { kind: 'partial', reason: 'mail_body_coverage_incomplete' };
  }
  return { kind: 'complete' };
}

function classifyDocumentRead(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  const coverage = record(value?.coverage);
  if (
    value?.tool === 'read_client_documents' &&
    coverage &&
    nonnegativeInteger(coverage.total) &&
    nonnegativeInteger(coverage.returned) &&
    typeof coverage.truncated === 'boolean' &&
    typeof coverage.complete === 'boolean' &&
    typeof coverage.paginationComplete === 'boolean' &&
    Array.isArray(value.documents)
  ) {
    if (
      coverage.total === 0 &&
      coverage.returned === 0 &&
      value.documents.length === 0 &&
      coverage.complete &&
      coverage.paginationComplete
    ) {
      return { kind: 'empty' };
    }
    return coverage.complete && coverage.paginationComplete && !coverage.truncated
      ? { kind: 'complete' }
      : { kind: 'partial', reason: 'document_list_coverage_incomplete' };
  }
  if (
    value?.tool !== 'read_client_documents' ||
    !coverage ||
    typeof coverage.complete !== 'boolean' ||
    typeof coverage.truncated !== 'boolean' ||
    typeof coverage.extractedSectionEmpty !== 'boolean' ||
    typeof coverage.continuationBlocked !== 'boolean' ||
    (coverage.missingContent !== undefined && typeof coverage.missingContent !== 'boolean') ||
    (coverage.matched !== undefined &&
      coverage.matched !== null &&
      typeof coverage.matched !== 'boolean') ||
    (coverage.nextCursor !== null && typeof coverage.nextCursor !== 'string') ||
    !Array.isArray(value.records)
  ) {
    return invalidResult('read_client_documents');
  }
  if (coverage.missingContent === true || coverage.continuationBlocked) {
    return { kind: 'unavailable', reason: 'document_content_unavailable' };
  }
  if (
    value.records.length === 0 &&
    coverage.matched === false &&
    coverage.nextCursor === null &&
    !coverage.truncated
  ) {
    return { kind: 'empty' };
  }
  return coverage.complete && !coverage.truncated
    ? { kind: 'complete' }
    : { kind: 'partial', reason: 'document_coverage_incomplete' };
}

function classifyDebriefRead(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  const scope = record(value?.scope);
  const coverage = record(value?.coverage);
  if (
    value?.tool !== 'query_debriefs' ||
    typeof value.clientId !== 'string' ||
    !scope ||
    !(scope.debriefId === null || typeof scope.debriefId === 'string') ||
    !coverage ||
    !['healthy', 'degraded'].includes(String(coverage.sourceStatus)) ||
    typeof coverage.pageComplete !== 'boolean' ||
    typeof coverage.complete !== 'boolean' ||
    typeof coverage.paginationComplete !== 'boolean' ||
    typeof coverage.bodyCoverageComplete !== 'boolean' ||
    typeof coverage.truncated !== 'boolean' ||
    !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
    !nonnegativeInteger(value.returned) ||
    !Array.isArray(value.debriefs) ||
    value.returned !== value.debriefs.length
  ) {
    return invalidResult('query_debriefs');
  }
  if (coverage.sourceStatus !== 'healthy' || !coverage.pageComplete) {
    return { kind: 'partial', reason: 'debrief_source_coverage_incomplete' };
  }
  if (
    value.returned === 0 &&
    coverage.complete &&
    coverage.paginationComplete &&
    !coverage.truncated
  ) {
    return { kind: 'empty' };
  }
  // An identity read is durable for its exact bounded body window. The owner
  // contract still reports complete=false while additional transcript text
  // remains, so consumers cannot turn a page proof into whole-body coverage.
  if (typeof scope.debriefId === 'string' && value.returned === 1) {
    return { kind: 'complete' };
  }
  return coverage.complete && coverage.paginationComplete && !coverage.truncated
    ? { kind: 'complete' }
    : { kind: 'partial', reason: 'debrief_coverage_incomplete' };
}

function classifyMeetingRead(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  const scope = record(value?.scope);
  const coverage = record(value?.coverage);
  if (
    value?.tool !== 'read_client_meetings' ||
    typeof value.clientId !== 'string' ||
    !scope ||
    !coverage ||
    !['healthy', 'degraded'].includes(String(coverage.sourceStatus)) ||
    typeof coverage.pageComplete !== 'boolean' ||
    typeof coverage.complete !== 'boolean' ||
    typeof coverage.partial !== 'boolean' ||
    typeof coverage.meetingPaginationComplete !== 'boolean' ||
    typeof coverage.sourceInventoryComplete !== 'boolean' ||
    typeof coverage.sourceBodyCoverageComplete !== 'boolean' ||
    typeof coverage.truncated !== 'boolean' ||
    !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
    !nonnegativeInteger(value.returned)
  )
    return invalidResult('read_client_meetings');
  const exactSource = typeof scope.sourceId === 'string';
  if (exactSource) {
    const source = record(value.source);
    const provenance = record(source?.provenance);
    const bodyCoverage = record(source?.bodyCoverage);
    if (
      !source ||
      typeof source.body !== 'string' ||
      !provenance ||
      typeof provenance.sourceId !== 'string' ||
      typeof provenance.sourceVersion !== 'string' ||
      !bodyCoverage ||
      typeof bodyCoverage.complete !== 'boolean' ||
      typeof bodyCoverage.truncated !== 'boolean'
    )
      return invalidResult('read_client_meetings');
    // Like debrief identity reads, each exact canonical body window is durable
    // evidence even when the source needs another window. Coverage remains
    // explicit so a consumer cannot turn one receipt into whole-source coverage.
    return { kind: 'complete' };
  }
  if (!Array.isArray(value.meetings) || value.returned !== value.meetings.length)
    return invalidResult('read_client_meetings');
  if (value.returned === 0 && coverage.complete) return { kind: 'empty' };
  return coverage.sourceStatus === 'healthy' && coverage.pageComplete
    ? { kind: 'complete' }
    : { kind: 'partial', reason: 'meeting_source_inventory_incomplete' };
}

function classifyNativeWorkRead(
  toolName: 'query_tasks' | 'query_action_items',
  collection: 'tasks' | 'actions',
  payload: unknown,
): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  const scope = record(value?.scope);
  const coverage = record(value?.coverage);
  const rows = value?.[collection];
  if (
    value?.tool !== toolName ||
    typeof value.clientId !== 'string' ||
    !scope ||
    !coverage ||
    !['healthy', 'degraded'].includes(String(coverage.sourceStatus)) ||
    typeof coverage.complete !== 'boolean' ||
    typeof coverage.partial !== 'boolean' ||
    typeof coverage.paginationComplete !== 'boolean' ||
    typeof coverage.hasMore !== 'boolean' ||
    !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
    coverage.totalIsExactForScope !== true ||
    !nonnegativeInteger(value.total) ||
    !nonnegativeInteger(value.returned) ||
    !Array.isArray(rows) ||
    value.returned !== rows.length
  )
    return invalidResult(toolName);
  if (coverage.sourceStatus !== 'healthy')
    return { kind: 'partial', reason: `${toolName}_source_changed` };
  if (coverage.hasMore || !coverage.paginationComplete || coverage.partial)
    return { kind: 'partial', reason: `${toolName}_coverage_incomplete` };
  if (value.total === 0 && value.returned === 0 && coverage.complete) return { kind: 'empty' };
  return coverage.complete ? { kind: 'complete' } : invalidResult(toolName);
}

function validClient(value: UnknownRecord | null): boolean {
  const context = record(value?.context);
  const client = record(context?.client);
  return typeof client?.id === 'string' && client.id.length > 0;
}

function classifyClientContext(payload: unknown): ApiToolReadOutcome | null {
  const value = record(payload);
  const sections = record(value?.profileSections);
  const sectionNames = [
    'capabilities',
    'people',
    'facilities',
    'submissionHistory',
    'advocacyMatters',
    'advocacyRecords',
  ] as const;
  const statuses: string[] = [];
  let currentValid = value?.tool === 'get_client_context' && validClient(value) && !!sections;
  if (currentValid) {
    for (const name of sectionNames) {
      const section = record(sections?.[name]);
      const status = section?.status;
      if (typeof status !== 'string' || !CLIENT_SECTION_STATUSES.has(status)) {
        currentValid = false;
        break;
      }
      statuses.push(status);
    }
  }
  if (currentValid) {
    return statuses.some((status) => status === 'partial' || status === 'unavailable')
      ? { kind: 'partial', reason: 'client_context_coverage_incomplete' }
      : { kind: 'complete' };
  }
  if (validClient(value) && value && !Object.prototype.hasOwnProperty.call(value, 'tool')) {
    return null;
  }
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Object.prototype.hasOwnProperty.call(payload, 'tool')
  ) {
    return {
      kind: 'failed',
      reason: 'Canonical client-context response is missing its client context',
    };
  }
  return invalidResult('get_client_context');
}

function classifyMemorySearch(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  const coverage = record(value?.coverage);
  if (
    value?.tool !== 'search_memory' ||
    !coverage ||
    typeof coverage.complete !== 'boolean' ||
    typeof coverage.paginationComplete !== 'boolean' ||
    !Array.isArray(coverage.sources) ||
    coverage.sources.length === 0 ||
    !nonnegativeInteger(value.factContentUnavailableCount) ||
    typeof value.contentStatus !== 'string' ||
    !MEMORY_CONTENT_STATUSES.has(value.contentStatus) ||
    typeof value.contentTruncated !== 'boolean' ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string') ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.records)
  ) {
    return invalidResult('search_memory');
  }
  const sources: Array<{
    sourceStatus: RetrievalSourceStatus;
    hasMore: boolean;
    truncated: boolean;
    paginationComplete: boolean;
    coverageComplete: boolean;
  }> = [];
  for (const rawSource of coverage.sources) {
    const source = record(rawSource);
    if (
      source?.domain !== 'institutional_knowledge' ||
      typeof source.sourceStatus !== 'string' ||
      !RETRIEVAL_SOURCE_STATUSES.has(source.sourceStatus as RetrievalSourceStatus) ||
      typeof source.hasMore !== 'boolean' ||
      typeof source.truncated !== 'boolean' ||
      typeof source.paginationComplete !== 'boolean' ||
      typeof source.coverageComplete !== 'boolean'
    ) {
      return invalidResult('search_memory');
    }
    sources.push({
      sourceStatus: source.sourceStatus as RetrievalSourceStatus,
      hasMore: source.hasMore,
      truncated: source.truncated,
      paginationComplete: source.paginationComplete,
      coverageComplete: source.coverageComplete,
    });
  }
  if (
    value.contentStatus === 'unavailable' ||
    value.contentStatus === 'unavailable_or_ineligible'
  ) {
    return { kind: 'unavailable', reason: 'memory_content_unavailable' };
  }
  const sourceCoverageIncomplete = sources.some(
    (source) =>
      source.sourceStatus !== 'healthy' ||
      source.hasMore ||
      source.truncated ||
      !source.paginationComplete ||
      !source.coverageComplete,
  );
  if (
    !coverage.complete ||
    !coverage.paginationComplete ||
    sourceCoverageIncomplete ||
    value.contentStatus === 'metadata_only' ||
    value.factContentUnavailableCount > 0 ||
    value.contentTruncated ||
    value.nextCursor !== null
  ) {
    return { kind: 'partial', reason: 'memory_coverage_incomplete' };
  }
  if (value.contentStatus === 'empty') return { kind: 'empty' };
  return { kind: 'complete' };
}

/**
 * Normalize only API read contracts whose owner-produced output shapes are
 * validated here. Unqualified tools return null and retain their existing path;
 * arbitrary source bodies are never scanned for generic success/error keys.
 */
export function classifyApiToolReadOutcome(
  toolName: string,
  payload: unknown,
): ApiToolReadOutcome | null {
  switch (toolName) {
    case 'list_emails':
    case 'search_emails':
      return classifyMailSearch(toolName, payload);
    case 'get_email_thread':
      return classifyMailThread(payload);
    case 'read_client_documents':
      return classifyDocumentRead(payload);
    case 'query_debriefs':
      return classifyDebriefRead(payload);
    case 'read_client_meetings':
      return classifyMeetingRead(payload);
    case 'query_tasks':
      return classifyNativeWorkRead('query_tasks', 'tasks', payload);
    case 'query_action_items':
      return classifyNativeWorkRead('query_action_items', 'actions', payload);
    case 'get_client_context':
      return classifyClientContext(payload);
    case 'search_memory':
      return classifyMemorySearch(payload);
    default:
      return null;
  }
}
