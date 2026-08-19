/**
 * vNext re-skin of pages/admin/CustomersPage.tsx — identical endpoints, query
 * keys, copy and the comp/un-comp + managed-import confirmations. antd's
 * column-header status filter and MRR sorter become an explicit filter select
 * and a clickable sort header (deliberate presentation-only deviation).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingStatus } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
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
  SvPagination,
  SvSortHeader,
  SvStat,
  useSvConfirm,
  useSvPagination,
  useSvSort,
} from './settings-ui.js';

interface CustomerRow {
  tenantId: string;
  slug: string;
  name: string;
  status: BillingStatus;
  slots: number;
  usedSlots: number;
  pricePerSlotUsd: number;
  mrrUsd: number;
  llmUsedUsd: number;
  llmOverageUsd: number;
  currentPeriodEnd: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<BillingStatus, CapiroBadgeTone> = {
  none: 'neutral',
  trialing: 'info',
  active: 'success',
  past_due: 'danger',
  canceled: 'danger',
  comped: 'warning',
};

interface ManagedImportRow {
  tenantId: string;
  name: string;
  slug: string;
  importStatus: 'none' | 'waiting' | 'verifying' | 'done';
  clientCount: number;
  createdAt: string;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Capiro-admin "Customers" console: every tenant's billing posture, slot usage,
 * MRR and month-to-date AI spend, plus a comp toggle. Gated to capiro_admin in
 * the Settings layout; every endpoint enforces RolesGuard server-side.
 */
