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
    case 'search_public_web': {
      const failure = ownerFailure(payload);
      return failure ?? { kind: 'partial', reason: 'public_web_search_is_discovery_only' };
    }
    case 'get_bill_status':
      return classifyBillStatus(payload);
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
