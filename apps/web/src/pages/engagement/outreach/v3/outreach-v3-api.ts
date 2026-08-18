import type { AxiosInstance } from 'axios';
import type {
  CapabilityResult,
  OutreachV3Command,
  OutreachV3CommandBatchResult,
  OutreachV3ContextCandidate,
  OutreachV3ContextClass,
  OutreachV3ContextDocumentCandidate,
  OutreachV3ContextReviewResponse,
  OutreachV3ContextScope,
  OutreachV3Conversation,
  OutreachV3GovernmentSearchData,
  OutreachV3Length,
  OutreachV3MemorySearchData,
  OutreachV3Proposal,
  OutreachV3ReasoningTurnResult,
  OutreachV3SessionEnvelope,
  OutreachV3StrategyData,
  OutreachV3TargetCandidate,
  OutreachV3TargetCoverageResponse,
  OutreachV3TargetLocator,
  OutreachV3TargetSearchData,
} from './contracts.js';
import type {
  OutreachV3RelationshipResponse,
  OutreachV3TargetProfileResponse,
} from './target-intelligence-contracts.js';

const ROOT = '/api/engagement/outreach-v3';

interface OutreachV3StrategyWireData {
  recommendedPattern:
    | 'personalized_separate'
    | 'uniform_separate'
    | 'shared_thread';
  recommendedPersonalization: 'high' | 'light' | 'none';
  recommendedTone: 'professional' | 'collaborative' | 'direct';
  recommendedLength: 'short' | 'medium';
  rationale: string[];
  unresolvedDecisions: string[];
  safetyNotes: string[];
}

interface OutreachV3ProposalWire extends Omit<OutreachV3Proposal, 'commands'> {
  commands?: unknown;
  commandsJsonb?: unknown;
}

export function outreachV3SessionPath(sessionId: string): string {
  return `${ROOT}/sessions/${encodeURIComponent(sessionId)}`;
}

export async function createOutreachV3Session(
  api: AxiosInstance,
  title?: string,
): Promise<OutreachV3SessionEnvelope> {
  const response = await api.post<OutreachV3SessionEnvelope>(`${ROOT}/sessions`, {
    ...(title?.trim() ? { title: title.trim() } : {}),
  });
  return response.data;
}

export async function getOutreachV3Session(
  api: AxiosInstance,
  sessionId: string,
): Promise<OutreachV3SessionEnvelope> {
  return (await api.get<OutreachV3SessionEnvelope>(outreachV3SessionPath(sessionId))).data;
}

export async function archiveOutreachV3Session(
  api: AxiosInstance,
  sessionId: string,
): Promise<void> {
  await api.post(`${outreachV3SessionPath(sessionId)}/archive`);
}

export interface OutreachV3SessionSummary {
  id: string;
  tenantId?: string;
  createdByUserId?: string;
  status: 'active' | 'completed' | 'archived' | string;
  currentStateVersion: number;
  title: string | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  /** Current Campaign Spec goal.topic — the real campaign name to display. */
  topic?: string | null;
  /** Current Campaign Spec goal.goal. */
  goal?: string | null;
  /** Selected target count on the session's current spec version. */
  targetCount?: number;
  /**
   * Artifact-root record status: 'draft' | 'sent' | 'partial' | 'failed' | …
   * `null` until the campaign creates its first draft artifact. This — not
   * `status` — is where a completed real send is recorded for a V3 campaign.
   */
  recordStatus?: string | null;
  sentAt?: string | null;
  [key: string]: unknown;
}

export type OutreachV3CampaignBucket = 'draft' | 'sent' | 'archived';

/**
 * Which home-screen bucket a campaign belongs in.
 *
 * 'sent' requires a real recorded send outcome on the artifact root. A
 * campaign that merely reached the Send step, or whose only send was a test
 * send (never mirrored onto the record), stays a draft — the list must not
 * claim a send that did not happen.
 */