export function VNextCustomersPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [statusFilter, setStatusFilter] = useState<'all' | BillingStatus>('all');
  const sort = useSvSort<'mrrUsd'>('mrrUsd');

  const customers = useQuery<CustomerRow[]>({
    queryKey: ['admin', 'billing', 'customers'],
    queryFn: async () => (await api.get<CustomerRow[]>('/api/capiro-admin/billing/customers')).data,
  });

  const comp = useMutation({
    // Comp writes moved to onboard-api (the single billing writer, onboarding
    // v1) — same-origin path via the ALB /onboard-api/* rule.
    mutationFn: async (input: { tenantId: string; comped: boolean }) =>
      (
        await api.post(`/onboard-api/admin/billing/tenants/${input.tenantId}/comp`, {
          comped: input.comped,
        })
      ).data,
    onSuccess: () => {
      toast.success('Updated');
      qc.invalidateQueries({ queryKey: ['admin', 'billing', 'customers'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // Capiro-managed (white-glove) client imports awaiting completion.
  const managedImports = useQuery<ManagedImportRow[]>({
    queryKey: ['admin', 'managed-imports'],
    queryFn: async () =>
      (await api.get<ManagedImportRow[]>('/onboard-api/admin/setup/managed-imports')).data,
  });

  const markImportComplete = useMutation({
    mutationFn: async (tenantId: string) =>
      (await api.post(`/onboard-api/admin/setup/tenants/${tenantId}/mark-import-complete`)).data,
    onSuccess: () => {
      toast.success('Client import marked complete');
      qc.invalidateQueries({ queryKey: ['admin', 'managed-imports'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const rows = customers.data ?? [];
  const totalMrr = rows.reduce((sum, r) => sum + r.mrrUsd, 0);
  const totalOverage = rows.reduce((sum, r) => sum + r.llmOverageUsd, 0);
  const payingCount = rows.filter((r) => r.mrrUsd > 0).length;
  const managedRows = managedImports.data ?? [];
  const pendingManaged = managedRows.filter((r) => r.importStatus !== 'done');

  const visibleRows = useMemo(() => {
    const filtered = statusFilter === 'all' ? rows : rows.filter((r) => r.status === statusFilter);
    const sorted = [...filtered].sort((a, b) =>
      sort.dir === 'desc' ? b.mrrUsd - a.mrrUsd : a.mrrUsd - b.mrrUsd,
    );
    return sorted;
  }, [rows, statusFilter, sort.dir]);

  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(visibleRows, 25);

  return (
    <div className="stv-stack">
      <SvCard>
        <div className="stv-row" style={{ gap: 48 }}>
          <SvStat label="Paying customers" value={payingCount} />
          <SvStat label="Monthly recurring revenue" value={money(totalMrr)} />
          <SvStat label="Overage (this period)" value={money(totalOverage)} />
        </div>
      </SvCard>

      <SvCard
        title="Capiro-managed client imports"
        description="Firms that chose white-glove import. Once you've added a firm's clients, mark it complete to unblock their “Invite your team” step on the setup dashboard."
        extra={
          pendingManaged.length > 0 ? (
            <CapiroBadge tone="warning">{pendingManaged.length} awaiting completion</CapiroBadge>
          ) : undefined
        }
      >
        {managedImports.isLoading ? (
          <CapiroSkeleton height={16} />
        ) : (
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Tenant</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Clients added</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Import step</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {managedRows.length === 0 ? (
                  <tr>
                    <CapiroTableCell colSpan={4}>
                      <span className="stv-muted">No Capiro-managed imports</span>
                    </CapiroTableCell>
                  </tr>
                ) : (
                  managedRows.map((r) => (
                    <tr key={r.tenantId}>
                      <CapiroTableCell>
                        {r.name} <span className="stv-muted">/{r.slug}</span>
                      </CapiroTableCell>
                      <CapiroTableCell>{r.clientCount}</CapiroTableCell>
                      <CapiroTableCell>
                        {r.importStatus === 'done' ? (
                          <CapiroBadge tone="success">complete</CapiroBadge>
                        ) : (
                          <CapiroBadge tone="warning">in progress</CapiroBadge>
                        )}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {r.importStatus === 'done' ? (
                          <span className="stv-muted">—</span>
                        ) : (
                          <CapiroButton
                            size="compact"
                            variant="primary"
                            onClick={() =>
                              confirm({
                                title: 'Mark client import complete?',
                                body: `This unblocks ${r.name}'s team-invite step. Do this only after their clients are added.`,
                                okText: 'OK',
                                onOk: () => markImportComplete.mutateAsync(r.tenantId),
                              })
                            }
                          >
                            Mark import complete
                          </CapiroButton>
                        )}
                      </CapiroTableCell>
                    </tr>
                  ))
                )}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
        )}
      </SvCard>

      <SvCard
        title="Customers"
        extra={
          <span style={{ minWidth: 180 }}>
            <CapiroSelect
              label="Status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as 'all' | BillingStatus)}
              options={[
                { value: 'all', label: 'All statuses' },
                ...(['active', 'trialing', 'past_due', 'canceled', 'comped', 'none'] as const).map(
                  (s) => ({ value: s, label: s }),
                ),
              ]}
            />
          </span>
        }
      >
        {customers.isLoading ? (
          <div className="stv-stack" aria-label="Loading customers">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="80%" />
          </div>
        ) : (
          <>
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>Tenant</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Slots</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>$/slot</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>
                      <SvSortHeader
                        label="MRR"
                        active={sort.key === 'mrrUsd'}
                        dir={sort.dir}
                        onToggle={() => sort.toggle('mrrUsd')}
                      />
                    </CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>AI used</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Overage</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Renews</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Actions</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {pageRows.map((r) => (
                    <tr key={r.tenantId}>
                      <CapiroTableCell>
                        {r.name} <span className="stv-muted">/{r.slug}</span>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <CapiroBadge tone={STATUS_TONE[r.status]}>{r.status}</CapiroBadge>
                      </CapiroTableCell>
                      <CapiroTableCell>{`${r.usedSlots} / ${r.slots}`}</CapiroTableCell>
                      <CapiroTableCell>{money(r.pricePerSlotUsd)}</CapiroTableCell>
                      <CapiroTableCell>{money(r.mrrUsd)}</CapiroTableCell>
                      <CapiroTableCell>{money(r.llmUsedUsd)}</CapiroTableCell>
                      <CapiroTableCell>
                        {r.llmOverageUsd > 0 ? (
                          <span className="stv-danger-text">{money(r.llmOverageUsd)}</span>
                        ) : (
                          money(0)
                        )}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {r.currentPeriodEnd ? new Date(r.currentPeriodEnd).toLocaleDateString() : '—'}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {r.status === 'comped' ? (
                          <CapiroButton
                            size="compact"
                            onClick={() =>
                              confirm({
                                title: 'Remove complimentary access?',
                                body: 'They will need to subscribe to keep using Capiro.',
                                okText: 'OK',
                                onOk: () =>
                                  comp.mutateAsync({ tenantId: r.tenantId, comped: false }),
                              })
                            }
                          >
                            Un-comp
                          </CapiroButton>
                        ) : (
                          <CapiroButton
                            size="compact"
                            onClick={() =>
                              confirm({
                                title: 'Grant complimentary access?',
                                body: 'This tenant will bypass payment and usage limits.',
                                okText: 'OK',
                                onOk: () =>
                                  comp.mutateAsync({ tenantId: r.tenantId, comped: true }),
                              })
                            }
                          >
                            Comp
                          </CapiroButton>
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
      </SvCard>

      {dialog}
    </div>
  );
}
