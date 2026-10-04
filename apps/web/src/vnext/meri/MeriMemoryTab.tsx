import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  memoryCandidateTargetLabel,
  memoryQueueErrorMessage,
  memoryReviewCandidateTitle,
  ownedMemoryCandidateStatusLabel,
  ownedMemoryCandidateTitle,
  type OwnedMemoryCandidate,
  type OwnedProposalQueueResponse,
  type ReviewableMemoryCandidate,
  type ReviewQueueResponse,
} from '../../components/memory-queue-shared.js';
import { useApi } from '../../lib/use-api.js';
import { useApiScope } from '../../lib/use-api-scope.js';
import { httpErrorStatus } from '../../lib/query-retry.js';
import type {
  MemoryReviewDetail,
  MemoryReviewInboxPage,
} from '../../components/memory-review-inbox-shared.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon } from './meri-icons.js';
import { MeriPanelState } from './MeriPanelState.js';
import type { MeriContextPacket, MeriContextPacketItem } from './meri-vnext-api.js';
import {
  clearMemoryDecisionRecovery,
  readMemoryDecisionRecoveries,
  writeMemoryDecisionRecovery,
} from './memory-decision-recovery.js';

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

export function useMeriGovernedMemoryQueues() {
  const api = useApi();
  const apiScope = useApiScope();
  const review = useQuery<ReviewQueueResponse>({
    queryKey: ['memory-review-candidates', apiScope],
    queryFn: async () =>
      (await api.get<ReviewQueueResponse>('/api/memory/review/candidates')).data,
    staleTime: 15_000,
    retry: 1,
  });
  const proposals = useInfiniteQuery<OwnedProposalQueueResponse>({
    queryKey: ['memory-own-proposals', apiScope],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<OwnedProposalQueueResponse>('/api/memory/proposals', {
          params: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
        })
      ).data,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 15_000,
    retry: 1,
  });

  return {
    review,
    proposals,
    reviewCount: review.data?.enabled ? review.data.candidates.length : 0,
    pendingProposalCount: proposals.data?.pages[0]?.enabled
      ? proposals.data.pages
          .flatMap((page) => page.candidates)
          .filter((candidate) => candidate.status === 'pending').length
      : 0,
  };
}

function isGovernedMemoryItem(item: MeriContextPacketItem): boolean {
  return /(memory|preference|steering|firm[-_ ]identity|firm[-_ ]playbook|user[-_ ]voice)/i.test(
    item.type,
  );
}

function scopeLabel(scope: string): string {
  if (scope === 'client') return 'CLIENT MEMORY';
  if (scope === 'personal' || scope === 'user_private') return 'PERSONAL MEMORY';
  if (scope === 'firm') return 'FIRM MEMORY';
  return 'MEMORY SCOPE UNAVAILABLE';
}

function kindLabel(kind: string): string {
  if (kind === 'standard') return 'NEW MEMORY';
  if (kind === 'correction') return 'CORRECTION';
  if (kind === 'restore') return 'RESTORE';
  if (kind === 'contradiction') return 'CONTRADICTION';
  if (kind === 'learning_signal_conflict') return 'SOURCE CONFLICT';
  return kind.replace(/_/g, ' ').toUpperCase();
}

type ReviewDecision = 'approve' | 'reject' | 'request-changes' | 'resolve-conflict';
type ConflictResolution =
  | 'duplicate'
  | 'corroborate_existing'
  | 'supersede_existing'
  | 'conflict_requires_review';

interface ReviewDecisionInput {
  id: string;
  reviewRequestId: string;
  decision: ReviewDecision;
  reason?: string;
  resolution?: ConflictResolution;
}

interface DecisionNotice {
  input: ReviewDecisionInput;
  tone: 'error' | 'warning' | 'success';
  title: string;
  message: string;
  ambiguous: boolean;
  detail?: MemoryReviewDetail;
}

function decisionObserved(detail: MemoryReviewDetail, input: ReviewDecisionInput): boolean {
  if (detail.candidateId !== input.id || detail.reviewRequestId !== input.reviewRequestId) {
    return false;
  }
  if (input.decision === 'approve' || input.decision === 'resolve-conflict') {
    return detail.status === 'approved';
  }
  if (input.decision === 'reject') return detail.status === 'rejected';
  return detail.status === 'changes_requested';
}