export function outreachV3CampaignBucket(
  row: OutreachV3SessionSummary,
): OutreachV3CampaignBucket {
  if (row.status === 'archived') return 'archived';
  const record = (row.recordStatus ?? '').trim().toLowerCase();
  if (record === 'sent' || record === 'partial' || record === 'failed') return 'sent';
  return 'draft';
}

/**
 * GET /api/engagement/outreach-v3/sessions — owned campaign list.
 * Backend returns a bare array of session rows (not an envelope).
 */
export async function listOutreachV3Sessions(
  api: AxiosInstance,
  input: { limit?: number; offset?: number; includeArchived?: boolean } = {},
): Promise<OutreachV3SessionSummary[]> {
  const params = new URLSearchParams();
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.offset != null) params.set('offset', String(input.offset));
  if (input.includeArchived != null) {
    params.set('includeArchived', input.includeArchived ? 'true' : 'false');
  }
  const query = params.toString();
  const data = (
    await api.get<OutreachV3SessionSummary[] | { items?: OutreachV3SessionSummary[] }>(
      `${ROOT}/sessions${query ? `?${query}` : ''}`,
    )
  ).data;
  const rows = Array.isArray(data) ? data : (data.items ?? []);
  return rows.map((row) => ({
    ...row,
    id: String(row.id),
    status: String(row.status ?? 'active'),
    currentStateVersion: Number(row.currentStateVersion ?? 1),
    title: typeof row.title === 'string' ? row.title : row.title ?? null,
    topic: typeof row.topic === 'string' ? row.topic : null,
    goal: typeof row.goal === 'string' ? row.goal : null,
    // Absent (an older API build that predates the enriched list) must read
    // as 0/null, never as a fabricated count or a claimed send.
    targetCount: Number.isFinite(Number(row.targetCount)) ? Number(row.targetCount) : 0,
    recordStatus: typeof row.recordStatus === 'string' ? row.recordStatus : null,
    sentAt: typeof row.sentAt === 'string' ? row.sentAt : null,
  }));
}

export async function applyOutreachV3Commands(
  api: AxiosInstance,
  sessionId: string,
  expectedStateVersion: number,
  commands: OutreachV3Command[],
): Promise<OutreachV3CommandBatchResult> {
  const response = await api.post<OutreachV3CommandBatchResult>(
    `${outreachV3SessionPath(sessionId)}/commands`,
    {
      batchId: crypto.randomUUID(),
      expectedStateVersion,
      commands,
    },
  );
  return response.data;
}

export async function listOutreachV3Proposals(
  api: AxiosInstance,
  sessionId: string,
): Promise<OutreachV3Proposal[]> {
  const data = (
    await api.get<OutreachV3ProposalWire[] | { items?: OutreachV3ProposalWire[] }>(
      `${outreachV3SessionPath(sessionId)}/proposals?limit=100`,
    )
  ).data;
  const rows = Array.isArray(data) ? data : (data.items ?? []);
  return rows.map(normalizeProposal);
}

export async function applyOutreachV3Proposal(
  api: AxiosInstance,
  sessionId: string,
  proposalId: string,
): Promise<OutreachV3CommandBatchResult> {
  const response = await api.post<{
    proposalId: string;
    result: OutreachV3CommandBatchResult;
  }>(`${outreachV3SessionPath(sessionId)}/proposals/${encodeURIComponent(proposalId)}/apply`);
  return response.data.result;
}

export async function rejectOutreachV3Proposal(
  api: AxiosInstance,
  sessionId: string,
  proposalId: string,
  rejectionCode = 'user_discarded',
): Promise<void> {
  await api.post(
    `${outreachV3SessionPath(sessionId)}/proposals/${encodeURIComponent(proposalId)}/reject`,
    { rejectionCode },
  );
}

export async function createOutreachV3Conversation(
  api: AxiosInstance,
  sessionId: string,
): Promise<OutreachV3Conversation> {
  return (
    await api.post<OutreachV3Conversation>(
      `${outreachV3SessionPath(sessionId)}/reasoning/conversations`,
    )
  ).data;
}

