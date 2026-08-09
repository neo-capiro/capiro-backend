import type { AxiosInstance } from 'axios';
import type {
  CapabilityResult,
  OutreachV3Command,
  OutreachV3CommandBatchResult,
  OutreachV3ContextClass,
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
  OutreachV3TargetProfileResponse,
  OutreachV3TargetSearchData,
} from './contracts.js';

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
    await api.get<OutreachV3Proposal[] | { items?: OutreachV3Proposal[] }>(
      `${outreachV3SessionPath(sessionId)}/proposals?limit=100`,
    )
  ).data;
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function applyOutreachV3Proposal(
  api: AxiosInstance,
  sessionId: string,
  proposalId: string,
): Promise<OutreachV3CommandBatchResult> {
  return (
    await api.post<OutreachV3CommandBatchResult>(
      `${outreachV3SessionPath(sessionId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
    )
  ).data;
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

export function safeOutreachV3Error(error: unknown): string {
  const response = (error as {
    response?: { status?: number; data?: { message?: unknown; code?: unknown } };
    message?: unknown;
  })?.response;
  const raw = response?.data?.message;
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  if (response?.status === 404) {
    return 'Outreach V3 is not enabled for this preview runtime.';
  }
  if (response?.status === 409) {
    return 'The campaign changed. Refresh before applying this action.';
  }
  if (response?.status === 503) {
    return 'This Outreach capability is temporarily unavailable. Deterministic controls remain safe.';
  }
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' && message.trim()
    ? message
    : 'Outreach could not complete that action.';
}

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
