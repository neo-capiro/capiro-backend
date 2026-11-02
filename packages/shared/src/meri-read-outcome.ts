import { US_STATE_BY_ABBR } from './us-states.js';

export type ApiToolReadOutcomeKind = 'complete' | 'empty' | 'partial' | 'unavailable' | 'failed';

export interface ApiToolReadOutcome {
  kind: ApiToolReadOutcomeKind;
  reason?: string;
}

/** Governance observations only: proposal text is never an approved memory fact. */
export interface MeriPendingMemoryProposalRead {
  tool: 'list_memory_proposals';
  enabled: boolean;
  authority: 'own_pending_proposals';
  claimsAreApprovedFacts: false;
  scope: { tenantId: string; userId: string; clientId: string | null };
  candidates: Array<{
    id: string;
    status: 'pending';
    approvedFact: false;
    scope: string;
    clientId: string | null;
    sourceKind: string;
    createdAt: string;
    restricted: boolean;
    title: string | null;
    proposedText: string | null;
    contentTruncated: boolean;
  }>;
  nextCursor: string | null;
  coverage: { firstPage: boolean; complete: boolean; reason: string };
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

function classifyPendingMemoryProposals(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload),
    coverage = record(value?.coverage),
    scope = record(value?.scope);
  if (
    !value ||
    value.tool !== 'list_memory_proposals' ||
    value.authority !== 'own_pending_proposals' ||
    value.claimsAreApprovedFacts !== false ||
    typeof value.enabled !== 'boolean' ||
    !scope ||
    typeof scope.tenantId !== 'string' ||
    typeof scope.userId !== 'string' ||
    !(scope.clientId === null || typeof scope.clientId === 'string') ||
    !Array.isArray(value.candidates) ||
    !(value.nextCursor === null || typeof value.nextCursor === 'string') ||
    !coverage ||
    typeof coverage.firstPage !== 'boolean' ||
    typeof coverage.complete !== 'boolean' ||
    !value.candidates.every((raw) => {
      const row = record(raw);
      return (
        row &&
        typeof row.id === 'string' &&
        row.status === 'pending' &&
        row.approvedFact === false &&
        ['firm', 'client', 'personal'].includes(String(row.scope)) &&
        typeof row.sourceKind === 'string' &&
        typeof row.createdAt === 'string' &&
        (row.clientId === null || typeof row.clientId === 'string') &&
        (!scope.clientId || !row.clientId || row.clientId === scope.clientId) &&
        (row.title === null || typeof row.title === 'string') &&
        typeof row.restricted === 'boolean' &&
        typeof row.contentTruncated === 'boolean' &&
        (row.proposedText === null || typeof row.proposedText === 'string') &&
        (!row.restricted || (row.proposedText === null && row.title === null))
      );
    })
  )
    return invalidResult('list_memory_proposals');
  if (!value.enabled)
    return value.candidates.length === 0 && !coverage.complete && value.nextCursor === null
      ? { kind: 'unavailable', reason: 'memory_proposal_review_disabled' }
      : invalidResult('list_memory_proposals');
  const incomplete =
    value.truncated === true ||
    value.partial === true ||
    !coverage.firstPage ||
    value.nextCursor !== null ||
    value.candidates.some((raw) => {
      const row = record(raw)!;
      return row.restricted || row.contentTruncated || row.proposedText === null;
    });
  if (coverage.complete === incomplete) return invalidResult('list_memory_proposals');
  return incomplete
    ? { kind: 'partial', reason: 'memory_proposal_coverage_incomplete' }
    : { kind: value.candidates.length ? 'complete' : 'empty' };
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
    !(
      typeof value.clientId === 'string' ||
      (toolName === 'query_tasks' &&
        value.clientId === null &&
        scope?.kind === 'authorized_tasks' &&
        typeof scope.tenantId === 'string' &&
        scope.tenantId.length > 0 &&
        typeof scope.actorUserId === 'string' &&
        scope.actorUserId.length > 0)
    ) ||
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

function classifyCanonicalFiniteRead(toolName: string, payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return { kind: 'failed', reason: toolName + '_read_failed' };
  const value = record(payload);
  const coverage = record(value?.coverage);
  if (!value || value.tool !== toolName) return invalidResult(toolName);

  // Canonical owner validation (must be present and match expected)
  if (typeof value.authoritativeOwner !== 'string' || !value.authoritativeOwner.trim()) {
    return invalidResult(toolName);
  }
  const authoritativeOwner = value.authoritativeOwner;

  // Expected owner per tool
  const expectedOwner =
    toolName === 'read_monday_client_boards'
      ? 'managed_monday_mcp'
      : toolName === 'read_bill_text'
        ? 'federal_evidence_current'
        : toolName === 'scrape_web_page'
          ? 'public_url'
          : toolName === 'read_chat_attachments' || toolName === 'get_research_evidence'
            ? 'clio_chat_attachment'
            : null;
  if (authoritativeOwner !== expectedOwner) return invalidResult(toolName);

  // Canonical currentStatus validation (must be present)
  if (typeof value.currentStatus !== 'string' || !value.currentStatus.trim()) {
    return invalidResult(toolName);
  }
  const currentStatus = value.currentStatus;

  // Early shared guard: root unavailable or unsupported returns unavailable
  if (currentStatus === 'unavailable' || currentStatus === 'unsupported') {
    return { kind: 'unavailable', reason: toolName + '_unavailable' };
  }
  // Root error or unauthorized returns failed
  if (currentStatus === 'error' || currentStatus === 'unauthorized') {
    return { kind: 'failed', reason: toolName + '_read_failed' };
  }
  // Required currentStatus: healthy for Monday, available for remaining tools
  if (toolName === 'read_monday_client_boards') {
    if (currentStatus !== 'healthy') return invalidResult(toolName);
  } else {
    if (currentStatus !== 'available') return invalidResult(toolName);
  }
  // Coverage required for all success branches
  if (!coverage) return invalidResult(toolName);

  if (toolName === 'read_monday_client_boards') {
    // Monday: success path after early guards covers healthy status.
    // Note: unavailable/unsupported/error/unauthorized already handled above.
    // Monday sourceStatus should match currentStatus for consistency
    // For available/healthy/other valid statuses, proceed with coverage validation
    //Monday sourceStatus should match currentStatus for consistency
    const sources = Array.isArray(coverage.sources) ? coverage.sources.map(record) : [];
    const monday = sources.find((source) => source?.domain === 'monday');
    const nonnegativeInteger = (v: unknown): v is number =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0;
    if (
      !monday ||
      typeof coverage.complete !== 'boolean' ||
      !nonnegativeInteger(coverage.returned) ||
      typeof monday.sourceStatus !== 'string' ||
      !RETRIEVAL_SOURCE_STATUSES.has(monday.sourceStatus as RetrievalSourceStatus) ||
      typeof monday.coverageComplete !== 'boolean' ||
      typeof monday.paginationComplete !== 'boolean' ||
      typeof monday.hasMore !== 'boolean' ||
      typeof monday.truncated !== 'boolean' ||
      (monday.nextCursor !== undefined &&
        monday.nextCursor !== null &&
        typeof monday.nextCursor !== 'string') ||
      !Array.isArray(value.records) ||
      value.records.length !== coverage.returned
    )
      return invalidResult(toolName);
    //Monday sourceStatus must be 'healthy' for valid success (complete/empty)
    // available/unavailable/error/unauthorized/unsupported statuses are handled above
    // unsupported is already rejected; unavailable/error/unauthorized would have returned earlier
    if (monday.sourceStatus !== 'healthy') {
      return { kind: 'partial', reason: 'monday_coverage_incomplete' };
    }
    // Ensure nextCursor is null default for healthy sources (matching actual owner contract)
    const nextCursor = monday.nextCursor ?? null;
    // For full-source complete, Monday root coverage.complete must be true AND all Monday source flags
    // must be correct. The source must be healthy with complete coverage and no pending pagination.
    // nextCursor must be null (no more pages), hasMore must be false, truncated must be false.
    // coverageComplete and paginationComplete must both be true to confirm entire source is complete.
    if (
      !coverage.complete ||
      !monday.coverageComplete ||
      !monday.paginationComplete ||
      nextCursor !== null ||
      monday.hasMore ||
      monday.truncated
    )
      return { kind: 'partial', reason: 'monday_coverage_incomplete' };
    return value.records.length ? { kind: 'complete' } : { kind: 'empty' };
  }

  if (toolName === 'read_bill_text') {
    // bill_text: currentStatus unavailable/unsupported => unavailable; available requires boolean found, found=false unavailable
    // unknown/missing invalid
    if (currentStatus === 'available') {
      // For available status, check found boolean first
      if (typeof value.found !== 'boolean') return invalidResult(toolName);
      if (!value.found) return { kind: 'unavailable', reason: 'bill_text_unavailable' };
    } else {
      return invalidResult(toolName);
    }
    // Now validate remaining fields
    if (
      typeof value.found !== 'boolean' ||
      typeof coverage.complete !== 'boolean' ||
      typeof coverage.truncated !== 'boolean' ||
      !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
      typeof coverage.pageComplete !== 'boolean' ||
      typeof coverage.contentComplete !== 'boolean' ||
      typeof coverage.paginationComplete !== 'boolean'
    )
      return invalidResult(toolName);
    if (
      typeof value.billId !== 'string' ||
      typeof value.versionCode !== 'string' ||
      typeof value.versionHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.versionHash) ||
      typeof value.textHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.textHash) ||
      typeof value.text !== 'string'
    )
      return invalidResult(toolName);
    // For full-source complete read, all coverage flags must be true and nextCursor must be null.
    // truncated=false confirms we have the full bill without truncation.
    // pageComplete, contentComplete, paginationComplete together ensure the entire source is complete,
    // not just a bounded page within it.
    if (
      coverage.complete &&
      coverage.pageComplete &&
      coverage.contentComplete &&
      coverage.paginationComplete &&
      !coverage.truncated &&
      coverage.nextCursor === null
    )
      return value.text.length ? { kind: 'complete' } : { kind: 'empty' };
    return { kind: 'partial', reason: 'bill_text_coverage_incomplete' };
  }

  if (toolName === 'scrape_web_page') {
    if (!currentStatus) return invalidResult(toolName);
    if (currentStatus !== 'available') return invalidResult(toolName);
    if (
      typeof value.url !== 'string' ||
      typeof value.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.contentHash) ||
      typeof value.text !== 'string' ||
      value.trust !== 'external_untrusted' ||
      typeof coverage.complete !== 'boolean' ||
      typeof coverage.truncated !== 'boolean' ||
      (value.finalUrl !== undefined && typeof value.finalUrl !== 'string') ||
      (coverage.locator !== undefined &&
        (typeof coverage.locator !== 'object' || coverage.locator === null))
    )
      return invalidResult(toolName);
    // Validate finalUrl matches the original locator url (no redirect to different source)
    if (value.finalUrl !== undefined && value.finalUrl !== value.url) {
      return { kind: 'partial', reason: 'web_page_redirect_differs_from_locator' };
    }
    // locator.url must match the requested url to ensure we're reading the expected source
    const locator = coverage.locator as Record<string, unknown> | undefined;
    if (locator?.url !== undefined && locator.url !== value.url) {
      return { kind: 'partial', reason: 'web_page_locator_url_mismatch' };
    }
    return coverage.complete && !coverage.truncated
      ? value.text.length
        ? { kind: 'complete' }
        : { kind: 'empty' }
      : { kind: 'partial', reason: 'public_web_content_incomplete' };
  }

  if (toolName === 'read_chat_attachments') {
    if (!currentStatus) return invalidResult(toolName);
    if (currentStatus !== 'available') return invalidResult(toolName);
    if (coverage.mode === 'manifest')
      return { kind: 'partial', reason: 'attachment_manifest_is_discovery_only' };
    if (
      coverage.mode !== 'section' ||
      typeof coverage.sectionComplete !== 'boolean' ||
      typeof coverage.contentComplete !== 'boolean' ||
      typeof coverage.extractionStatus !== 'string' ||
      typeof coverage.truncated !== 'boolean' ||
      !Array.isArray(value.records)
    )
      return invalidResult(toolName);
    if (coverage.extractionStatus === 'unreadable')
      return { kind: 'unavailable', reason: 'attachment_section_unreadable' };
    // sectionComplete=true means the section boundary is complete, but contentComplete=true
    // is required to qualify as a full-source complete read (not just a bounded section).
    // Also need extractionStatus='complete' and truncated=false for healthy complete.
    if (
      coverage.sectionComplete &&
      coverage.contentComplete &&
      coverage.extractionStatus === 'complete' &&
      !coverage.truncated
    )
      return value.records.length ? { kind: 'complete' } : { kind: 'empty' };
    return { kind: 'partial', reason: 'attachment_section_coverage_incomplete' };
  }

  if (toolName === 'get_research_evidence') {
    if (!currentStatus) return invalidResult(toolName);
    if (currentStatus !== 'available') return invalidResult(toolName);
    if (
      !['complete', 'partial', 'unavailable'].includes(String(coverage.status)) ||
      typeof coverage.complete !== 'boolean' ||
      typeof coverage.paginationComplete !== 'boolean' ||
      typeof coverage.truncated !== 'boolean' ||
      !(coverage.nextCursor === null || typeof coverage.nextCursor === 'string') ||
      !Array.isArray(value.records)
    )
      return invalidResult(toolName);
    if (coverage.status === 'unavailable')
      return {
        kind: 'unavailable',
        reason: 'research_evidence_unavailable',
      };
    // research_evidence requires status='complete' and all coverage flags true for full-source complete
    if (
      coverage.status !== 'complete' ||
      !coverage.complete ||
      !coverage.paginationComplete ||
      coverage.truncated ||
      coverage.nextCursor !== null
    )
      return { kind: 'partial', reason: 'research_evidence_coverage_incomplete' };
    return value.records.length ? { kind: 'complete' } : { kind: 'empty' };
  }

  return invalidResult(toolName);
}

