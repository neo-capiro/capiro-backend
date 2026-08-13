import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type {
  CapabilityResult,
  OutreachV3Command,
  OutreachV3ContextCandidate,
  OutreachV3ContextClass,
  OutreachV3ContextReviewResponse,
  OutreachV3ContextScope,
  OutreachV3GovernmentSearchData,
  OutreachV3MemorySearchData,
  OutreachV3Proposal,
  OutreachV3Readiness,
  OutreachV3SessionEnvelope,
  OutreachV3Stage,
  OutreachV3StrategyData,
  OutreachV3TargetCandidate,
  OutreachV3TargetCoverageResponse,
  OutreachV3TargetLocator,
  OutreachV3TargetSearchData,
  OutreachV3TranscriptTurn,
} from './contracts.js';
import type { OutreachV3TargetProfileResponse } from './target-intelligence-contracts.js';
import {
  applyOutreachV3Commands,
  applyOutreachV3Proposal,
  archiveOutreachV3Session,
  createOutreachV3Conversation,
  createOutreachV3Session,
  getOutreachV3ContextReview,
  getOutreachV3Session,
  getOutreachV3Strategy,
  getOutreachV3TargetCoverage,
  getOutreachV3TargetProfile,
  listOutreachV3Proposals,
  listOutreachV3Turns,
  rejectOutreachV3Proposal,
  safeOutreachV3Error,
  searchOutreachV3Government,
  searchOutreachV3Memory,
  searchOutreachV3Targets,
  sendOutreachV3Turn,
} from './outreach-v3-api.js';

const ACTIVE_SESSION_KEY = 'capiro.outreach-v3.active-session';
const conversationKey = (sessionId: string) => `capiro.outreach-v3.conversation.${sessionId}`;

const FUTURE_PHASE_BLOCKERS = new Set([
  'GENERATION_NOT_AVAILABLE',
  'DRAFTS_NOT_AVAILABLE',
  'PREFLIGHT_NOT_AVAILABLE',
]);

function readSessionStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Session continuity is a convenience. Canonical state remains on the server.
  }
}

function responseStatus(error: unknown): number | null {
  return (error as { response?: { status?: number } })?.response?.status ?? null;
}

function normalizeTurns(rows: unknown[]): OutreachV3TranscriptTurn[] {
  const turns: OutreachV3TranscriptTurn[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : crypto.randomUUID();
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : undefined;
    const status = row.status === 'failed' ? 'failed' : 'complete';
    const user =
      typeof row.userMessage === 'string'
        ? row.userMessage
        : typeof row.userMessageText === 'string'
          ? row.userMessageText
          : null;
    const assistant =
      typeof row.assistantMessage === 'string'
        ? row.assistantMessage
        : typeof row.assistantMessageText === 'string'
          ? row.assistantMessageText
          : null;
    if (user) turns.push({ id: `${id}:user`, role: 'user', text: user, status, createdAt });
    if (assistant) {
      turns.push({
        id: `${id}:assistant`,
        role: 'assistant',
        text: assistant,
        status,
        createdAt,
        proposalIds: Array.isArray(row.proposalIds)
          ? row.proposalIds.filter((value): value is string => typeof value === 'string')
          : undefined,
      });
    }
    if (!assistant && status === 'failed') {
      turns.push({
        id: `${id}:failure`,
        role: 'system',
        text: 'Meri could not complete that turn. Canonical campaign controls are still available.',
        status: 'failed',
        createdAt,
      });
    }
  }
  return turns;
}