function acceptedResultMatches(
  input: ReviewDecisionInput,
  result: Record<string, unknown> | undefined,
): boolean {
  if (!result || result.candidateId !== input.id) return false;
  if (input.decision === 'request-changes') {
    const workflow = result.workflow;
    return Boolean(
      workflow &&
        typeof workflow === 'object' &&
        (workflow as Record<string, unknown>).requestId === input.reviewRequestId &&
        (workflow as Record<string, unknown>).status === 'changes_requested',
    );
  }
  if (input.decision === 'resolve-conflict') {
    if (!input.resolution) return false;
    const expectedOutcome: Record<ConflictResolution, string> = {
      duplicate: 'duplicate',
      corroborate_existing: 'corroborated',
      supersede_existing: 'activated',
      conflict_requires_review: 'conflict',
    };
    return (
      result.decision === input.resolution &&
      result.outcome === expectedOutcome[input.resolution] &&
      typeof result.controllingItemId === 'string'
    );
  }
  if (input.decision === 'reject') return result.outcome === 'rejected';
  return ['activated', 'duplicate', 'conflict'].includes(String(result.outcome));
}

function sourceLabel(sourceKind: string): string {
  return sourceKind.replace(/_/g, ' ');
}

function recordedSourceLabel(sourceType: string): string {
  if (sourceType === 'meri_synthetic_fixture') return 'Synthetic fixture';
  if (sourceType === 'chat') return 'Conversation';
  return sourceLabel(sourceType);
}

function reviewBody(candidate: ReviewableMemoryCandidate): Array<{ heading: string; body: string }> {
  const canonical = candidate.proposal.canonicalItem;
  if (canonical?.sections.length) {
    return canonical.sections.map((section) => ({
      heading: section.heading,
      body: section.body || '—',
    }));
  }
  return candidate.proposal.value
    ? [{ heading: 'Proposed value', body: candidate.proposal.value }]
    : [];
}

function proposalBody(candidate: OwnedMemoryCandidate): Array<{ heading: string; body: string }> {
  const canonical = candidate.proposal?.canonicalItem;
  if (canonical?.sections.length) {
    return canonical.sections.map((section) => ({
      heading: section.heading,
      body: section.body || '—',
    }));
  }
  return candidate.proposal?.value
    ? [{ heading: 'Proposed value', body: candidate.proposal.value }]
    : [];
}

function QueueCard({
  eyebrow,
  title,
  target,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  target?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article
      style={{
        padding: '13px 14px',
        border: '1px solid #EAECF0',
        borderRadius: 10,
        background: '#FFFFFF',
        boxShadow: '0 1px 2px rgba(16,24,40,.03)',
      }}
    >
      <div
        style={{
          marginBottom: 5,
          fontFamily: MONO,
          fontSize: 9,
          letterSpacing: '.08em',
          color: '#7F8A9A',
        }}
      >
        {eyebrow}
      </div>
      <div style={{ color: '#182230', fontSize: 13, fontWeight: 650, lineHeight: 1.35 }}>{title}</div>
      {target ? (
        <p style={{ margin: '6px 0 0', color: '#344054', fontSize: 12, fontWeight: 600 }}>
          Target: {target}
        </p>
      ) : null}
      {children}
      {actions ? <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>{actions}</div> : null}
    </article>
  );
}

function QueueButton({
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'primary' | 'danger';
}) {
  const palette =
    tone === 'primary'
      ? { background: '#111827', borderColor: '#111827', color: '#FFFFFF' }
      : tone === 'danger'
        ? { background: '#FFFFFF', borderColor: '#F2B8B5', color: '#B42318' }
        : { background: '#FFFFFF', borderColor: '#D7DCE3', color: '#344054' };
  return (
    <button
      type="button"
      className="vnext-meri__rail-action-btn"
      onClick={onClick}
      disabled={disabled}
      style={{ flex: 1, justifyContent: 'center', ...palette }}
    >
      {children}
    </button>
  );
}

/**
 * Governed Institutional Memory inside Meri.
 *
 * This deliberately does not read or mutate the legacy Meri memory adapter. Active recall
 * comes from the server-compiled Context Packet. Proposals and review decisions
 * use the same canonical queues as the Governance Center.
 */
