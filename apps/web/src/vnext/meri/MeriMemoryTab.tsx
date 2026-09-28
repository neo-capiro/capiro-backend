import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { httpErrorStatus } from '../../lib/query-retry.js';
import type {
  MemoryReviewDetail,
  MemoryReviewInboxPage,
} from '../../components/memory-review-inbox-shared.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon } from './meri-icons.js';
import { MeriPanelState } from './MeriPanelState.js';
import type { MeriContextPacket, MeriContextPacketItem } from './meri-vnext-api.js';

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

export function useMeriGovernedMemoryQueues() {
  const api = useApi();
  const review = useQuery<ReviewQueueResponse>({
    queryKey: ['memory-review-candidates'],
    queryFn: async () =>
      (await api.get<ReviewQueueResponse>('/api/memory/review/candidates')).data,
    staleTime: 15_000,
    retry: 1,
  });
  const proposals = useQuery<OwnedProposalQueueResponse>({
    queryKey: ['memory-own-proposals'],
    queryFn: async () =>
      (await api.get<OwnedProposalQueueResponse>('/api/memory/proposals')).data,
    staleTime: 15_000,
    retry: 1,
  });

  return {
    review,
    proposals,
    reviewCount: review.data?.enabled ? review.data.candidates.length : 0,
    pendingProposalCount: proposals.data?.enabled
      ? proposals.data.candidates.filter((candidate) => candidate.status === 'pending').length
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

function decisionObserved(detail: MemoryReviewDetail, decision: ReviewDecision): boolean {
  if (decision === 'approve' || decision === 'resolve-conflict') {
    return detail.status === 'approved';
  }
  if (decision === 'reject') return detail.status === 'rejected';
  return detail.status === 'changes_requested';
}

function sourceLabel(sourceKind: string): string {
  return sourceKind.replace(/_/g, ' ');
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
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { review, proposals } = useMeriGovernedMemoryQueues();
  const history = useQuery<MemoryReviewInboxPage>({
    queryKey: ['memory-review-inbox', 'history', 'meri'],
    queryFn: async () =>
      (
        await api.get<MemoryReviewInboxPage>('/api/memory/review/inbox', {
          params: { view: 'history', limit: 25 },
        })
      ).data,
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
  const [decisionNotice, setDecisionNotice] = useState<DecisionNotice | null>(null);

  const activeMemory = (packet?.items ?? []).filter(isGovernedMemoryItem);
  const reviewCandidates = review.data?.enabled ? review.data.candidates : [];
  const ownedProposals = proposals.data?.enabled ? proposals.data.candidates : [];

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

  const reconcileDecision = async (
    input: ReviewDecisionInput,
    error?: unknown,
  ) => {
    let detail: MemoryReviewDetail | undefined;
    try {
      const observed = (
        await api.get<MemoryReviewDetail>(`/api/memory/review/inbox/candidates/${input.id}`)
      ).data;
      if (observed && typeof observed.status === 'string') detail = observed;
    } catch {
      // A failed status read never licenses replaying the write.
    }

    if (detail && decisionObserved(detail, input.decision)) {
      setDecisionNotice({
        input,
        tone: 'success',
        title: 'Decision confirmed',
        message: 'The canonical review record confirms the persisted decision.',
        ambiguous: false,
        detail,
      });
      toast.success(
        input.decision === 'approve' || input.decision === 'resolve-conflict'
          ? 'Memory approval confirmed'
          : input.decision === 'reject'
            ? 'Memory rejection confirmed'
            : 'Change request confirmed',
      );
      invalidateMemory();
      return;
    }

    const status = httpErrorStatus(error);
    const definitive = status === 403 || status === 409;
    const failure = error
      ? memoryQueueErrorMessage(error)
      : 'The decision response was accepted but its status could not be confirmed.';
    setDecisionNotice({
      input,
      tone: definitive ? 'error' : 'warning',
      title:
        status === 403
          ? 'Review permission denied'
          : status === 409
            ? 'Review changed before this decision'
            : 'Decision status unconfirmed',
      message: definitive
        ? `${failure} The proposal was not reported as changed.`
        : `${failure} Check status before taking any further action; the decision will not be sent again automatically.`,
      ambiguous: !definitive,
      ...(detail ? { detail } : {}),
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
    onSuccess: async (_result, input) => {
      setRejecting(null);
      setRejectReason('');
      setRequestingChanges(null);
      setChangeReason('');
      setResolvingConflict(null);
      await reconcileDecision(input);
    },
    onError: async (error: unknown, input) => {
      toast.error(memoryQueueErrorMessage(error));
      await reconcileDecision(input, error);
    },
  });

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
        {decisionNotice ? (
          <MeriPanelState tone={decisionNotice.tone === 'error' ? 'error' : 'loading'}>
            <strong>{decisionNotice.title}</strong>
            <div>{decisionNotice.message}</div>
            {decisionNotice.detail ? (
              <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 10 }}>
                RECEIPT {decisionNotice.detail.candidateId} ·{' '}
                {decisionNotice.detail.status.toUpperCase()}
                {decisionNotice.detail.decidedAt ? ` · ${decisionNotice.detail.decidedAt}` : ''}
              </div>
            ) : null}
            {decisionNotice.ambiguous ? (
              <button
                type="button"
                className="vnext-meri__rail-action-btn"
                style={{ marginTop: 8 }}
                onClick={() => void reconcileDecision(decisionNotice.input)}
              >
                Check current status
              </button>
            ) : null}
          </MeriPanelState>
        ) : null}
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
                        (decisionNotice?.input.id === candidate.id && decisionNotice.ambiguous)
                      }
                      onClick={() => decision.mutate({ id: candidate.id, decision: 'approve' })}
                    >
                      Approve
                    </QueueButton>
                  ) : null}
                  {candidate.capabilities.reject ? (
                    <QueueButton
                      tone="danger"
                      disabled={
                        decision.isPending ||
                        (decisionNotice?.input.id === candidate.id && decisionNotice.ambiguous)
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
                        (decisionNotice?.input.id === candidate.id && decisionNotice.ambiguous)
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
                        (decisionNotice?.input.id === candidate.id && decisionNotice.ambiguous)
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
          YOUR PROPOSALS · {ownedProposals.length}
        </div>
        <p style={{ margin: '0 0 10px', color: '#667085', fontSize: 12, lineHeight: 1.55 }}>
          Your proposals across clients and firm memory, independent of the client picker.
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
        </div>
      </section>

      <section>
        <div className="vnext-meri__section-label" style={{ marginBottom: 8 }}>
          DECISION RECEIPTS · {history.data?.items?.length ?? 0}
        </div>
        <p style={{ margin: '0 0 10px', color: '#667085', fontSize: 12, lineHeight: 1.55 }}>
          Persisted canonical review decisions available to you after reload.
        </p>
        {history.isLoading ? <MeriPanelState tone="loading">Loading decision receipts…</MeriPanelState> : null}
        {history.isError ? (
          <MeriPanelState tone="error">Decision receipts could not be loaded.</MeriPanelState>
        ) : null}
        <div style={{ display: 'grid', gap: 8 }}>
          {(history.data?.items ?? []).map((item) => (
            <QueueCard
              key={item.reviewRequestId}
              eyebrow={`${scopeLabel(item.scope)} · ${item.status.replace(/_/g, ' ').toUpperCase()}`}
              title={item.title}
              target={item.client?.name ?? (item.scope === 'firm' ? 'Firm memory' : 'Client unavailable')}
            >
              <div aria-label="Memory decision receipt" style={{ marginTop: 8, color: '#667085', fontSize: 10.5, lineHeight: 1.5 }}>
                <div>Review reference: {item.candidateId}</div>
                <div>Proposed by: {item.submittedBy.name}</div>
                <div>Revision: {item.revisionNumber}</div>
                <div>Decided by: {item.decidedBy?.name ?? 'Canonical review service'}</div>
                <div>Decided at: {item.decidedAt ?? 'Timestamp unavailable'}</div>
              </div>
            </QueueCard>
          ))}
        </div>
      </section>

    </div>
  );
}
