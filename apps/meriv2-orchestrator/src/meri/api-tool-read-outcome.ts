import { z } from 'zod';

export type ApiToolReadOutcomeKind = 'complete' | 'empty' | 'partial' | 'unavailable' | 'failed';

export interface ApiToolReadOutcome {
  kind: ApiToolReadOutcomeKind;
  reason?: string;
}

const ownerErrorSchema = z.object({ error: z.string().trim().min(1) }).passthrough();
const sourceStatusSchema = z.enum(['healthy', 'degraded', 'unavailable']);

const mailSearchSchema = z
  .object({
    totalMatches: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    messages: z.array(z.unknown()),
    searchedMailboxes: z.array(
      z
        .object({
          mailCoverage: z.object({ sourceStatus: sourceStatusSchema }).passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const mailThreadSchema = z
  .object({
    totalMessages: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    messages: z.array(
      z
        .object({
          bodyTruncated: z.boolean(),
          bodyCompleteness: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const documentListSchema = z
  .object({
    tool: z.literal('read_client_documents'),
    coverage: z
      .object({
        total: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative(),
        truncated: z.boolean(),
        complete: z.boolean(),
        paginationComplete: z.boolean(),
      })
      .passthrough(),
    documents: z.array(z.unknown()),
  })
  .passthrough();

const documentReadSchema = z
  .object({
    tool: z.literal('read_client_documents'),
    coverage: z
      .object({
        complete: z.boolean(),
        truncated: z.boolean(),
        extractedSectionEmpty: z.boolean(),
        continuationBlocked: z.boolean(),
        missingContent: z.boolean().optional(),
        matched: z.boolean().nullable().optional(),
        nextCursor: z.string().nullable(),
      })
      .passthrough(),
    records: z.array(z.unknown()),
  })
  .passthrough();

const clientContextSchema = z
  .object({
    tool: z.literal('get_client_context'),
    context: z.object({ client: z.object({ id: z.string().min(1) }).passthrough() }).passthrough(),
    profileSections: z.record(
      z
        .object({
          status: z.enum(['complete', 'partial', 'unavailable', 'not_requested']),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const memorySearchSchema = z
  .object({
    tool: z.literal('search_memory'),
    contentStatus: z.enum([
      'available',
      'empty',
      'metadata_only',
      'unavailable',
      'unavailable_or_ineligible',
    ]),
    contentTruncated: z.boolean(),
    nextCursor: z.string().nullable(),
    results: z.array(z.unknown()),
    records: z.array(z.unknown()),
  })
  .passthrough();

function ownerFailure(payload: unknown): ApiToolReadOutcome | null {
  const parsed = ownerErrorSchema.safeParse(payload);
  return parsed.success ? { kind: 'failed', reason: parsed.data.error } : null;
}

function invalidResult(toolName: string): ApiToolReadOutcome {
  return { kind: 'failed', reason: `${toolName}_result_contract_invalid` };
}

function classifyMailSearch(toolName: string, payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const parsed = mailSearchSchema.safeParse(payload);
  if (!parsed.success) return invalidResult(toolName);
  const { totalMatches, returned, hasMore, searchedMailboxes } = parsed.data;
  const statuses = searchedMailboxes.map((mailbox) => mailbox.mailCoverage.sourceStatus);
  const noAvailableMailbox =
    statuses.length === 0 || statuses.every((status) => status === 'unavailable');
  if (noAvailableMailbox && returned === 0) {
    return { kind: 'unavailable', reason: 'mail_source_unavailable' };
  }
  if (hasMore || statuses.some((status) => status !== 'healthy')) {
    return { kind: 'partial', reason: 'mail_coverage_incomplete' };
  }
  if (totalMatches === 0 && returned === 0) return { kind: 'empty' };
  return { kind: 'complete' };
}

function classifyMailThread(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const parsed = mailThreadSchema.safeParse(payload);
  if (!parsed.success) return invalidResult('get_email_thread');
  const { totalMessages, returned, hasMore, messages } = parsed.data;
  if (totalMessages === 0 && returned === 0) return { kind: 'empty' };
  if (
    hasMore ||
    messages.some((message) => message.bodyTruncated || message.bodyCompleteness !== 'complete')
  ) {
    return { kind: 'partial', reason: 'mail_body_coverage_incomplete' };
  }
  return { kind: 'complete' };
}

function classifyDocumentRead(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const listed = documentListSchema.safeParse(payload);
  if (listed.success) {
    const { coverage, documents } = listed.data;
    if (
      coverage.total === 0 &&
      coverage.returned === 0 &&
      documents.length === 0 &&
      coverage.complete &&
      coverage.paginationComplete
    ) {
      return { kind: 'empty' };
    }
    return coverage.complete && coverage.paginationComplete && !coverage.truncated
      ? { kind: 'complete' }
      : { kind: 'partial', reason: 'document_list_coverage_incomplete' };
  }
  const read = documentReadSchema.safeParse(payload);
  if (!read.success) return invalidResult('read_client_documents');
  const { coverage, records } = read.data;
  if (coverage.missingContent === true || coverage.continuationBlocked) {
    return { kind: 'unavailable', reason: 'document_content_unavailable' };
  }
  if (
    records.length === 0 &&
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

function classifyClientContext(payload: unknown): ApiToolReadOutcome | null {
  const parsed = clientContextSchema.safeParse(payload);
  // The native ApiClientContextRepo retains its established validation for
  // legacy envelopes without the owner's current tool discriminator.
  if (!parsed.success) return null;
  const statuses = Object.values(parsed.data.profileSections).map((section) => section.status);
  return statuses.some((status) => status === 'partial' || status === 'unavailable')
    ? { kind: 'partial', reason: 'client_context_coverage_incomplete' }
    : { kind: 'complete' };
}

function classifyMemorySearch(payload: unknown): ApiToolReadOutcome {
  const failure = ownerFailure(payload);
  if (failure) return failure;
  const parsed = memorySearchSchema.safeParse(payload);
  if (!parsed.success) return invalidResult('search_memory');
  const { contentStatus, contentTruncated, nextCursor } = parsed.data;
  if (contentStatus === 'empty') return { kind: 'empty' };
  if (contentStatus === 'unavailable' || contentStatus === 'unavailable_or_ineligible') {
    return { kind: 'unavailable', reason: 'memory_content_unavailable' };
  }
  if (contentStatus === 'metadata_only' || contentTruncated || nextCursor !== null) {
    return { kind: 'partial', reason: 'memory_coverage_incomplete' };
  }
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
    case 'get_client_context':
      return classifyClientContext(payload);
    case 'search_memory':
      return classifyMemorySearch(payload);
    default:
      return null;
  }
}