/**
 * Capiro's program-element reads (global budget data, no tenant content). A
 * missing program element is an owner error, never an empty result.
 */
function classifyProgramElementRead(toolName: string, payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const value = record(payload);
  if (!value || value.tool !== toolName || typeof value.generatedAt !== 'string')
    return invalidResult(toolName);
  if (toolName === 'get_program_element') {
    const programElement = record(value.programElement);
    return programElement && Array.isArray(programElement.years)
      ? { kind: 'complete' }
      : invalidResult(toolName);
  }
  if (toolName === 'get_pe_budget_timeline') {
    if (!Array.isArray(value.years)) return invalidResult(toolName);
    return value.years.length ? { kind: 'complete' } : { kind: 'empty' };
  }
  if (typeof value.peCode !== 'string' || !Array.isArray(value.provisions))
    return invalidResult(toolName);
  return value.provisions.length ? { kind: 'complete' } : { kind: 'empty' };
}

function classifyBillStatus(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return { kind: 'failed', reason: 'get_bill_status_read_failed' };
  const value = record(payload);
  if (!value || value.tool !== 'get_bill_status') return invalidResult('get_bill_status');
  if (value.authoritativeOwner !== 'congress_bill_status') return invalidResult('get_bill_status');
  const currentStatus = value.currentStatus;
  // unavailable/unsupported for bill_status returns unavailable immediately
  if (currentStatus === 'unavailable' || currentStatus === 'unsupported') {
    return { kind: 'unavailable', reason: 'bill_status_unavailable' };
  }
  if (!currentStatus) return invalidResult('get_bill_status');
  if (currentStatus !== 'available') return invalidResult('get_bill_status');
  if (typeof value.found !== 'boolean') return invalidResult('get_bill_status');
  if (!value.found) {
    // Missing bill text/status with found=false is unavailable, not empty.
    // Empty would require explicit healthy/exhaustive content-scoped evidence.
    return { kind: 'unavailable', reason: 'bill_status_unavailable' };
  }
  return typeof value.billId === 'string' && typeof value.status === 'string'
    ? { kind: 'complete' }
    : invalidResult('get_bill_status');
}