export async function listOutreachV3Turns(
  api: AxiosInstance,
  conversationId: string,
): Promise<unknown[]> {
  const data = (
    await api.get<unknown[] | { items?: unknown[] }>(
      `${ROOT}/reasoning/conversations/${encodeURIComponent(conversationId)}/turns?limit=100`,
    )
  ).data;
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function sendOutreachV3Turn(
  api: AxiosInstance,
  conversationId: string,
  message: string,
): Promise<OutreachV3ReasoningTurnResult> {
  return (
    await api.post<OutreachV3ReasoningTurnResult>(
      `${ROOT}/reasoning/conversations/${encodeURIComponent(conversationId)}/turns`,
      { message },
    )
  ).data;
}

export async function searchOutreachV3Targets(
  api: AxiosInstance,
  sessionId: string,
  input: {
    query?: string;
    clientId?: string | null;
    sources?: string[];
    limit?: number;
  },
): Promise<CapabilityResult<OutreachV3TargetSearchData>> {
  return (
    await api.post<CapabilityResult<OutreachV3TargetSearchData>>(
      `${outreachV3SessionPath(sessionId)}/targets/search`,
      {
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        ...(input.clientId ? { clientId: input.clientId } : {}),
        ...(input.sources?.length ? { sources: input.sources } : {}),
        limit: input.limit ?? 20,
      },
    )
  ).data;
}

export async function getOutreachV3TargetProfile(
  api: AxiosInstance,
  sessionId: string,
  targetRef: OutreachV3TargetLocator,
): Promise<OutreachV3TargetProfileResponse> {
  return (
    await api.post<OutreachV3TargetProfileResponse>(
      `${outreachV3SessionPath(sessionId)}/targets/profile`,
      { targetRef },
    )
  ).data;
}

export async function getOutreachV3TargetRelationships(
  api: AxiosInstance,
  sessionId: string,
  targetRef: OutreachV3TargetLocator,
  clientId: string,
): Promise<OutreachV3RelationshipResponse> {
  return (
    await api.post<OutreachV3RelationshipResponse>(
      `${outreachV3SessionPath(sessionId)}/targets/relationships`,
      { targetRef, clientId },
    )
  ).data;
}

export async function getOutreachV3TargetCoverage(
  api: AxiosInstance,
  sessionId: string,
): Promise<OutreachV3TargetCoverageResponse> {
  return (
    await api.get<OutreachV3TargetCoverageResponse>(
      `${outreachV3SessionPath(sessionId)}/targets/coverage`,
    )
  ).data;
}

export async function searchOutreachV3Memory(
  api: AxiosInstance,
  sessionId: string,
  input: {
    query: string;
    clientId?: string | null;
    intendedClass: OutreachV3ContextClass;
    scope: OutreachV3ContextScope;
    limit?: number;
  },
): Promise<CapabilityResult<OutreachV3MemorySearchData>> {
  return (
    await api.post<CapabilityResult<OutreachV3MemorySearchData>>(
      `${outreachV3SessionPath(sessionId)}/context/memory/search`,
      {
        query: input.query.trim(),
        clientId: input.clientId ?? null,
        intendedClass: input.intendedClass,
        scope: input.scope,
        limit: input.limit ?? 20,
      },
    )
  ).data;
}

export async function searchOutreachV3Government(
  api: AxiosInstance,
  sessionId: string,
  input: {
    query: string;
    categories?: string[];
    intendedClass: Exclude<OutreachV3ContextClass, 'writing_guidance'>;
    scope: OutreachV3ContextScope;
    limit?: number;
  },
): Promise<CapabilityResult<OutreachV3GovernmentSearchData>> {
  return (
    await api.post<CapabilityResult<OutreachV3GovernmentSearchData>>(
      `${outreachV3SessionPath(sessionId)}/context/government/search`,
      {
        query: input.query.trim(),
        categories: input.categories ?? [],
        intendedClass: input.intendedClass,
        scope: input.scope,
        limit: input.limit ?? 20,
      },
    )
  ).data;
}

export async function getOutreachV3ContextReview(
  api: AxiosInstance,
  sessionId: string,
): Promise<OutreachV3ContextReviewResponse> {
  return (
    await api.get<OutreachV3ContextReviewResponse>(
      `${outreachV3SessionPath(sessionId)}/context/review`,
    )
  ).data;
}

/** One `documents` row of `GET /api/engagement/outreach/context-library`. */
interface ContextLibraryDocumentWire {
  id?: unknown;
  clientId?: unknown;
  clientName?: unknown;
  title?: unknown;
  date?: unknown;
}

/**
 * Stored documents that the V3 `document` locator can actually resolve.
 *
 * Reuses the V2 builder's tenant-wide library rather than adding a route: this
 * path is NOT under `/api/engagement/outreach-v3/`, so `engagementPreviewHeader`
 * deliberately does not tag it and it is served by the main API, which owns the
 * endpoint. No manifest, ALB rule, or engagement-api change is involved.
 *
 * The library mixes several kinds behind prefixed ids. Only `doc-<uuid>` rows
 * are real `engagementAttachment` ids; `clientnote-*` and the meeting-derived
 * rows are not, and would resolve to a 404 on accept. They are dropped here
 * rather than offered and allowed to fail.
 */
export async function listOutreachV3ContextDocuments(
  api: AxiosInstance,
  clientId: string,
): Promise<OutreachV3ContextDocumentCandidate[]> {
  const data = (
    await api.get<{ documents?: ContextLibraryDocumentWire[] }>(
      '/api/engagement/outreach/context-library',
    )
  ).data;
  const rows = Array.isArray(data?.documents) ? data.documents : [];
  const candidates: OutreachV3ContextDocumentCandidate[] = [];
  for (const row of rows) {
    const rawId = typeof row.id === 'string' ? row.id : '';
    if (!rawId.startsWith('doc-')) continue;
    const attachmentId = rawId.slice('doc-'.length);
    if (!attachmentId) continue;
    const rowClientId = typeof row.clientId === 'string' ? row.clientId : null;
    // `resolveDocument` compares the attachment's clientId to the locator's and
    // 404s on any mismatch, and the sponsor-isolation policy rejects
    // client-specific context that is not the sole sponsor client. Offering a
    // different client's document could therefore only ever fail.
    if (rowClientId !== clientId) continue;
    candidates.push({
      attachmentId,
      clientId: rowClientId,
      clientName: typeof row.clientName === 'string' ? row.clientName : 'Client',
      title: typeof row.title === 'string' && row.title.trim() ? row.title : 'Untitled document',
      date: typeof row.date === 'string' ? row.date : null,
      selection: {
        // contextClass/scope are placeholders: the Context surface rewrites both
        // from the purpose the user picks, and the server re-derives every trust
        // flag when it re-resolves this locator.
        locator: { source: 'document', id: attachmentId, clientId: rowClientId },
        contextClass: 'campaign_fact',
        scope: { kind: 'campaign' },
      },
    });
  }
  return candidates;
}

export interface OutreachV3UnifiedContextSearchInput {
  query: string;
  /** Sole sponsor client, or null for a client-neutral campaign. */
  clientId: string | null;
  limit?: number;
}

export interface OutreachV3UnifiedContextSearchResult {
  candidates: OutreachV3ContextCandidate[];
  /** Per-source failure sentences, so one dead source cannot blank the stage. */
  failures: Array<{ source: 'memory' | 'government'; message: string }>;
  /**
   * True when the query was too short to search and NO request was sent.
   *
   * Both capability schemas and both controller DTOs require `query` to be at
   * least two characters, so a blank campaign topic would otherwise 400 both
   * legs the moment the stage opened. Skipping is not a failure: the document
   * library needs no query and still lists.
   */
  skipped: boolean;
}

/** Shortest query the memory and government capabilities will accept. */
export const OUTREACH_V3_CONTEXT_MIN_QUERY = 2;

/**
 * One query, every searchable context source, in parallel.
 *
 * `search_memory` takes an `intendedClass` and pre-filters on it
 * (`compatibleWithClass`). We deliberately probe with `campaign_fact`, the one
 * value whose filter branch returns true unconditionally — that makes this an
 * UNFILTERED read of the tenant's memory rather than a taxonomy-narrowed one.
 * The class each row is finally accepted under is chosen per item afterwards, and
 * re-validated server-side, so probing with a permissive class grants nothing.
 *
 * `Promise.allSettled`, not `all`: government search reaching into twelve
 * datasets is the more failure-prone leg, and a government outage must not also
 * hide institutional memory.
 */
export async function searchOutreachV3ContextAll(
  api: AxiosInstance,
  sessionId: string,
  input: OutreachV3UnifiedContextSearchInput,
): Promise<OutreachV3UnifiedContextSearchResult> {
  const limit = input.limit ?? 20;
  const query = input.query.trim();
  if (query.length < OUTREACH_V3_CONTEXT_MIN_QUERY) {
    return { candidates: [], failures: [], skipped: true };
  }
  const [memory, government] = await Promise.allSettled([
    searchOutreachV3Memory(api, sessionId, {
      query,
      clientId: input.clientId,
      intendedClass: 'campaign_fact',
      scope: { kind: 'campaign' },
      limit,
    }),
    searchOutreachV3Government(api, sessionId, {
      query,
      intendedClass: 'campaign_fact',
      scope: { kind: 'campaign' },
      limit,
    }),
  ]);

  const candidates: OutreachV3ContextCandidate[] = [];
  const failures: OutreachV3UnifiedContextSearchResult['failures'] = [];

  if (memory.status === 'fulfilled') {
    for (const candidate of memory.value?.data?.candidates ?? []) {
      candidates.push({ ...candidate, sourceKind: 'memory' });
    }
  } else {
    failures.push({ source: 'memory', message: safeOutreachV3Error(memory.reason) });
  }

  if (government.status === 'fulfilled') {
    for (const candidate of government.value?.data?.candidates ?? []) {
      candidates.push({ ...candidate, sourceKind: 'government' });
    }
  } else {
    failures.push({ source: 'government', message: safeOutreachV3Error(government.reason) });
  }

  return { candidates, failures, skipped: false };
}

export async function getOutreachV3Strategy(
  api: AxiosInstance,
  sessionId: string,
): Promise<CapabilityResult<OutreachV3StrategyData>> {
  const response = await api.get<CapabilityResult<OutreachV3StrategyWireData>>(
    `${outreachV3SessionPath(sessionId)}/context/strategy`,
  );
  const wire = response.data;
  const tone = sentence(wire.data.recommendedTone);
  const length = wire.data.recommendedLength as OutreachV3Length;
  const warnings = [...wire.data.unresolvedDecisions, ...wire.data.safetyNotes];
  const recommendation = {
    campaignAngle: null,
    tone,
    length,
    rationale: wire.data.rationale,
    warnings,
    recommendedPattern: wire.data.recommendedPattern,
    recommendedPersonalization: wire.data.recommendedPersonalization,
  };
  return {
    ...wire,
    data: {
      tone,
      length,
      rationale: wire.data.rationale,
      warnings,
      recommendedPattern: wire.data.recommendedPattern,
      recommendedPersonalization: wire.data.recommendedPersonalization,
      recommendation,
    },
  };
}

export function targetCandidateToLocator(
  candidate: OutreachV3TargetCandidate,
): OutreachV3TargetLocator {
  return candidate.locator;
}

function extractOutreachV3ErrorParts(error: unknown): {
  status: number | null;
  code: string | null;
  message: string | null;
} {
  const response = (error as {
    response?: { status?: number; data?: unknown };
    message?: unknown;
  })?.response;
  const data = response?.data;
  let code: string | null = null;
  let message: string | null = null;

  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code.trim()) code = record.code.trim();

    const raw = record.message;
    if (typeof raw === 'string' && raw.trim()) {
      message = raw.trim();
    } else if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) {
      message = raw[0].trim();
    } else if (raw && typeof raw === 'object') {
      const nested = raw as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message.trim()) {
        message = nested.message.trim();
      }
      if (!code && typeof nested.code === 'string' && nested.code.trim()) {
        code = nested.code.trim();
      }
    }

    // Nest sometimes nests the whole payload under `error` or flattens only statusCode.
    if (!message && typeof record.error === 'string' && record.error.trim()) {
      message = record.error.trim();
    }
  }

  if (!message) {
    const top = (error as { message?: unknown })?.message;
    if (typeof top === 'string' && top.trim() && !top.startsWith('Request failed with status')) {
      message = top.trim();
    }
  }

  return {
    status: response?.status ?? null,
    code,
    message,
  };
}

