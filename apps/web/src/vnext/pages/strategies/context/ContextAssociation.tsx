import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { errorMessage } from '../../../../lib/error-message.js';
import type { ContextDocumentDetail } from '../../../../pages/strategy/types.js';
import { useContextAssociation, useContextReassignmentTargets, useReassignContextDocument } from './context-workflows-api.js';

export function ContextAssociation({ document }: { document: ContextDocumentDetail }) {
  const navigate = useNavigate();
  const association = useContextAssociation(document.id, document.scope === 'strategy');
  const [review, setReview] = useState<{ checksum: string; strategyId: string } | null>(null);
  const targets = useContextReassignmentTargets(review !== null);
  const move = useReassignContextDocument();
  if (document.scope !== 'strategy') return null;
  return <section className="st-ctxdoc__association" aria-label="Strategy association">
    <strong>Applies to strategy: </strong>
    {association.isLoading ? 'Checking…' : association.isError ? <span>Association unavailable. <button type="button" onClick={() => void association.refetch()}>Retry</button></span>
      : association.data?.state === 'active' ? <Link to={`/strategies/${association.data.strategy!.id}`}>{association.data.strategy!.title}</Link>
      : <span role="status">{association.data?.state === 'archived' ? `${association.data.strategy?.title} is archived. This document is historical context for that plan.` : 'The linked strategy is unavailable for this client. This document does not apply to another plan automatically.'}</span>}
    {document.state === 'active' && document.clientId ? <CapiroButton variant="quiet" size="compact" onClick={() => setReview({ checksum: document.checksum, strategyId: '' })}>Change strategy</CapiroButton> : null}
    {review ? <form onSubmit={(event) => { event.preventDefault(); move.mutate({ id: document.id, expectedChecksum: review.checksum, strategyId: review.strategyId }, { onSuccess: (next) => navigate(`/strategies/context/${next.id}?clientId=${document.clientId}`) }); }}>
      <p>A new working version will replace this version. Its text stays unchanged; approval must be reviewed again for the new strategy. The original and its facts remain in history.</p>
      <label>New strategy <select value={review.strategyId} required disabled={move.isPending || targets.isLoading} onChange={(event) => setReview({ ...review, strategyId: event.target.value })}>
        <option value="">Choose an active strategy</option>
        {(targets.data ?? []).filter((row) => row.clientId === document.clientId && row.id !== document.scopeRef).map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
      </select></label>
      {targets.isError ? <p role="alert">Could not load strategies. <button type="button" onClick={() => void targets.refetch()}>Retry</button></p> : null}
      {move.isError ? <p role="alert">{errorMessage(move.error, 'The document could not be moved.')}</p> : null}
      <CapiroButton type="submit" variant="primary" disabled={!review.strategyId || move.isPending || targets.isError}>Create working revision</CapiroButton>
      <CapiroButton type="button" variant="quiet" disabled={move.isPending} onClick={() => setReview(null)}>Cancel</CapiroButton>
    </form> : null}
  </section>;
}