export function MeriMemoryTab({ packet }: { packet: MeriContextPacket | null }) {
  const api = useApi();
  const apiScope = useApiScope();
  const apiScopeRef = useRef(apiScope);
  apiScopeRef.current = apiScope;
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { review, proposals } = useMeriGovernedMemoryQueues();
  const history = useInfiniteQuery<MemoryReviewInboxPage>({
    queryKey: ['memory-review-inbox', apiScope, 'history', 'meri'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<MemoryReviewInboxPage>('/api/memory/review/inbox', {
          params: { view: 'history', limit: 25, ...(pageParam ? { cursor: pageParam } : {}) },
        })
      ).data,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 10_000,
    retry: 1,
  });
  const submitted = useInfiniteQuery<MemoryReviewInboxPage>({
    queryKey: ['memory-review-inbox', apiScope, 'submitted_by_me', 'meri'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<MemoryReviewInboxPage>('/api/memory/review/inbox', {
          params: {
            view: 'submitted_by_me',
            limit: 25,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        })
      ).data,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 10_000,
    retry: 1,
  });
  const [rejecting, setRejecting] = useState<ReviewableMemoryCandidate | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [requestingChanges, setRequestingChanges] = useState<ReviewableMemoryCandidate | null>(null);
  const [changeReason, setChangeReason] = useState('');
  const [resolvingConflict, setResolvingConflict] = useState<ReviewableMemoryCandidate | null>(null);
  const [conflictResolution, setConflictResolution] =
    useState<ConflictResolution>('conflict_requires_review');
  const [decisionNotices, setDecisionNotices] = useState<DecisionNotice[]>([]);
  const [revising, setRevising] = useState<MemoryReviewDetail | null>(null);
  const [revisionSections, setRevisionSections] = useState<
    NonNullable<MemoryReviewDetail['proposal']['canonicalItem']>['sections']
  >([]);
  const [revisionValue, setRevisionValue] = useState('');

  const activeMemory = (packet?.items ?? []).filter(isGovernedMemoryItem);
  const reviewCandidates = review.data?.enabled ? review.data.candidates : [];
  const ownedProposals = proposals.data?.pages[0]?.enabled
    ? proposals.data.pages.flatMap((page) => page.candidates)
    : [];
  const historyItems = history.data?.pages.flatMap((page) => page.items) ?? [];
  const correctionItems =
    submitted.data?.pages
      .flatMap((page) => page.items)
      .filter((item) => item.status === 'changes_requested') ?? [];

  const invalidateMemory = () => {
    for (const key of [
      'memory-review-candidates',
      'memory-own-proposals',
      'memory-review-inbox',
      'memory-review-summary',
      'memory-governance-overview',
      'memory-governance-items',
      'memory-governance-transitions',
      'memory-item',
    ]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const setDecisionNotice = (notice: DecisionNotice) => {
    setDecisionNotices((current) => [
      ...current.filter((entry) => entry.input.id !== notice.input.id),
      notice,
    ]);
  };

  const reconcileDecision = async (
    input: ReviewDecisionInput,
    options: {
      error?: unknown;
      acceptedResult?: Record<string, unknown>;
    } = {},
  ) => {
    const reconciliationScope = apiScope;
    let detail: MemoryReviewDetail | undefined;
    try {
      const observed = (
        await api.get<MemoryReviewDetail>(`/api/memory/review/inbox/candidates/${input.id}`)
      ).data;
      if (observed && typeof observed.status === 'string') detail = observed;
    } catch {
      // A failed status read never licenses replaying the write.
    }

    if (apiScopeRef.current !== reconciliationScope) return;

    const status = httpErrorStatus(options.error);
    const definitiveFailure = status === 403 || status === 409;
    const readbackMatches = detail
      ? detail.candidateId === input.id && detail.reviewRequestId === input.reviewRequestId
      : false;
    const resultMatches = acceptedResultMatches(input, options.acceptedResult);

    if (!definitiveFailure && resultMatches && detail && decisionObserved(detail, input)) {
      clearMemoryDecisionRecovery(apiScope, input);
      const conflictLeftOpen =
        input.decision === 'resolve-conflict' &&
        input.resolution === 'conflict_requires_review' &&
        options.acceptedResult?.outcome === 'conflict';
      setDecisionNotice({
        input,
        tone: conflictLeftOpen ? 'warning' : 'success',
        title: conflictLeftOpen ? 'Conflict remains open' : 'Decision confirmed',
        message: conflictLeftOpen
          ? `The review is recorded as approved, but the conflict is unresolved. Current controlling item: ${String(options.acceptedResult?.controllingItemId)}.`
          : 'The accepted response and matching canonical review record confirm this decision.',
        ambiguous: false,
        detail,
      });
      if (!conflictLeftOpen) {
        toast.success(
          input.decision === 'approve'
            ? 'Memory approval confirmed'
          : input.decision === 'reject'
            ? 'Memory rejection confirmed'
            : input.decision === 'request-changes'
              ? 'Change request confirmed'
              : 'Memory conflict decision confirmed',
        );
      }
      invalidateMemory();
      return;
    }

    const failure = options.error
      ? memoryQueueErrorMessage(options.error)
      : options.acceptedResult
        ? resultMatches
          ? 'The decision response was accepted but its status could not be confirmed.'
          : 'The accepted response did not match the requested decision.'
        : 'No fresh acknowledged decision response is available.';
    const currentState = readbackMatches
      ? ` Current recorded status: ${detail!.status.replace(/_/g, ' ')}${detail!.decidedBy ? ` by ${detail!.decidedBy!.name}` : ''}.`
      : ' The requested candidate and review request were not both confirmed by the readback.';
    const ambiguous = !definitiveFailure;
    if (ambiguous) {
      writeMemoryDecisionRecovery(apiScope, { input });
    } else {
      clearMemoryDecisionRecovery(apiScope, input);
    }
    setDecisionNotice({
      input,
      tone: definitiveFailure ? 'error' : 'warning',
      title:
        status === 403
          ? 'Review permission denied'
          : status === 409
            ? 'Review changed before this decision'
            : 'Decision status unconfirmed',
      message: definitiveFailure
        ? `${failure}${currentState} This response is not attributed to your attempted write.`
        : `${failure}${currentState} Status checks never resend the decision, and a terminal read alone is not attributed to your write.`,
      ambiguous,
      ...(readbackMatches && detail ? { detail } : {}),
    });
    invalidateMemory();
  };

  const decision = useMutation({
    mutationFn: async (input: ReviewDecisionInput) =>
      (
        await api.post('/api/memory/review/candidates/' + input.id + '/' + input.decision, {
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.resolution ? { decision: input.resolution } : {}),
        })
      ).data as Record<string, unknown>,
    onSuccess: async (result, input) => {
      setRejecting(null);
      setRejectReason('');
      setRequestingChanges(null);
      setChangeReason('');
      setResolvingConflict(null);
      await reconcileDecision(input, {
        acceptedResult: result,
      });
    },
    onError: async (error: unknown, input) => {
      toast.error(memoryQueueErrorMessage(error));
      await reconcileDecision(input, { error });
    },
  });

  useEffect(() => {
    const recoveries = readMemoryDecisionRecoveries(apiScope);
    setDecisionNotices(
      recoveries.map((recovery) => ({
        input: recovery.input,
        tone: 'warning',
        title: 'Decision status unconfirmed',
        message:
          'A prior write had an ambiguous outcome. Checking canonical status without resending it.',
        ambiguous: true,
      })),
    );
    for (const recovery of recoveries) void reconcileDecision(recovery.input);
    // apiScope is the tenant + impersonation + actor boundary for this recovery read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiScope]);

  const withdraw = useMutation({
    mutationFn: async (id: string) =>
      (await api.post('/api/memory/proposals/' + id + '/withdraw', {})).data,
    onSuccess: () => {
      toast.success('Proposal withdrawn');
      invalidateMemory();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Withdrawal failed'),
  });

  const loadRevision = useMutation({
    mutationFn: async (item: MemoryReviewInboxPage['items'][number]) => {
      const detail = (
        await api.get<MemoryReviewDetail>(
          `/api/memory/review/inbox/requests/${item.reviewRequestId}`,
        )
      ).data;
      if (
        detail.candidateId !== item.candidateId ||
        detail.reviewRequestId !== item.reviewRequestId ||
        detail.status !== 'changes_requested' ||
        !detail.capabilities.revise
      ) {
        throw new Error('This review is not currently authorized for revision.');
      }
      return detail;
    },
    onSuccess: (detail) => {
      setRevising(detail);
      setRevisionSections(
        detail.proposal.canonicalItem?.sections.map((section) => ({ ...section })) ?? [],
      );
      setRevisionValue(detail.proposal.value ?? '');
    },
    onError: (error: unknown) => toast.error(memoryQueueErrorMessage(error)),
  });

  const submitRevision = useMutation({
    mutationFn: async (detail: MemoryReviewDetail) =>
      (
        await api.post(
          `/api/memory/review/candidates/${detail.candidateId}/revise`,
          revisionSections.length > 0 ? { sections: revisionSections } : { value: revisionValue },
        )
      ).data as Record<string, unknown>,
    onSuccess: (result, detail) => {
      if (
        result.predecessorCandidateId !== detail.candidateId ||
        typeof result.candidateId !== 'string'
      ) {
        toast.error('The revision response did not identify the requested proposal.');
        return;
      }
      setRevising(null);
      toast.success('Memory revision submitted for review');
      invalidateMemory();
    },
    onError: (error: unknown) => toast.error(memoryQueueErrorMessage(error)),
  });

  const rejectCandidate = (candidate: ReviewableMemoryCandidate) => {
    // The canonical review API requires a reason for every rejection kind.
    setRejectReason('');
    setRejecting(candidate);
  };

  return (
    <div className="vnext-meri__rail-section-content" style={{ display: 'grid', gap: 18 }}>
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 6,
            color: '#101828',
            fontSize: 14,
            fontWeight: 650,
          }}
        >
          <MeriIcon name="ShieldTick" size={16} color="#344054" />
          Institutional memory
        </div>
        <p style={{ margin: 0, color: '#667085', fontSize: 12, lineHeight: 1.55 }}>
          Governed memory only. Active recall is admitted by the Context Packet; shared changes stay
          pending until an authorized reviewer decides them.
        </p>
      </div>

      <section>
        <div className="vnext-meri__section-label" style={{ marginBottom: 8 }}>
          ACTIVE IN THIS CONTEXT · {activeMemory.length}
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {activeMemory.map((item) => (
            <QueueCard
              key={item.id}
              eyebrow={scopeLabel(item.scope) + ' · ' + item.selection.toUpperCase()}
              title={item.label}
            >
              <p style={{ margin: '7px 0 0', color: '#667085', fontSize: 11.5, lineHeight: 1.48 }}>
                {item.rationale || 'Admitted by the current governed context packet.'}
              </p>
              <div style={{ marginTop: 7, color: '#98A2B3', fontFamily: MONO, fontSize: 9 }}>
                {item.authority.toUpperCase()}
                {item.status ? ' · ' + item.status.replace(/_/g, ' ').toUpperCase() : ''}
              </div>
            </QueueCard>
          ))}
          {activeMemory.length === 0 ? (
            <MeriPanelState tone="empty">
              No governed memory was included in the current context packet.
            </MeriPanelState>
          ) : null}
        </div>
      </section>

      <section>
        <div className="vnext-meri__section-label" style={{ marginBottom: 8 }}>
          NEEDS YOUR REVIEW · {reviewCandidates.length}
        </div>
        <p style={{ margin: '0 0 10px', color: '#667085', fontSize: 12, lineHeight: 1.55 }}>
          Across your firm: proposals you are authorized to review. The client picker does not
          filter this queue or change a proposal's target.
        </p>
        {review.isLoading ? <MeriPanelState tone="loading">Loading review queue…</MeriPanelState> : null}
        {review.isError ? (
          <MeriPanelState tone="error">The institutional review queue could not be loaded.</MeriPanelState>
        ) : null}
        {!review.isLoading && !review.isError && reviewCandidates.length === 0 ? (
          <MeriPanelState tone="empty">Nothing is waiting for your review.</MeriPanelState>
        ) : null}
        {decisionNotices.map((decisionNotice) => (
          <MeriPanelState
            key={`${decisionNotice.input.id}:${decisionNotice.input.decision}:${decisionNotice.input.resolution ?? 'none'}`}
            tone={decisionNotice.tone === 'error' ? 'error' : 'loading'}
          >
            <strong>{decisionNotice.title}</strong>
            <div>{decisionNotice.message}</div>
            {decisionNotice.detail ? (
              <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 10 }}>
                {decisionNotice.tone === 'success' ? 'RECEIPT' : 'RECORDED STATE'}{' '}
                {decisionNotice.detail.candidateId} ·{' '}
                {decisionNotice.detail.status.toUpperCase()}
                {decisionNotice.detail.decidedAt ? ` · ${decisionNotice.detail.decidedAt}` : ''}
              </div>
            ) : null}
            {decisionNotice.ambiguous ? (
              <button
                type="button"
                className="vnext-meri__rail-action-btn"
                style={{ marginTop: 8 }}
                onClick={() => {
                  void reconcileDecision(decisionNotice.input);
                }}
              >
                Check current status
              </button>
            ) : null}
          </MeriPanelState>
        ))}
        <div style={{ display: 'grid', gap: 8 }}>
          {reviewCandidates.map((candidate) => (
            <QueueCard
              key={candidate.id}
              eyebrow={scopeLabel(candidate.scope) + ' · ' + kindLabel(candidate.candidateKind)}
              title={memoryReviewCandidateTitle(candidate)}
              target={memoryCandidateTargetLabel(candidate)}
              actions={
                <>
                  {candidate.capabilities.approve ? (
                    <QueueButton
                      tone="primary"
                      disabled={
                        decision.isPending ||
                        decisionNotices.some(
                          (notice) => notice.input.id === candidate.id && notice.ambiguous,
                        )
                      }
                      onClick={() =>
                        decision.mutate({
                          id: candidate.id,
                          reviewRequestId: candidate.workflow?.requestId ?? candidate.id,
                          decision: 'approve',
                        })
                      }
                    >
                      Approve
                    </QueueButton>
                  ) : null}
                  {candidate.capabilities.reject ? (
                    <QueueButton
                      tone="danger"
                      disabled={
                        decision.isPending ||
                        decisionNotices.some(
                          (notice) => notice.input.id === candidate.id && notice.ambiguous,
                        )
                      }
                      onClick={() => rejectCandidate(candidate)}
                    >
                      Reject
                    </QueueButton>
                  ) : null}
                  {candidate.capabilities.requestChanges ? (
                    <QueueButton
                      disabled={
                        decision.isPending ||
                        decisionNotices.some(
                          (notice) => notice.input.id === candidate.id && notice.ambiguous,
                        )
                      }
                      onClick={() => {
                        setChangeReason('');
                        setRequestingChanges(candidate);
                      }}
                    >
                      Request changes
                    </QueueButton>
                  ) : null}
                  {candidate.capabilities.resolveConflict ? (
                    <QueueButton
                      disabled={
                        decision.isPending ||
                        decisionNotices.some(
                          (notice) => notice.input.id === candidate.id && notice.ambiguous,
                        )
                      }
                      onClick={() => {
                        setConflictResolution('conflict_requires_review');
                        setResolvingConflict(candidate);
                      }}
                    >
                      Resolve conflict
                    </QueueButton>
                  ) : null}
                </>
              }
            >
              {reviewBody(candidate).map((section) => (
                <div key={section.heading} style={{ marginTop: 8 }}>
                  <div style={{ color: '#475467', fontSize: 10.5, fontWeight: 650 }}>{section.heading}</div>
                  <p style={{ margin: '3px 0 0', color: '#667085', fontSize: 11.5, lineHeight: 1.48, whiteSpace: 'pre-wrap' }}>
                    {section.body}
                  </p>
                </div>
              ))}
              <div style={{ marginTop: 8, color: '#667085', fontSize: 10.5, lineHeight: 1.5 }}>
                <div>Source: {sourceLabel(candidate.sourceKind)}</div>
                <div>Proposed by: {candidate.workflow?.submittedBy.name ?? candidate.proposedByUserId}</div>
                <div>Review reference: {candidate.workflow?.requestId ?? candidate.id}</div>
                <div>Current reviewer: {candidate.workflow?.assignedReviewer?.name ?? 'Not assigned'}</div>
                {candidate.conflict ? (
                  <div>
                    Conflict: {candidate.conflict.conflictStatus} against memory{' '}
                    {candidate.conflict.contradictsMemoryItemId}
                  </div>
                ) : candidate.candidateKind === 'contradiction' ? (
                  <div>Conflict: proposed contradiction requires governed review</div>
                ) : null}
              </div>
              {rejecting?.id === candidate.id ? (
                <div style={{ marginTop: 10 }}>
                  <textarea
                    value={rejectReason}
                    onChange={(event) => setRejectReason(event.target.value)}
                    aria-label="Rejection reason"
                    placeholder="Reason for rejecting this governed change"
                    maxLength={500}
                    rows={3}
                    style={{
                      width: '100%',
                      resize: 'vertical',
                      border: '1px solid #D7DCE3',
                      borderRadius: 8,
                      padding: 9,
                      color: '#344054',
                      font: 'inherit',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <QueueButton
                      onClick={() => {
                        setRejecting(null);
                        setRejectReason('');
                      }}
                    >
                      Cancel
                    </QueueButton>
                    <QueueButton
                      tone="danger"
                      disabled={!rejectReason.trim() || decision.isPending}
                      onClick={() =>
                        decision.mutate({
                          id: candidate.id,
                          reviewRequestId: candidate.workflow?.requestId ?? candidate.id,
                          decision: 'reject',
                          reason: rejectReason.trim(),
                        })
                      }
                    >
                      Reject proposal
                    </QueueButton>
                  </div>
                </div>
              ) : null}
              {requestingChanges?.id === candidate.id ? (
                <div style={{ marginTop: 10 }}>
                  <textarea
                    value={changeReason}
                    onChange={(event) => setChangeReason(event.target.value)}
                    aria-label="Requested changes"
                    placeholder="Explain the correction or evidence needed for second review"
                    maxLength={500}
                    rows={3}
                    style={{
                      width: '100%',
                      resize: 'vertical',
                      border: '1px solid #D7DCE3',
                      borderRadius: 8,
                      padding: 9,
                      color: '#344054',
                      font: 'inherit',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <QueueButton onClick={() => setRequestingChanges(null)}>Cancel</QueueButton>
                    <QueueButton
                      tone="primary"
                      disabled={!changeReason.trim() || decision.isPending}
                      onClick={() =>
                        decision.mutate({
                          id: candidate.id,
                          reviewRequestId: candidate.workflow?.requestId ?? candidate.id,
                          decision: 'request-changes',
                          reason: changeReason.trim(),
                        })
                      }
                    >
                      Send for correction
                    </QueueButton>
                  </div>
                </div>
              ) : null}
              {resolvingConflict?.id === candidate.id ? (
                <div style={{ marginTop: 10 }}>
                  <label style={{ display: 'grid', gap: 5, color: '#475467', fontSize: 11 }}>
                    Governed conflict decision
                    <select
                      aria-label="Governed conflict decision"
                      value={conflictResolution}
                      onChange={(event) =>
                        setConflictResolution(event.target.value as ConflictResolution)
                      }
                      style={{ border: '1px solid #D7DCE3', borderRadius: 8, padding: 8 }}
                    >
                      <option value="duplicate">Duplicate current memory</option>
                      <option value="corroborate_existing">Corroborates current memory</option>
                      <option value="supersede_existing">Supersede current memory</option>
                      <option value="conflict_requires_review">Keep conflict open for review</option>
                    </select>
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <QueueButton onClick={() => setResolvingConflict(null)}>Cancel</QueueButton>
                    <QueueButton
                      tone="primary"
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({
                          id: candidate.id,
                          reviewRequestId: candidate.workflow?.requestId ?? candidate.id,
                          decision: 'resolve-conflict',
                          resolution: conflictResolution,
                        })
                      }
                    >
                      Confirm conflict decision
                    </QueueButton>
                  </div>
                </div>
              ) : null}
            </QueueCard>
          ))}
        </div>
      </section>

      <section>
        <div className="vnext-meri__section-label" style={{ marginBottom: 8 }}>
          NEEDS YOUR CORRECTION · {correctionItems.length}
        </div>
        <p style={{ margin: '0 0 10px', color: '#667085', fontSize: 12, lineHeight: 1.55 }}>
          Reviewer-requested changes use the canonical immutable revise-and-resubmit workflow.
        </p>
        {submitted.isLoading ? (
          <MeriPanelState tone="loading">Loading requested corrections…</MeriPanelState>
        ) : null}
        {submitted.isError ? (
          <MeriPanelState tone="error">Requested corrections could not be loaded.</MeriPanelState>
        ) : null}
        <div style={{ display: 'grid', gap: 8 }}>
          {correctionItems.map((item) => (
            <QueueCard
              key={item.reviewRequestId}
              eyebrow={`${scopeLabel(item.scope)} · CHANGES REQUESTED`}
              title={item.title}
              target={item.client?.name ?? (item.scope === 'firm' ? 'Firm memory' : 'Client unavailable')}
              actions={
                item.capabilities.revise && revising?.reviewRequestId !== item.reviewRequestId ? (
                  <QueueButton
                    tone="primary"
                    disabled={loadRevision.isPending}
                    onClick={() => loadRevision.mutate(item)}
                  >
                    Revise and resubmit
                  </QueueButton>
                ) : undefined
              }
            >
              <div style={{ marginTop: 8, color: '#667085', fontSize: 10.5, lineHeight: 1.5 }}>
                <div>Review reference: {item.reviewRequestId}</div>
                <div>Revision: {item.revisionNumber}</div>
                <div>Next action: Revise and resubmit</div>
              </div>
              {revising?.reviewRequestId === item.reviewRequestId ? (
                <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                  {revising.feedbackReason ? (
                    <MeriPanelState tone="loading">
                      Reviewer requested: {revising.feedbackReason}
                    </MeriPanelState>
                  ) : null}
                  {revisionSections.length > 0 ? (
                    revisionSections.map((section, index) => (
                      <label key={section.key} style={{ display: 'grid', gap: 4, fontSize: 11 }}>
                        {section.heading}
                        <textarea
                          aria-label={`Revision ${section.heading}`}
                          rows={4}
                          maxLength={50_000}
                          value={section.body}
                          onChange={(event) =>
                            setRevisionSections((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex === index ? { ...entry, body: event.target.value } : entry,
                              ),
                            )
                          }
                        />
                      </label>
                    ))
                  ) : (
                    <textarea
                      aria-label="Revised proposal"
                      rows={6}
                      maxLength={200_000}
                      value={revisionValue}
                      onChange={(event) => setRevisionValue(event.target.value)}
                    />
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <QueueButton onClick={() => setRevising(null)}>Cancel</QueueButton>
                    <QueueButton
                      tone="primary"
                      disabled={
                        submitRevision.isPending ||
                        (revisionSections.length > 0
                          ? revisionSections.every((section) => !section.body.trim())
                          : !revisionValue.trim())
                      }
                      onClick={() => submitRevision.mutate(revising)}
                    >
                      Submit revision
                    </QueueButton>
                  </div>
                </div>
              ) : null}
            </QueueCard>
          ))}
          {submitted.hasNextPage ? (
            <QueueButton
              disabled={submitted.isFetchingNextPage}
              onClick={() => void submitted.fetchNextPage()}
            >
              Load more requested corrections
            </QueueButton>
          ) : null}
        </div>
      </section>

      <section>
        <div className="vnext-meri__section-label" style={{ marginBottom: 8 }}>
          YOUR PROPOSALS · {ownedProposals.length}
        </div>
        <p style={{ margin: '0 0 10px', color: '#667085', fontSize: 12, lineHeight: 1.55 }}>
          Your proposals across clients, firm memory, and personal memory, independent of the client picker.
        </p>
        {proposals.isLoading ? <MeriPanelState tone="loading">Loading your proposals…</MeriPanelState> : null}
        {proposals.isError ? (
          <MeriPanelState tone="error">Your proposal history could not be loaded.</MeriPanelState>
        ) : null}
        {!proposals.isLoading && !proposals.isError && ownedProposals.length === 0 ? (
          <MeriPanelState tone="empty">You have not proposed an institutional memory change.</MeriPanelState>
        ) : null}
        <div style={{ display: 'grid', gap: 8 }}>
          {ownedProposals.map((candidate) => (
            <QueueCard
              key={candidate.id}
              eyebrow={scopeLabel(candidate.scope) + ' · ' + ownedMemoryCandidateStatusLabel(candidate.status).toUpperCase()}
              title={ownedMemoryCandidateTitle(candidate)}
              target={memoryCandidateTargetLabel(candidate)}
              actions={
                candidate.capabilities.withdraw ? (
                  <QueueButton
                    tone="danger"
                    disabled={withdraw.isPending}
                    onClick={() => withdraw.mutate(candidate.id)}
                  >
                    Withdraw
                  </QueueButton>
                ) : undefined
              }
            >
              {candidate.restricted ? (
                <p style={{ margin: '7px 0 0', color: '#667085', fontSize: 11.5, lineHeight: 1.48 }}>
                  Content is hidden because you no longer have access to this client memory.
                </p>
              ) : (
                proposalBody(candidate).map((section) => (
                  <div key={section.heading} style={{ marginTop: 8 }}>
                    <div style={{ color: '#475467', fontSize: 10.5, fontWeight: 650 }}>{section.heading}</div>
                    <p style={{ margin: '3px 0 0', color: '#667085', fontSize: 11.5, lineHeight: 1.48, whiteSpace: 'pre-wrap' }}>
                      {section.body}
                    </p>
                  </div>
                ))
              )}
              <div style={{ marginTop: 8, color: '#667085', fontSize: 10.5 }}>
                Source: {sourceLabel(candidate.sourceKind)}
              </div>
              {!candidate.restricted && candidate.recordedSource ? (
                <details style={{ marginTop: 7, color: '#667085', fontSize: 10.5 }}>
                  <summary style={{ cursor: 'pointer' }}>Source details</summary>
                  <div style={{ marginTop: 5, lineHeight: 1.45 }}>
                    <div>Source type: {recordedSourceLabel(candidate.recordedSource.sourceType)}</div>
                    <div style={{ overflowWrap: 'anywhere' }}>
                      Recorded source reference: {candidate.recordedSource.sourceId}
                    </div>
                  </div>
                </details>
              ) : null}
              {candidate.status !== 'pending' ? (
                <div
                  aria-label="Memory decision receipt"
                  style={{ marginTop: 8, color: '#667085', fontFamily: MONO, fontSize: 9.5 }}
                >
                  DECISION RECEIPT · {candidate.id} ·{' '}
                  {ownedMemoryCandidateStatusLabel(candidate.status).toUpperCase()}
                  {candidate.decidedAt ? ` · ${candidate.decidedAt}` : ''}
                </div>
              ) : null}
            </QueueCard>
          ))}
          {proposals.hasNextPage ? (
            <QueueButton
              disabled={proposals.isFetchingNextPage}
              onClick={() => void proposals.fetchNextPage()}
            >
              Load more proposals
            </QueueButton>
          ) : null}
        </div>
      </section>

      <section>
        <div className="vnext-meri__section-label" style={{ marginBottom: 8 }}>
          DECISION RECEIPTS · {historyItems.length}
        </div>
        <p style={{ margin: '0 0 10px', color: '#667085', fontSize: 12, lineHeight: 1.55 }}>
          Persisted canonical review decisions available to you after reload.
        </p>
        {history.isLoading ? <MeriPanelState tone="loading">Loading decision receipts…</MeriPanelState> : null}
        {history.isError ? (
          <MeriPanelState tone="error">Decision receipts could not be loaded.</MeriPanelState>
        ) : null}
        <div style={{ display: 'grid', gap: 8 }}>
          {historyItems.map((item) => (
            <QueueCard
              key={item.reviewRequestId}
              eyebrow={`${scopeLabel(item.scope)} · ${item.status.replace(/_/g, ' ').toUpperCase()}`}
              title={item.title}
              target={item.client?.name ?? (item.scope === 'firm' ? 'Firm memory' : 'Client unavailable')}
            >
              <div aria-label="Memory decision receipt" style={{ marginTop: 8, color: '#667085', fontSize: 10.5, lineHeight: 1.5 }}>
                <div>Review reference: {item.reviewRequestId}</div>
                <div>Candidate: {item.candidateId}</div>
                <div>Proposed by: {item.submittedBy.name}</div>
                <div>Revision: {item.revisionNumber}</div>
                <div>Decided by: {item.decidedBy?.name ?? 'Canonical review service'}</div>
                <div>Decided at: {item.decidedAt ?? 'Timestamp unavailable'}</div>
              </div>
            </QueueCard>
          ))}
          {history.hasNextPage ? (
            <QueueButton
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Load more decision receipts
            </QueueButton>
          ) : null}
        </div>
      </section>

    </div>
  );
}