/**
 * Prefer the server's real code/message over a generic 503 wrap so Meri/OpenAI
 * and shadow-runtime denials stay diagnosable in the UI (audit OpenAI sheet).
 */
export function safeOutreachV3Error(error: unknown): string {
  const { status, code, message } = extractOutreachV3ErrorParts(error);

  if (code === 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED') {
    return (
      message ||
      'This action is disabled in the engagement-api shadow runtime. Dedicated Outreach V3 flags must be armed on that process.'
    );
  }
  if (code === 'OUTREACH_REASONING_PROVIDER_UNAVAILABLE') {
    return (
      message ||
      'OpenAI reasoning is not configured/available for this Capiro environment. Meri chat is OpenAI-only (Anthropic cannot serve it). Set OPENAI_API_KEY or tenant OpenAI BYOK, and a valid OUTREACH_V3_REASONING_MODEL / OPENAI_MODEL.'
    );
  }
  if (code === 'OUTREACH_REASONING_PROVIDER_STATE_DISABLED') {
    return (
      message ||
      'Provider-managed Outreach conversation state is not enabled for this environment.'
    );
  }
  if (code === 'OUTREACH_V3_FULL_GENERATION_WORKER_DISABLED') {
    return message || 'The Outreach V3 full-generation worker is disabled on this runtime.';
  }
  if (code === 'OUTREACH_V3_SEND_WORKER_DISABLED') {
    return message || 'The Outreach V3 send-intent worker is disabled on this runtime.';
  }

  if (message) {
    // Keep the server sentence; append code only when it adds diagnosis value.
    if (code && !message.includes(code)) return `${message} (${code})`;
    return message;
  }

  if (status === 404) {
    return 'Outreach V3 is not enabled for this preview runtime.';
  }
  if (status === 409) {
    return 'The campaign changed. Refresh before applying this action.';
  }
  if (status === 503) {
    return 'This Outreach capability is temporarily unavailable. Deterministic controls remain safe. Check Network response code/message — Meri chat needs OpenAI on engagement-api, and generate/send need OUTREACH_V3_* flags.';
  }
  return 'Outreach could not complete that action.';
}

export function outreachV3ErrorCode(error: unknown): string | null {
  return extractOutreachV3ErrorParts(error).code;
}

function normalizeProposal(row: OutreachV3ProposalWire): OutreachV3Proposal {
  const rawCommands = Array.isArray(row.commands)
    ? row.commands
    : Array.isArray(row.commandsJsonb)
      ? row.commandsJsonb
      : [];
  const commands = rawCommands.filter(isCommand);
  const { id, status, expectedStateVersion, ...rest } = row;
  return {
    ...rest,
    id: String(id),
    status: String(status),
    expectedStateVersion: Number(expectedStateVersion),
    commands,
  };
}

function isCommand(value: unknown): value is OutreachV3Command {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OutreachV3Command>;
  return (
    typeof candidate.type === 'string' &&
    candidate.schemaVersion === 1 &&
    Boolean(candidate.payload) &&
    typeof candidate.payload === 'object'
  );
}

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}