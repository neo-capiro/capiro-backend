/**
 * vNext re-skin of pages/admin/PeReconciliationPage.tsx — the Step 29 / 0.2
 * cross-source reconciliation review queue (capiro_admin only). Identical
 * endpoints, query keys, copy and decision semantics: keep the canonical
 * value, accept the conflicting source, or enter a manual value ($ millions,
 * writes through the writer's manual_override path). The client-side
 * capiro_admin gate is an affordance; the server's RolesGuard is the boundary.
 *
 * `standalone` wraps the queue in the module page frame (used by the
 * /admin/program-element/reconciliation route); the Analyst Console mounts it
 * bare as a tab, exactly like canonical.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroModal } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  SvCard,
  SvCallout,
  SvPagination,
  SvTextArea,
  useSvConfirm,
  useSvPagination,
} from '../settings/settings-ui.js';

interface ReconciliationEntry {
  id: string;
  peCode: string;
  fy: number;
  fieldName: string;
  currentValue: string | null;
  conflictingSource: string;
  conflictingValue: string | null;
  deltaPct: number | null;
  queuedAt: string;
  status: string;
  resolutionNotes?: string | null;
  resolvedAt?: string | null;
}

interface QueueResponse {
  data: ReconciliationEntry[];
  total: number;
  page: number;
  limit: number;
}

type ResolveDecision = 'keep_current' | 'accept_conflicting' | 'manual_value';
type StatusFilter = 'open' | 'resolved' | 'all';

export function VNextPeReconciliationPage({ standalone = false }: { standalone?: boolean }) {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const isCapiroAdmin = me.data?.role === 'capiro_admin';

  const [status, setStatus] = useState<StatusFilter>('open');
  const [pending, setPending] = useState<string | null>(null);
  const [manualFor, setManualFor] = useState<ReconciliationEntry | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [manualError, setManualError] = useState<string | undefined>();
  const [manualNotes, setManualNotes] = useState('');

  const queue = useQuery({
    queryKey: ['reconciliation-queue', status],
    enabled: isCapiroAdmin,
    queryFn: async (): Promise<QueueResponse> =>
      (
        await api.get<QueueResponse>('/api/program-elements/admin/reconciliation-queue', {
          params: { status },
        })
      ).data,
  });

  const resolve = useMutation({
    mutationFn: (vars: { id: string; decision: ResolveDecision; manualValue?: number; notes?: string }) =>
      api.post(`/api/program-elements/admin/reconciliation-queue/${encodeURIComponent(vars.id)}/resolve`, {
        decision: vars.decision,
        manualValue: vars.manualValue,
        notes: vars.notes,
      }),
    onMutate: (vars) => setPending(vars.id),
    onSuccess: (_res, vars) => {
      toast.success(
        vars.decision === 'keep_current'
          ? 'Kept the canonical value.'
          : vars.decision === 'accept_conflicting'
            ? 'Accepted the conflicting value — canonical updated.'
            : 'Manual value applied — canonical updated.',
      );
      setManualFor(null);
      setManualValue('');
      setManualNotes('');
      void qc.invalidateQueries({ queryKey: ['reconciliation-queue'] });
    },
    onError: (e: unknown) => toast.error(`Resolve failed: ${(e as Error).message}`),
    onSettled: () => setPending(null),
  });

  const rows = queue.data?.data ?? [];
  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(rows, 25);

  function submitManual() {
    if (!manualFor) return;
    const parsed = Number(manualValue);
    if (manualValue.trim() === '' || !Number.isFinite(parsed)) {
      setManualError('Enter a numeric value in $ millions');
      return;
    }
    setManualError(undefined);
    resolve.mutate({
      id: manualFor.id,
      decision: 'manual_value',
      manualValue: parsed,
      notes: manualNotes.trim() || undefined,
    });
  }

  const frame = (content: JSX.Element) =>
    standalone ? (
      <div className="settings-vnext amx">
        <header className="stv-header">
          <div>
            <h1>Reconciliation Review Queue</h1>
            <p>Cross-source budget conflicts awaiting an administrator decision.</p>
          </div>
        </header>
        <div className="stv-body">{content}</div>
      </div>
    ) : (
      content
    );

  if (me.isLoading) {
    return frame(
      <div className="stv-stack" aria-label="Loading">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>,
    );
  }
  if (!isCapiroAdmin) {
    return frame(
      <CapiroErrorState
        title="403"
        description="Reconciliation review is restricted to Capiro administrators."
      />,
    );
  }

  const body = (
    <SvCard
      title="Reconciliation Review Queue"
      description="Cross-source budget conflicts flagged for review: greater than 10% disagreement on a non-enacted field, or any disagreement on the enacted (appropriated) value. The canonical value follows source priority; resolve each entry by keeping the canonical value, accepting the conflicting source, or entering a manual value (in $ millions)."
    >
      <div className="stv-stack">
        <div className="stv-row">
          <span style={{ minWidth: 160 }}>
            <CapiroSelect
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'all', label: 'All' },
              ]}
            />
          </span>
        </div>

        {queue.isError ? (
          <SvCallout kind="error" title="Failed to load the reconciliation queue." />
        ) : null}

        {queue.isLoading ? (
          <div className="stv-stack" aria-label="Loading reconciliation queue">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : rows.length === 0 ? (
          <CapiroEmptyState title={`No ${status} reconciliation entries.`} />
        ) : (
          <>
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>PE Code</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>FY</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Field</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Canonical</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Conflicting source</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Conflicting value</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Δ%</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {pageRows.map((r) => (
                    <tr key={r.id}>
                      <CapiroTableCell>
                        <span className="stv-code">{r.peCode}</span>
                      </CapiroTableCell>
                      <CapiroTableCell>{r.fy}</CapiroTableCell>
                      <CapiroTableCell>
                        <CapiroBadge tone={r.fieldName === 'enacted' ? 'danger' : 'info'}>
                          {r.fieldName}
                        </CapiroBadge>
                      </CapiroTableCell>
                      <CapiroTableCell>{r.currentValue ?? '—'}</CapiroTableCell>
                      <CapiroTableCell>{r.conflictingSource}</CapiroTableCell>
                      <CapiroTableCell>{r.conflictingValue ?? '—'}</CapiroTableCell>
                      <CapiroTableCell>
                        {r.deltaPct === null ? (
                          '—'
                        ) : (
                          <CapiroBadge tone={r.deltaPct > 0.1 ? 'danger' : 'warning'}>
                            {(r.deltaPct * 100).toFixed(1)}%
                          </CapiroBadge>
                        )}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {r.status !== 'open' ? (
                          <CapiroBadge tone={r.status === 'resolved' ? 'success' : 'neutral'}>
                            {r.status}
                          </CapiroBadge>
                        ) : (
                          <span className="amx-inline-actions">
                            <CapiroButton
                              size="compact"
                              loading={pending === r.id}
                              onClick={() =>
                                confirm({
                                  title: 'Keep the canonical value?',
                                  body: 'Marks this conflict reviewed; no value change.',
                                  okText: 'Keep',
                                  onOk: () =>
                                    resolve.mutateAsync({ id: r.id, decision: 'keep_current' }),
                                })
                              }
                            >
                              Keep
                            </CapiroButton>
                            <CapiroButton
                              size="compact"
                              variant="primary"
                              loading={pending === r.id}
                              onClick={() =>
                                confirm({
                                  title: `Accept ${r.conflictingSource}'s value (${r.conflictingValue ?? '—'})?`,
                                  body: 'Sets it as the canonical value (admin override).',
                                  okText: 'Accept',
                                  onOk: () =>
                                    resolve.mutateAsync({ id: r.id, decision: 'accept_conflicting' }),
                                })
                              }
                            >
                              Accept
                            </CapiroButton>
                            <CapiroButton
                              size="compact"
                              loading={pending === r.id}
                              onClick={() => {
                                setManualValue('');
                                setManualNotes('');
                                setManualError(undefined);
                                setManualFor(r);
                              }}
                            >
                              Manual…
                            </CapiroButton>
                          </span>
                        )}
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            <SvPagination currentPage={currentPage} pageCount={pageCount} onPage={setPage} />
          </>
        )}
      </div>

      {manualFor ? (
        <CapiroModal
          open
          title={`Manual value — ${manualFor.peCode} FY${manualFor.fy} ${manualFor.fieldName}`}
          onClose={() => setManualFor(null)}
        >
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submitManual();
            }}
          >
            <CapiroInput
              label="Value ($ millions)"
              type="number"
              step="0.01"
              error={manualError}
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
            />
            <SvTextArea
              label="Notes (optional)"
              rows={2}
              placeholder="Why this value?"
              value={manualNotes}
              onChange={setManualNotes}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setManualFor(null)} disabled={resolve.isPending}>
                Cancel
              </CapiroButton>
              <CapiroButton variant="primary" type="submit" loading={resolve.isPending}>
                Apply value
              </CapiroButton>
            </div>
          </form>
        </CapiroModal>
      ) : null}

      {dialog}
    </SvCard>
  );

  return frame(body);
}
