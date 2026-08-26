import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  candidateRejectRequiresReason,
  memoryQueueErrorMessage,
  memoryReviewCandidateTitle,
  memoryReviewOutcomeMessage,
  ownedMemoryCandidateStatusLabel,
  ownedMemoryCandidateTitle,
  type OwnedMemoryCandidate,
  type OwnedProposalQueueResponse,
  type ReviewableMemoryCandidate,
  type ReviewQueueResponse,
} from '../../components/memory-queue-shared.js';
import { useApi } from '../../lib/use-api.js';
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
  if (scope === 'personal') return 'PERSONAL MEMORY';
  return 'FIRM MEMORY';
}

function kindLabel(kind: string): string {
  if (kind === 'standard') return 'NEW MEMORY';
  if (kind === 'correction') return 'CORRECTION';
  if (kind === 'restore') return 'RESTORE';
  if (kind === 'contradiction') return 'CONTRADICTION';
  return kind.replace(/_/g, ' ').toUpperCase();
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
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
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
  const [rejecting, setRejecting] = useState<ReviewableMemoryCandidate | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const activeMemory = (packet?.items ?? []).filter(isGovernedMemoryItem);
  const reviewCandidates = review.data?.enabled ? review.data.candidates : [];
  const ownedProposals = proposals.data?.enabled ? proposals.data.candidates : [];

  const invalidateMemory = () => {
    for (const key of [
      'memory-review-candidates',
      'memory-own-proposals',
      'memory-review-summary',
      'memory-governance-overview',
      'memory-governance-items',
      'memory-governance-transitions',
      'memory-item',
    ]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const decision = useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      (
        await api.post('/api/memory/review/candidates/' + input.id + '/' + input.decision, {
          ...(input.reason ? { reason: input.reason } : {}),
        })
      ).data as Record<string, unknown>,
    onSuccess: (result, input) => {
      toast.success(memoryReviewOutcomeMessage(result, input.decision));
      setRejecting(null);
      setRejectReason('');
      invalidateMemory();
    },
    onError: (error: unknown) => toast.error(memoryQueueErrorMessage(error)),
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
    if (!candidateRejectRequiresReason(candidate)) {
      decision.mutate({ id: candidate.id, decision: 'reject' });
      return;
    }
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
        {review.isLoading ? <MeriPanelState tone="loading">Loading review queue…</MeriPanelState> : null}
        {review.isError ? (
          <MeriPanelState tone="error">The institutional review queue could not be loaded.</MeriPanelState>
        ) : null}
        {!review.isLoading && !review.isError && reviewCandidates.length === 0 ? (
          <MeriPanelState tone="empty">Nothing is waiting for your review.</MeriPanelState>
        ) : null}
        <div style={{ display: 'grid', gap: 8 }}>
          {reviewCandidates.map((candidate) => (
            <QueueCard
              key={candidate.id}
              eyebrow={scopeLabel(candidate.scope) + ' · ' + kindLabel(candidate.candidateKind)}
              title={memoryReviewCandidateTitle(candidate)}
              actions={
                <>
                  {candidate.capabilities.approve ? (
                    <QueueButton
                      tone="primary"
                      disabled={decision.isPending}
                      onClick={() => decision.mutate({ id: candidate.id, decision: 'approve' })}
                    >
                      Approve
                    </QueueButton>
                  ) : null}
                  {candidate.capabilities.reject ? (
                    <QueueButton
                      tone="danger"
                      disabled={decision.isPending}
                      onClick={() => rejectCandidate(candidate)}
                    >
                      Reject
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
            </QueueCard>
          ))}
        </div>
      </section>

      <section>
        <div className="vnext-meri__section-label" style={{ marginBottom: 8 }}>
          YOUR PROPOSALS · {ownedProposals.length}
        </div>
        {proposals.isLoading ? <MeriPanelState tone="loading">Loading your proposals…</MeriPanelState> : null}
        {proposals.isError ? (
          <MeriPanelState tone="error">Your proposal history could not be loaded.</MeriPanelState>
        ) : null}
        {!proposals.isLoading && !proposals.isError && ownedProposals.length === 0 ? (
          <MeriPanelState tone="empty">You have not proposed an institutional memory change.</MeriPanelState>
        ) : null}
        <div style={{ display: 'grid', gap: 8 }}>
          {ownedProposals.slice(0, 5).map((candidate) => (
            <QueueCard
              key={candidate.id}
              eyebrow={scopeLabel(candidate.scope) + ' · ' + ownedMemoryCandidateStatusLabel(candidate.status).toUpperCase()}
              title={ownedMemoryCandidateTitle(candidate)}
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
            </QueueCard>
          ))}
        </div>
      </section>

      <a
        href="/settings/memory"
        target="_blank"
        rel="noreferrer"
        className="vnext-meri__rail-action-btn"
        style={{ justifyContent: 'center', textDecoration: 'none' }}
      >
        <MeriIcon name="ArrowUpRight" size={14} color="#344054" />
        Open Governance Center
      </a>
    </div>
  );
}