function classifyRetainedBillRead(toolName: string, payload: unknown): ApiToolReadOutcome {
  const value = record(payload);
  if (!value || value.tool !== toolName || value.authoritativeOwner !== 'bill_text_extraction')
    return invalidResult(toolName);
  if (toolName !== 'read_bill_text') {
    if (value.currentStatus !== 'available') return invalidResult(toolName);
    if (value.operation === 'search') {
      if (
        !['exact', 'keyword', 'semantic'].includes(String(value.mode)) ||
        !Array.isArray(value.results) ||
        !(value.totalRevisions === null || typeof value.totalRevisions === 'number') ||
        !Number.isSafeInteger(value.page) ||
        typeof value.page !== 'number' ||
        value.page < 1 ||
        !Number.isSafeInteger(value.limit) ||
        typeof value.limit !== 'number' ||
        value.limit < 1 ||
        value.limit > 2 ||
        value.results.length > value.limit ||
        !(value.hasMore === null || typeof value.hasMore === 'boolean') ||
        value.nextPage !==
          (value.hasMore &&
          value.page < 10000 &&
          (value.mode !== 'semantic' || value.page * value.limit < 1000)
            ? value.page + 1
            : null)
      )
        return invalidResult(toolName);
      return { kind: 'partial', reason: 'bill_text_search_does_not_prove_source_coverage' };
    }
    if (
      value.operation !== 'coverage' ||
      value.fiscalYear !== 2026 ||
      typeof value.complete !== 'boolean' ||
      !Array.isArray(value.jurisdictions) ||
      value.jurisdictions.length !== 52
    )
      return invalidResult(toolName);
    const jurisdictions = value.jurisdictions.map((item) => record(item)?.jurisdiction);
    if (
      new Set(jurisdictions).size !== 52 ||
      !jurisdictions.includes('US') ||
      jurisdictions.some(
        (code) =>
          typeof code !== 'string' ||
          (code !== 'US' &&
            (!Object.hasOwn(US_STATE_BY_ABBR, code) ||
              ['PR', 'GU', 'VI', 'AS', 'MP'].includes(code))),
      )
    )
      return invalidResult(toolName);
    if (
      value.complete !==
      value.jurisdictions.every((item) => record(item)?.status === 'complete_for_frozen_inventory')
    )
      return invalidResult(toolName);
    const detail = record(value.detailPage);
    if (detail) {
      const keys = [
        'unit',
        'page',
        'limit',
        'totalRows',
        'returnedRows',
        'hasMore',
        'nextPage',
        'jurisdictions',
        'complete',
      ];
      const number = (v: unknown): v is number =>
        typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
      if (
        Object.keys(detail).some((key) => !keys.includes(key)) ||
        detail.unit !== 'jurisdiction_or_version_kind' ||
        !number(detail.page) ||
        detail.page < 1 ||
        detail.page > 10000 ||
        !number(detail.limit) ||
        detail.limit < 1 ||
        detail.limit > 2 ||
        !number(detail.totalRows) ||
        !number(detail.returnedRows) ||
        !Array.isArray(value.details) ||
        value.details.length !== detail.returnedRows ||
        !(
          detail.jurisdictions === null ||
          (Array.isArray(detail.jurisdictions) &&
            detail.jurisdictions.length > 0 &&
            new Set(detail.jurisdictions).size === detail.jurisdictions.length &&
            detail.jurisdictions.every((code) => jurisdictions.includes(code)))
        )
      )
        return invalidResult(toolName);
      const offset = (detail.page - 1) * detail.limit;
      const hasMore = offset + detail.limit < detail.totalRows;
      if (
        detail.returnedRows !== Math.min(detail.limit, Math.max(0, detail.totalRows - offset)) ||
        detail.hasMore !== hasMore ||
        detail.nextPage !== (hasMore ? detail.page + 1 : null) ||
        detail.complete !== (offset === 0 && detail.totalRows <= detail.limit)
      )
        return invalidResult(toolName);
      if (!detail.complete || detail.jurisdictions !== null)
        return { kind: 'partial', reason: 'bill_text_coverage_details_paged_or_filtered' };
    } else return invalidResult(toolName);
    return value.complete
      ? { kind: 'complete' }
      : { kind: 'partial', reason: 'bill_text_inventory_or_stages_incomplete' };
  }
  if (value.operation !== 'read') return invalidResult(toolName);
  if (value.available === false && value.currentStatus === 'unavailable')
    return { kind: 'unavailable', reason: 'bill_text_unavailable' };
  if (value.projection !== undefined) {
    const projection = record(value.projection);
    const counts = ['omittedSections', 'omittedContext', 'omittedDefinitions', 'omittedReferences'];
    if (
      !projection ||
      Object.keys(projection).some((key) => ![...counts, 'reason', 'followUp'].includes(key)) ||
      projection.reason !== 'prompt_budget' ||
      typeof projection.followUp !== 'string' ||
      counts.some(
        (key) =>
          typeof projection[key] !== 'number' ||
          !Number.isSafeInteger(projection[key]) ||
          projection[key] < 0,
      ) ||
      ((Number(projection.omittedSections) > 0 || Number(projection.omittedContext) > 0) &&
        value.contextTruncated !== true) ||
      (Number(projection.omittedDefinitions) > 0 && value.definitionsTruncated !== true) ||
      (Number(projection.omittedReferences) > 0 && value.referencesTruncated !== true)
    )
      return invalidResult(toolName);
  }
  const identity = record(value.identity),
    coverage = record(value.coverage);
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const integer = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (
    value.available !== true ||
    value.currentStatus !== 'available' ||
    !identity ||
    !coverage ||
    ['billId', 'jurisdiction', 'session', 'revisionId', 'extractionId'].some(
      (key) => typeof identity[key] !== 'string' || !identity[key],
    ) ||
    ['revisionHash', 'documentHash', 'textHash', 'structureHash'].some(
      (key) => !hash(identity[key]),
    ) ||
    typeof value.text !== 'string' ||
    !integer(value.startOffset) ||
    !integer(value.endOffset) ||
    !integer(value.totalCharacters) ||
    value.endOffset > value.totalCharacters ||
    value.endOffset - value.startOffset !== value.text.length ||
    value.offsetUnit !== 'UTF-16' ||
    !Array.isArray(value.context) ||
    ['contextTruncated', 'definitionsTruncated', 'referencesTruncated'].some(
      (key) => typeof value[key] !== 'boolean',
    ) ||
    !(value.nextCursor === null || typeof value.nextCursor === 'string') ||
    ['complete', 'pageComplete', 'contentComplete', 'paginationComplete', 'truncated'].some(
      (key) => typeof coverage[key] !== 'boolean',
    ) ||
    coverage.nextCursor !== value.nextCursor
  )
    return invalidResult(toolName);
  const complete =
    value.completeness === 'complete' &&
    value.startOffset === 0 &&
    value.endOffset === value.totalCharacters &&
    !value.contextTruncated &&
    !value.definitionsTruncated &&
    !value.referencesTruncated &&
    value.nextCursor === null;
  if (
    coverage.complete !== complete ||
    coverage.contentComplete !== (value.completeness === 'complete') ||
    coverage.pageComplete !== true ||
    coverage.paginationComplete !== (value.nextCursor === null) ||
    coverage.truncated !==
      (!complete &&
        (value.startOffset !== 0 ||
          value.endOffset !== value.totalCharacters ||
          value.contextTruncated ||
          value.definitionsTruncated ||
          value.referencesTruncated))
  )
    return invalidResult(toolName);
  return complete
    ? { kind: 'complete' }
    : { kind: 'partial', reason: 'bill_text_coverage_incomplete' };
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
  if (
    ['search_congress_bills', 'search_state_bills', 'read_bill_text'].includes(toolName) &&
    record(payload)?.authoritativeOwner === 'bill_text_extraction'
  )
    return classifyRetainedBillRead(toolName, payload);
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
    case 'list_memory_proposals':
      return classifyPendingMemoryProposals(payload);
    case 'search_public_web': {
      const failure = ownerFailure(payload);
      return failure ?? { kind: 'partial', reason: 'public_web_search_is_discovery_only' };
    }
    case 'get_bill_status':
      return classifyBillStatus(payload);
    case 'get_program_element':
    case 'get_pe_budget_timeline':
    case 'get_pe_report_language':
      return classifyProgramElementRead(toolName, payload);
    case 'read_monday_client_boards':
    case 'read_bill_text':
    case 'scrape_web_page':
    case 'read_chat_attachments':
    case 'get_research_evidence':
      return classifyCanonicalFiniteRead(toolName, payload);
    default:
      return null;
  }
}
