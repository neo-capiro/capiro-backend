/**
 * vNext re-skin of components/MemoryReviewQueue.tsx — identical endpoint,
 * query keys, invalidations, reject-reason rules and copy via
 * memory-queue-shared.ts.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import {
  candidateRejectRequiresReason,
  memoryCandidateKindLabel,
  memoryQueueErrorMessage,
  memoryReviewCandidateTitle,
  memoryReviewOutcomeMessage,
  shouldRenderMemoryReviewQueue,
  type ReviewableMemoryCandidate,
  type ReviewQueueResponse,
} from '../../../components/memory-queue-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { SvCard, SvTextArea } from './settings-ui.js';

/** Server-filtered reviewer queue used by standard reviewers and administrators. */
export function VNextMemoryReviewQueue() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [rejecting, setRejecting] = useState<ReviewableMemoryCandidate | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const queue = useQuery<ReviewQueueResponse>({
    queryKey: ['memory-review-candidates'],
    queryFn: async () => (await api.get<ReviewQueueResponse>('/api/memory/review/candidates')).data,
    staleTime: 15_000,
    retry: 1,
  });

  const decision = useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      (
        await api.post(`/api/memory/review/candidates/${input.id}/${input.decision}`, {
          ...(input.reason ? { reason: input.reason } : {}),
        })
      ).data,
    onSuccess: (result: Record<string, unknown>, input) => {
      toast.success(memoryReviewOutcomeMessage(result, input.decision));
      setRejecting(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
      qc.invalidateQueries({ queryKey: ['memory-review-summary'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-items'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-transitions'] });
      qc.invalidateQueries({ queryKey: ['memory-item'] });
    },
    onError: (error: unknown) => toast.error(memoryQueueErrorMessage(error)),
  });

  if (!shouldRenderMemoryReviewQueue(queue.data)) return null;

  const rejectCandidate = (candidate: ReviewableMemoryCandidate) => {
    if (!candidateRejectRequiresReason(candidate)) {
      decision.mutate({ id: candidate.id, decision: 'reject' });
      return;
    }
    setRejectReason('');
    setRejecting(candidate);
  };

  return (
    <SvCard
      aria-label="Memory proposals awaiting your review"
      title="Awaiting your review"
      description="These proposals are limited to the firm or clients you are authorized to review."
    >
      <div className="stv-stack">
        {queue.data?.candidates.map((candidate) => (
          <SvCard key={candidate.id}>
            <div className="stv-stack stv-stack--tight">
              <div className="stv-row">
                <span className="stv-strong">{memoryReviewCandidateTitle(candidate)}</span>
                <CapiroBadge>
                  {candidate.scope === 'client' ? 'Client memory' : 'Firm memory'}
                </CapiroBadge>
                <CapiroBadge>{memoryCandidateKindLabel(candidate.candidateKind)}</CapiroBadge>
                <span className="stv-muted stv-small">
                  Submitted {new Date(candidate.createdAt).toLocaleString()}
                </span>
              </div>

              {candidate.proposal.canonicalItem?.sections.map((section) => (
                <div key={section.key}>
                  <span className="stv-strong">{section.heading}</span>
                  <p className="stv-prewrap" style={{ marginBottom: 4 }}>
                    {section.body || '—'}
                  </p>
                </div>
              ))}

              {!candidate.proposal.canonicalItem && candidate.proposal.value && (
                <p className="stv-prewrap" style={{ marginBottom: 4 }}>
                  {candidate.proposal.value}
                </p>
              )}

              <div className="stv-row">
                {candidate.capabilities.approve && (
                  <CapiroButton
                    variant="primary"
                    loading={decision.isPending && decision.variables?.id === candidate.id}
                    onClick={() => decision.mutate({ id: candidate.id, decision: 'approve' })}
                  >
                    Approve
                  </CapiroButton>
                )}
                {candidate.capabilities.reject && (
                  <CapiroButton
                    className="stv-btn-danger"
                    loading={decision.isPending && decision.variables?.id === candidate.id}
                    onClick={() => rejectCandidate(candidate)}
                  >
                    Reject
                  </CapiroButton>
                )}
              </div>
            </div>
          </SvCard>
        ))}
      </div>

      {rejecting ? (
        <CapiroModal
          open
          title={`Reject ${memoryCandidateKindLabel(rejecting.candidateKind).toLowerCase()}`}
          onClose={() => {
            setRejecting(null);
            setRejectReason('');
          }}
        >
          <div className="stv-stack">
            <p className="stv-muted" style={{ margin: 0 }}>
              The reason becomes bounded transition evidence; proposal content is not copied into
              the audit ledger.
            </p>
            <SvTextArea
              aria-label="Rejection reason"
              rows={4}
              value={rejectReason}
              maxLength={500}
              showCount
              onChange={setRejectReason}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setRejecting(null);
                  setRejectReason('');
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton
                variant="primary"
                className="stv-btn-danger"
                disabled={rejectReason.trim().length === 0}
                loading={decision.isPending}
                onClick={() => {
                  if (!rejecting || !rejectReason.trim()) return;
                  decision.mutate({
                    id: rejecting.id,
                    decision: 'reject',
                    reason: rejectReason.trim(),
                  });
                }}
              >
                Reject proposal
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}
    </SvCard>
  );
}
