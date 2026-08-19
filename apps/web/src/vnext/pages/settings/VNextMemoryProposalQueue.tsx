/**
 * vNext re-skin of components/MemoryProposalQueue.tsx — identical endpoint,
 * query keys, invalidations and copy via memory-queue-shared.ts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import {
  ownedMemoryCandidateStatusLabel,
  ownedMemoryCandidateTitle,
  shouldRenderMemoryProposalQueue,
  type OwnedProposalQueueResponse,
} from '../../../components/memory-queue-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { SvCard } from './settings-ui.js';

/**
 * Proposer-owned history. The server returns only the current user's candidates;
 * a client proposal whose wall access was removed is redacted but a pending row
 * remains safely withdrawable. The browser never converts Withdraw into reviewer
 * rejection, and terminal labels preserve who made the disposition.
 */
export function VNextMemoryProposalQueue() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();

  const queue = useQuery<OwnedProposalQueueResponse>({
    queryKey: ['memory-own-proposals'],
    queryFn: async () => (await api.get<OwnedProposalQueueResponse>('/api/memory/proposals')).data,
    staleTime: 15_000,
    retry: 1,
  });

  const withdraw = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/memory/proposals/${id}/withdraw`, {})).data,
    onSuccess: () => {
      toast.success('Proposal withdrawn');
      qc.invalidateQueries({ queryKey: ['memory-own-proposals'] });
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
      qc.invalidateQueries({ queryKey: ['memory-review-summary'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-transitions'] });
      qc.invalidateQueries({ queryKey: ['memory-item'] });
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Withdrawal failed'),
  });

  if (!shouldRenderMemoryProposalQueue(queue.data)) return null;

  return (
    <SvCard
      aria-label="Your memory proposal history"
      title="Your proposals"
      description="Withdraw a pending proposal you no longer want reviewed. History distinguishes your withdrawal from a reviewer rejection."
    >
      <div className="stv-stack">
        {queue.data?.candidates.map((candidate) => (
          <SvCard key={candidate.id}>
            <div className="stv-stack stv-stack--tight">
              <div className="stv-row">
                <span className="stv-strong">{ownedMemoryCandidateTitle(candidate)}</span>
                <CapiroBadge>
                  {candidate.scope === 'client' ? 'Client memory' : 'Firm memory'}
                </CapiroBadge>
                <CapiroBadge>{ownedMemoryCandidateStatusLabel(candidate.status)}</CapiroBadge>
                <span className="stv-muted stv-small">
                  Submitted {new Date(candidate.createdAt).toLocaleString()}
                </span>
                {candidate.decidedAt && (
                  <span className="stv-muted stv-small">
                    Decided {new Date(candidate.decidedAt).toLocaleString()}
                  </span>
                )}
              </div>

              {candidate.restricted && (
                <p className="stv-muted" style={{ marginBottom: 4 }}>
                  Proposal content is hidden because you no longer have access to this client&apos;s
                  memory.
                  {candidate.capabilities.withdraw ? ' You may still withdraw it.' : ''}
                </p>
              )}

              {candidate.proposal?.canonicalItem?.sections.map((section) => (
                <div key={section.key}>
                  <span className="stv-strong">{section.heading}</span>
                  <p className="stv-prewrap" style={{ marginBottom: 4 }}>
                    {section.body || '—'}
                  </p>
                </div>
              ))}

              {!candidate.proposal?.canonicalItem && candidate.proposal?.value && (
                <p className="stv-prewrap" style={{ marginBottom: 4 }}>
                  {candidate.proposal.value}
                </p>
              )}

              {candidate.capabilities.withdraw && (
                <div className="stv-row">
                  <CapiroButton
                    className="stv-btn-danger"
                    loading={withdraw.isPending && withdraw.variables === candidate.id}
                    onClick={() => withdraw.mutate(candidate.id)}
                  >
                    Withdraw
                  </CapiroButton>
                </div>
              )}
            </div>
          </SvCard>
        ))}
      </div>
    </SvCard>
  );
}
