import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type {
  CapabilityResult,
  OutreachV3Command,
  OutreachV3ContextReviewResponse,
  OutreachV3Proposal,
  OutreachV3SessionEnvelope,
  OutreachV3Stage,
  OutreachV3StrategyData,
  OutreachV3TargetCandidate,
  OutreachV3TargetCoverageResponse,
  OutreachV3TargetLocator,
  OutreachV3TargetProfileResponse,
  OutreachV3TargetSearchData,
  OutreachV3TranscriptTurn,
} from './contracts.js';
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
  searchOutreachV3Targets,
  sendOutreachV3Turn,
} from './outreach-v3-api.js';

const ACTIVE_SESSION_KEY = 'capiro.outreach-v3.active-session';
const conversationKey = (sessionId: string) => `capiro.outreach-v3.conversation.${sessionId}`;

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

export function deriveOutreachV3Stage(session: OutreachV3SessionEnvelope | null): OutreachV3Stage {
  if (!session) return 'goal';
  const { spec } = session;
  if (
    !spec.goal.goal ||
    !spec.goal.topic ||
    !spec.goal.desiredOutcome ||
    spec.goal.ask.mode === 'undecided'
  ) {
    return 'goal';
  }
  if (spec.sponsor.kind === 'undecided') return 'sponsor';
  if (spec.targeting.selectedTargetRefs.length === 0) return 'targets';
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

export interface UseOutreachV3SessionOptions {
  title?: string;
}

export function useOutreachV3Session(options: UseOutreachV3SessionOptions = {}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(() =>
    readSessionStorage(ACTIVE_SESSION_KEY),
  );
  const [transientTurns, setTransientTurns] = useState<OutreachV3TranscriptTurn[]>([]);

  const bootstrap = useQuery({
    queryKey: ['outreach-v3', 'bootstrap', options.title ?? 'new'],
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
    setSessionId(null);
  }, [sessionId, sessionQuery.error, sessionQuery.isError]);

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

  const commandsMutation = useMutation({
    mutationFn: async (commands: OutreachV3Command[]) => {
      const current = sessionQuery.data;
      if (!sessionId || !current) throw new Error('The Outreach session is not ready.');
      return applyOutreachV3Commands(api, sessionId, current.currentStateVersion, commands);
    },
    onSuccess: refreshCanonical,
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
        ...current,
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

  const startNewSession = useCallback(async () => {
    const priorId = sessionId;
    if (priorId) await archiveOutreachV3Session(api, priorId).catch(() => undefined);
    writeSessionStorage(ACTIVE_SESSION_KEY, null);
    if (priorId) writeSessionStorage(conversationKey(priorId), null);
    setTransientTurns([]);
    setSessionId(null);
    queryClient.removeQueries({ queryKey: ['outreach-v3'] });
  }, [api, queryClient, sessionId]);

  const serverTurns = useMemo(
    () => normalizeTurns((turnsQuery.data ?? []) as unknown[]),
    [turnsQuery.data],
  );

  const pendingProposals = useMemo(
    () => (proposalsQuery.data ?? []).filter((proposal) => proposal.status === 'pending'),
    [proposalsQuery.data],
  );

  const session = sessionQuery.data ?? bootstrap.data ?? null;
  const stage = deriveOutreachV3Stage(session);
  const reasoningUnavailable = Boolean(conversationQuery.isError);
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
    refreshCanonical,
    applyCommands: commandsMutation.mutateAsync,
    applyingCommands: commandsMutation.isPending,
    conversationId,
    reasoningUnavailable,
    reasoningErrorMessage: conversationQuery.error
      ? safeOutreachV3Error(conversationQuery.error)
      : reasoningMutation.error
        ? safeOutreachV3Error(reasoningMutation.error)
        : null,
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