function readinessCode(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** All blocker codes exactly as returned by the canonical backend readiness engine. */
export function outreachV3ReadinessBlockerCodes(readiness: OutreachV3Readiness): string[] {
  return [...new Set((readiness.blockers ?? []).map(readinessCode).filter(Boolean) as string[])];
}

/**
 * Planning blockers exclude capabilities deliberately owned by the next phase.
 * This keeps Phase 6 from claiming generation is available while also avoiding
 * a permanently red planning brief simply because generation/drafts/preflight
 * are intentionally dark.
 */
export function outreachV3PlanningBlockerCodes(readiness: OutreachV3Readiness): string[] {
  return outreachV3ReadinessBlockerCodes(readiness).filter(
    (code) => !FUTURE_PHASE_BLOCKERS.has(code),
  );
}

function stageFromCanonicalReadiness(readiness: OutreachV3Readiness): OutreachV3Stage | null {
  if (!Array.isArray(readiness.blockers)) return null;
  const blockers = new Set(outreachV3ReadinessBlockerCodes(readiness));
  if (blockers.has('GOAL_MISSING')) return 'goal';
  if (blockers.has('SPONSOR_UNDECIDED') || blockers.has('SPONSOR_SCOPE_INVALID')) {
    return 'sponsor';
  }
  if (
    blockers.has('TARGET_CRITERIA_MISSING') ||
    blockers.has('TARGETS_NOT_IMPLEMENTED_YET') ||
    blockers.has('TARGETS_MISSING')
  ) {
    return 'targets';
  }
  if (blockers.has('DELIVERY_UNDECIDED')) return 'delivery';
  if (
    blockers.has('CONTEXT_NOT_IMPLEMENTED_YET') ||
    blockers.has('CONTEXT_NOT_REVIEWED') ||
    blockers.has('CONTEXT_HAS_UNVERIFIED_EVIDENCE')
  ) {
    return 'context';
  }
  if (blockers.has('STRATEGY_INCOMPLETE')) return 'strategy';
  return 'ready_for_generation';
}

function fallbackStageFromSpec(session: OutreachV3SessionEnvelope): OutreachV3Stage {
  const { spec } = session;
  if (!spec.goal.goal || !spec.goal.objective) return 'goal';
  if (spec.sponsor.kind === 'undecided') return 'sponsor';
  if (spec.targeting.criteria === null || spec.targeting.selectedTargetRefs.length === 0) {
    return 'targets';
  }
  if (
    spec.delivery.pattern === 'undecided' ||
    spec.delivery.personalization === 'undecided'
  ) {
    return 'delivery';
  }
  const acceptedContextCount =
    spec.context.requiredPolicyRefs.length +
    spec.context.writingGuidanceRefs.length +
    spec.context.campaignFactRefs.length +
    spec.context.targetSpecificRefs.length +
    spec.context.groupSafeRefs.length;
  if (acceptedContextCount === 0) return 'context';
  if (!spec.strategy.campaignAngle || !spec.strategy.tone || spec.strategy.length === 'undecided') {
    return 'strategy';
  }
  return 'ready_for_generation';
}

/**
 * The server-derived readiness contract selects the required stage. The spec
 * fallback exists only for an older cached response that predates readiness;
 * it never overrides a current backend blocker.
 */
export function deriveOutreachV3Stage(session: OutreachV3SessionEnvelope | null): OutreachV3Stage {
  if (!session) return 'goal';
  return stageFromCanonicalReadiness(session.readiness) ?? fallbackStageFromSpec(session);
}

export interface UseOutreachV3SessionOptions {
  title?: string;
}

export interface OutreachV3ContextSearchInput {
  source: 'memory' | 'government';
  query: string;
  clientId?: string | null;
  intendedClass: OutreachV3ContextClass;
  scope: OutreachV3ContextScope;
  categories?: string[];
  limit?: number;
}

export type OutreachV3ContextSearchResult =
  | { source: 'memory'; result: CapabilityResult<OutreachV3MemorySearchData> }
  | { source: 'government'; result: CapabilityResult<OutreachV3GovernmentSearchData> };

export function useOutreachV3Session(options: UseOutreachV3SessionOptions = {}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(() =>
    readSessionStorage(ACTIVE_SESSION_KEY),
  );
  const [transientTurns, setTransientTurns] = useState<OutreachV3TranscriptTurn[]>([]);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [startingNewSession, setStartingNewSession] = useState(false);

  const bootstrapKey = ['outreach-v3', 'bootstrap', options.title ?? 'new'] as const;
  const bootstrap = useQuery({
    queryKey: bootstrapKey,
    enabled: !sessionId,
    queryFn: () => createOutreachV3Session(api, options.title ?? 'New outreach campaign'),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  useEffect(() => {
    const id = bootstrap.data?.session.id;
    if (!id || sessionId) return;
    writeSessionStorage(ACTIVE_SESSION_KEY, id);
    setSessionId(id);
  }, [bootstrap.data, sessionId]);

  const sessionQuery = useQuery({
    queryKey: ['outreach-v3', 'session', sessionId],
    enabled: Boolean(sessionId),
    queryFn: () => getOutreachV3Session(api, sessionId!),
    retry: false,
  });

  useEffect(() => {
    if (!sessionId || !sessionQuery.isError || responseStatus(sessionQuery.error) !== 404) return;
    writeSessionStorage(ACTIVE_SESSION_KEY, null);
    writeSessionStorage(conversationKey(sessionId), null);
    setTransientTurns([]);
    queryClient.removeQueries({ queryKey: ['outreach-v3', 'bootstrap'] });
    queryClient.removeQueries({ queryKey: ['outreach-v3', 'session', sessionId] });
    queryClient.removeQueries({ queryKey: ['outreach-v3', 'conversation', sessionId] });
    setSessionId(null);
  }, [queryClient, sessionId, sessionQuery.error, sessionQuery.isError]);

  const conversationQuery = useQuery({
    queryKey: ['outreach-v3', 'conversation', sessionId],
    enabled: Boolean(sessionId && sessionQuery.data),
    queryFn: async () => {
      const stored = readSessionStorage(conversationKey(sessionId!));
      if (stored) return { id: stored, sessionId: sessionId! };
      const created = await createOutreachV3Conversation(api, sessionId!);
      writeSessionStorage(conversationKey(sessionId!), created.id);
      return created;
    },
    retry: false,
  });

  const conversationId = conversationQuery.data?.id ?? null;
  const turnsQuery = useQuery({
    queryKey: ['outreach-v3', 'turns', conversationId],
    enabled: Boolean(conversationId),
    queryFn: () => listOutreachV3Turns(api, conversationId!),
    retry: false,
  });

  useEffect(() => {
    if (
      !sessionId ||
      !conversationId ||
      !turnsQuery.isError ||
      responseStatus(turnsQuery.error) !== 404
    ) {
      return;
    }
    writeSessionStorage(conversationKey(sessionId), null);
    queryClient.removeQueries({ queryKey: ['outreach-v3', 'turns', conversationId] });
    void queryClient.resetQueries({
      queryKey: ['outreach-v3', 'conversation', sessionId],
      exact: true,
    });
  }, [conversationId, queryClient, sessionId, turnsQuery.error, turnsQuery.isError]);

  const proposalsQuery = useQuery({
    queryKey: ['outreach-v3', 'proposals', sessionId],
    enabled: Boolean(sessionId),
    queryFn: () => listOutreachV3Proposals(api, sessionId!),
    retry: false,
  });

  const coverageQuery = useQuery({
    queryKey: ['outreach-v3', 'coverage', sessionId, sessionQuery.data?.specHash],
    enabled: Boolean(sessionId && sessionQuery.data?.spec.targeting.selectedTargetRefs.length),
    queryFn: () => getOutreachV3TargetCoverage(api, sessionId!),
    retry: false,
  });

  const contextReviewQuery = useQuery({
    queryKey: ['outreach-v3', 'context-review', sessionId, sessionQuery.data?.specHash],
    enabled: Boolean(sessionId && sessionQuery.data),
    queryFn: () => getOutreachV3ContextReview(api, sessionId!),
    retry: false,
  });

  const strategyQuery = useQuery({
    queryKey: ['outreach-v3', 'strategy', sessionId, sessionQuery.data?.specHash],
    enabled: Boolean(sessionId && sessionQuery.data),
    queryFn: () => getOutreachV3Strategy(api, sessionId!),
    retry: false,
  });

  const refreshCanonical = useCallback(async () => {
    if (!sessionId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'session', sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'proposals', sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'coverage', sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'context-review', sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'strategy', sessionId] }),
    ]);
  }, [queryClient, sessionId]);

  const refreshAfterConflict = useCallback(
    (error: unknown) => {
      if (responseStatus(error) === 409) void refreshCanonical();
    },
    [refreshCanonical],
  );

  const commandsMutation = useMutation({
    mutationFn: async (commands: OutreachV3Command[]) => {
      const current = sessionQuery.data;
      if (!sessionId || !current) throw new Error('The Outreach session is not ready.');
      return applyOutreachV3Commands(api, sessionId, current.currentStateVersion, commands);
    },
    onSuccess: refreshCanonical,
    onError: refreshAfterConflict,
  });

  const reasoningMutation = useMutation({
    mutationFn: async (message: string) => {
      if (!conversationId) throw new Error('Meri is not available for this session yet.');
      const text = message.trim();
      if (!text) throw new Error('Enter a message for Meri.');
      setTransientTurns((current) => [
        ...current,
        { id: `pending:${crypto.randomUUID()}`, role: 'user', text, status: 'pending' },
      ]);
      return sendOutreachV3Turn(api, conversationId, text);
    },
    onSuccess: async (result) => {
      setTransientTurns((current) => [
        ...current,
        {
          id: `pending:${crypto.randomUUID()}`,
          role: 'assistant',
          text: result.assistantMessage,
          status: 'complete',
          proposalIds: result.proposalIds,
        },
      ]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'turns', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['outreach-v3', 'proposals', sessionId] }),
      ]);
      setTransientTurns([]);
    },
    onError: (error) => {
      setTransientTurns((current) => [
        ...current.map((turn) =>
          turn.status === 'pending' ? { ...turn, status: 'failed' as const } : turn,
        ),
        {
          id: `failed:${crypto.randomUUID()}`,
          role: 'system',
          text: safeOutreachV3Error(error),
          status: 'failed',
        },
      ]);
    },
  });

  const applyProposalMutation = useMutation({
    mutationFn: async (proposal: OutreachV3Proposal) => {
      if (!sessionId) throw new Error('The Outreach session is not ready.');
      return applyOutreachV3Proposal(api, sessionId, proposal.id);
    },
    onSuccess: refreshCanonical,
    onError: refreshAfterConflict,
  });

  const rejectProposalMutation = useMutation({
    mutationFn: async (proposal: OutreachV3Proposal) => {
      if (!sessionId) throw new Error('The Outreach session is not ready.');
      await rejectOutreachV3Proposal(api, sessionId, proposal.id);
    },
    onSuccess: refreshCanonical,
  });

  const targetSearchMutation = useMutation({
    mutationFn: (input: {
      query?: string;
      clientId?: string | null;
      sources?: string[];
      limit?: number;
    }) => {
      if (!sessionId) throw new Error('The Outreach session is not ready.');
      return searchOutreachV3Targets(api, sessionId, input);
    },
  });

  const targetProfileMutation = useMutation({
    mutationFn: (locator: OutreachV3TargetLocator) => {
      if (!sessionId) throw new Error('The Outreach session is not ready.');
      return getOutreachV3TargetProfile(api, sessionId, locator);
    },
  });

  const contextSearchMutation = useMutation<
    OutreachV3ContextSearchResult,
    Error,
    OutreachV3ContextSearchInput
  >({
    mutationFn: (input: OutreachV3ContextSearchInput): Promise<OutreachV3ContextSearchResult> => {
      if (!sessionId) throw new Error('The Outreach session is not ready.');
      if (input.source === 'memory') {
        return searchOutreachV3Memory(api, sessionId, {
          query: input.query,
          clientId: input.clientId ?? null,
          intendedClass: input.intendedClass,
          scope: input.scope,
          limit: input.limit,
        }).then((result) => ({ source: 'memory' as const, result }));
      }
      if (input.intendedClass === 'writing_guidance') {
        throw new Error('Government records cannot be used as writing-guidance memory.');
      }
      return searchOutreachV3Government(api, sessionId, {
        query: input.query,
        categories: input.categories,
        intendedClass: input.intendedClass,
        scope: input.scope,
        limit: input.limit,
      }).then((result) => ({ source: 'government' as const, result }));
    },
  });

  const retryReasoning = useCallback(async () => {
    if (!sessionId) return;
    const priorConversationId = conversationId;
    writeSessionStorage(conversationKey(sessionId), null);
    setTransientTurns([]);
    if (priorConversationId) {
      queryClient.removeQueries({ queryKey: ['outreach-v3', 'turns', priorConversationId] });
    }
    await queryClient.resetQueries({
      queryKey: ['outreach-v3', 'conversation', sessionId],
      exact: true,
    });
  }, [conversationId, queryClient, sessionId]);

  const startNewSession = useCallback(async () => {
    if (startingNewSession) return;
    const priorId = sessionId;
    setLifecycleError(null);
    setStartingNewSession(true);
    try {
      if (priorId) await archiveOutreachV3Session(api, priorId);
      writeSessionStorage(ACTIVE_SESSION_KEY, null);
      if (priorId) writeSessionStorage(conversationKey(priorId), null);
      setTransientTurns([]);
      setSessionId(null);
      queryClient.removeQueries({ queryKey: ['outreach-v3'] });
    } catch (error) {
      setLifecycleError(safeOutreachV3Error(error));
      throw error;
    } finally {
      setStartingNewSession(false);
    }
  }, [api, queryClient, sessionId, startingNewSession]);

  const serverTurns = useMemo(
    () => normalizeTurns(turnsQuery.data ?? []),
    [turnsQuery.data],
  );

  const pendingProposals = useMemo(() => {
    const currentVersion = sessionQuery.data?.currentStateVersion;
    return (proposalsQuery.data ?? [])
      .filter((proposal) => proposal.status === 'pending')
      .sort((left, right) => {
        const leftCurrent = left.expectedStateVersion === currentVersion ? 1 : 0;
        const rightCurrent = right.expectedStateVersion === currentVersion ? 1 : 0;
        if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
        return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
      });
  }, [proposalsQuery.data, sessionQuery.data?.currentStateVersion]);

  const contextCandidates = useMemo<OutreachV3ContextCandidate[]>(() => {
    const value = contextSearchMutation.data;
    if (!value) return [];
    if (value.source === 'memory') {
      return value.result.data.candidates.map((candidate) => ({ ...candidate, sourceKind: 'memory' }));
    }
    return value.result.data.candidates.map((candidate) => ({ ...candidate, sourceKind: 'government' }));
  }, [contextSearchMutation.data]);

  const session = sessionQuery.data ?? bootstrap.data ?? null;
  const stage = deriveOutreachV3Stage(session);
  const reasoningUnavailable = Boolean(conversationQuery.isError || turnsQuery.isError);
  const reasoningError = conversationQuery.error ?? turnsQuery.error ?? reasoningMutation.error;
  const primaryError =
    bootstrap.error ??
    sessionQuery.error ??
    commandsMutation.error ??
    applyProposalMutation.error ??
    rejectProposalMutation.error ??
    null;

  return {
    sessionId,
    session,
    stage,
    isBootstrapping: bootstrap.isLoading || (Boolean(sessionId) && sessionQuery.isLoading),
    isRefreshing: sessionQuery.isFetching,
    error: primaryError,
    errorMessage: primaryError ? safeOutreachV3Error(primaryError) : null,
    lifecycleErrorMessage: lifecycleError,
    startingNewSession,
    refreshCanonical,
    applyCommands: commandsMutation.mutateAsync,
    applyingCommands: commandsMutation.isPending,
    conversationId,
    reasoningUnavailable,
    reasoningErrorMessage: reasoningError ? safeOutreachV3Error(reasoningError) : null,
    retryReasoning,
    turns: [...serverTurns, ...transientTurns],
    sendTurn: reasoningMutation.mutateAsync,
    sendingTurn: reasoningMutation.isPending,
    pendingProposals,
    applyProposal: applyProposalMutation.mutateAsync,
    rejectProposal: rejectProposalMutation.mutateAsync,
    proposalBusy: applyProposalMutation.isPending || rejectProposalMutation.isPending,
    searchTargets: targetSearchMutation.mutateAsync,
    targetSearchResult: targetSearchMutation.data as
      | CapabilityResult<OutreachV3TargetSearchData>
      | undefined,
    targetCandidates: (targetSearchMutation.data?.data.candidates ?? []) as OutreachV3TargetCandidate[],
    targetSearchPending: targetSearchMutation.isPending,
    targetSearchError: targetSearchMutation.error
      ? safeOutreachV3Error(targetSearchMutation.error)
      : null,
    getTargetProfile: targetProfileMutation.mutateAsync,
    targetProfile: targetProfileMutation.data as OutreachV3TargetProfileResponse | undefined,
    targetProfilePending: targetProfileMutation.isPending,
    coverage: coverageQuery.data as OutreachV3TargetCoverageResponse | undefined,
    coveragePending: coverageQuery.isFetching,
    searchContext: contextSearchMutation.mutateAsync,
    contextCandidates,
    contextSearchPending: contextSearchMutation.isPending,
    contextSearchError: contextSearchMutation.error
      ? safeOutreachV3Error(contextSearchMutation.error)
      : null,
    contextReview: contextReviewQuery.data as OutreachV3ContextReviewResponse | undefined,
    contextReviewPending: contextReviewQuery.isFetching,
    contextReviewError: contextReviewQuery.error
      ? safeOutreachV3Error(contextReviewQuery.error)
      : null,
    strategy: strategyQuery.data as CapabilityResult<OutreachV3StrategyData> | undefined,
    strategyPending: strategyQuery.isFetching,
    strategyError: strategyQuery.error ? safeOutreachV3Error(strategyQuery.error) : null,
    startNewSession,
  };
}