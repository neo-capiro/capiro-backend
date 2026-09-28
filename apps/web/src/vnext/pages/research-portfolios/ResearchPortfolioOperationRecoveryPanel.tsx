import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import {
  ResearchPortfolioAuthorityBoundary,
  useResearchPortfolioAuthorityScope,
} from './research-portfolio-authority.js';
import {
  getResearchPortfolioOperation,
  reconcileResearchPortfolioOperation,
} from './research-portfolios-api.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function ResearchPortfolioOperationRecoveryPanel(props: {
  portfolioId: string;
  canEdit: boolean;
}) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <OperationRecovery key={props.portfolioId} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}
function OperationRecovery({ portfolioId, canEdit }: { portfolioId: string; canEdit: boolean }) {
  const api = useApi(),
    client = useQueryClient(),
    scope = useResearchPortfolioAuthorityScope();
  const [typedId, setTypedId] = useState(''),
    [operationId, setOperationId] = useState<string | null>(null),
    [operationKey, setOperationKey] = useState(''),
    [validation, setValidation] = useState<string | null>(null);
  const key = ['research-portfolio-operation-recovery', scope, portfolioId, operationId];
  const read = useQuery({
    queryKey: key,
    enabled: Boolean(scope && operationId),
    queryFn: () => getResearchPortfolioOperation(api, portfolioId, operationId!),
    retry: false,
  });
  const operation = read.data;
  const filing = operation?.kind === 'client_filing';
  const supported = operation?.kind === 'output' || filing;
  const reconcile = useMutation({
    mutationFn: (attempt: {
      operationId: string;
      queryKey: (string | null)[];
      operationKey: string | null;
    }) =>
      reconcileResearchPortfolioOperation(
        api,
        portfolioId,
        attempt.operationId,
        attempt.operationKey === null ? {} : { operationKey: attempt.operationKey },
      ),
    onSuccess: (result, attempt) => client.setQueryData(attempt.queryKey, result),
    retry: false,
  });
  function load() {
    if (reconcile.isPending) return;
    const id = typedId.trim();
    if (!UUID.test(id)) {
      setValidation('Enter an exact operation UUID.');
      return;
    }
    setValidation(null);
    setOperationKey('');
    reconcile.reset();
    setOperationId(id);
    if (id === operationId) void read.refetch();
  }
  return (
    <section className="rp-card" aria-label="Operation recovery">
      <h3>Operation recovery</h3>
      <p>
        Read an existing operation by its exact ID. No new operation or external write starts here.
      </p>
      <label>
        Operation ID
        <input
          aria-label="Operation ID"
          value={typedId}
          onChange={(event) => setTypedId(event.target.value)}
        />
      </label>
      <button
        className="rp-button"
        onClick={load}
        disabled={!scope || read.isFetching || reconcile.isPending}
      >
        Load operation
      </button>
      {validation ? <p role="alert">{validation}</p> : null}
      {read.isFetching ? <p role="status">Checking current operation access…</p> : null}
      {read.error ? (
        <p role="alert">
          The operation is unavailable under your current access. Verify the ID and retry.
        </p>
      ) : null}
      {operation && !read.error ? (
        <div>
          <p>
            {operation.label ?? 'Existing operation'}: {operation.kind} — {operation.status}
          </p>
          <p>Domain state: {operation.domainStatus}</p>
          <p>Actor: {operation.actorUserId ?? 'not recorded'}</p>
          <p>
            Started: {operation.startedAt ?? 'not recorded'}; completed:{' '}
            {operation.completedAt ?? 'not recorded'}
          </p>
          {operation.lastError ? <p role="status">{operation.lastError}</p> : null}
          <ul>
            {operation.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
          {!supported ? (
            <p>
              Use the original {operation.kind} action to continue this operation. Generic
              reconciliation is unavailable for this kind.
            </p>
          ) : (
            <p>
              Reconcile an existing checkpoint under current access. An unknown outcome remains
              unknown when no committed checkpoint is available; this action never starts a second
              external writer.
            </p>
          )}
          {supported && canEdit && !['completed', 'cancelled'].includes(operation.status) ? (
            <div>
              {filing ? (
                <label>
                  Original filing operation key
                  <input
                    aria-label="Original filing operation key"
                    autoComplete="off"
                    value={operationKey}
                    onChange={(event) => setOperationKey(event.target.value)}
                  />
                  <span>
                    Use the exact key retained by the original filing attempt. A replacement key
                    cannot recover it.
                  </span>
                </label>
              ) : null}
              <button
                className="rp-button"
                onClick={() =>
                  reconcile.mutate({
                    operationId: operationId!,
                    queryKey: key,
                    operationKey: filing ? operationKey : null,
                  })
                }
                disabled={
                  reconcile.isPending ||
                  (filing && (!operationKey.trim() || operationKey.length > 128))
                }
              >
                Reconcile existing checkpoint
              </button>
            </div>
          ) : null}
          {reconcile.error ? (
            <p role="alert">
              Reconciliation did not complete. Preserve the original filing identity and inspect the
              current operation before retrying.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
