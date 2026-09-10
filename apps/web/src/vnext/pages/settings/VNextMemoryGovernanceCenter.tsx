/**
 * vNext re-skin of components/MemoryGovernanceCenter.tsx — identical
 * endpoints, query keys, buckets, capability-gated actions and copy via
 * memory-governance-shared.ts. Administrator-only governed-memory
 * administration surface; every action is re-authorized by the server.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import {
  buildGovernanceActionRequest,
  governanceActionOutcomeMessage,
  governanceActionTitle,
  governanceAuthorityLabel,
  governanceBucketForTab,
  governanceErrorMessage,
  governanceHumanize as humanize,
  governanceStatusLabel,
  governanceWithActorNames as withActorNames,
  isGovernanceActivationKey,
  shouldRenderMemoryGovernanceCenter,
  type GovernanceActionValues,
  type GovernanceClient,
  type GovernanceConflictMember,
  type GovernanceDetailResponse,
  type GovernanceItem,
  type GovernanceItemAction,
  type GovernanceOverview,
  type GovernanceTabKey,
  type GovernanceTransition,
  type MemoryGrant,
  type ProjectionHealth,
} from '../../../components/memory-governance-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  SvCallout,
  SvCard,
  SvDescriptions,
  SvPagination,
  SvStat,
  SvTextArea,
  useSvPagination,
} from './settings-ui.js';
import { VNextMemoryProposalQueue } from './VNextMemoryProposalQueue.js';
import { VNextMemoryReviewQueue } from './VNextMemoryReviewQueue.js';

interface ActionState {
  kind: GovernanceItemAction;
  item: GovernanceItem;
}

export function VNextMemoryGovernanceCenter({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [tab, setTab] = useState<GovernanceTabKey>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');

  const overview = useQuery<GovernanceOverview>({
    queryKey: ['memory-governance-overview'],
    queryFn: async () => (await api.get<GovernanceOverview>('/api/memory/governance')).data,
    enabled: isAdmin,
    retry: 1,
    staleTime: 10_000,
  });

  const bucket = governanceBucketForTab(tab);
  const items = useQuery<{ enabled: boolean; items: GovernanceItem[] }>({
    queryKey: ['memory-governance-items', bucket, search],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; items: GovernanceItem[] }>(
          `/api/memory/governance/items?bucket=${bucket}&limit=250${search ? `&q=${encodeURIComponent(search)}` : ''}`,
        )
      ).data,
    enabled: shouldRenderMemoryGovernanceCenter(isAdmin, overview.data) && bucket !== null,
    staleTime: 10_000,
  });

  const detail = useQuery<GovernanceDetailResponse>({
    queryKey: ['memory-governance-item', selectedId],
    queryFn: async () =>
      (await api.get<GovernanceDetailResponse>(`/api/memory/governance/items/${selectedId}`)).data,
    enabled: Boolean(selectedId),
  });

  const transitions = useQuery<{ enabled: boolean; transitions: GovernanceTransition[] }>({
    queryKey: ['memory-governance-transitions'],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; transitions: GovernanceTransition[] }>(
          '/api/memory/governance/transitions?limit=250',
        )
      ).data,
    enabled: tab === 'transitions' && overview.data?.enabled === true,
  });

  const projection = useQuery<ProjectionHealth>({
    queryKey: ['memory-governance-projection'],
    queryFn: async () =>
      (await api.get<ProjectionHealth>('/api/memory/governance/projection-health')).data,
    enabled: tab === 'projection' && overview.data?.enabled === true,
  });

  const actionMutation = useMutation({
    mutationFn: async (input: { state: ActionState; values?: GovernanceActionValues }) => {
      const request = buildGovernanceActionRequest(
        input.state.kind,
        input.state.item.id,
        input.values,
      );
      return (await api.post<Record<string, unknown>>(request.path, request.body)).data;
    },
    onSuccess: (result, input) => {
      toast.success(governanceActionOutcomeMessage(input.state.kind, result));
      setAction(null);
      invalidateGovernance(qc, input.state.item.id);
    },
    onError: (error: unknown) => toast.error(governanceErrorMessage(error)),
  });

  const retryProjection = useMutation({
    mutationFn: async (jobId: string) =>
      (
        await api.post<Record<string, unknown>>(
          `/api/memory/governance/projection-jobs/${jobId}/retry`,
          {},
        )
      ).data,
    onSuccess: (result) => {
      toast.success(
        result.outcome === 'already_retryable'
          ? 'Projection job is already queued or running'
          : 'Projection retry queued',
      );
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-projection'] });
    },
    onError: (error: unknown) => toast.error(governanceErrorMessage(error)),
  });

  const openAction = (kind: GovernanceItemAction, item: GovernanceItem) => {
    if (kind === 'confirm' || kind === 'second_approve' || kind === 'restore') {
      actionMutation.mutate({ state: { kind, item } });
      return;
    }
    setAction({ kind, item });
  };

  if (!isAdmin) return null;
  if (overview.isLoading) {
    return (
      <SvCard aria-label="Loading Memory Governance Center">
        <div className="stv-stack">
          <CapiroSkeleton height={20} width="35%" />
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      </SvCard>
    );
  }
  if (overview.isError) {
    return <SvCallout kind="error" title="Memory Governance Center could not be loaded" />;
  }
  if (!overview.data?.enabled) return null;

  let body: ReactNode;
  if (tab === 'overview') {
    body = <GovernanceOverviewPanel overview={overview.data} />;
  } else if (tab === 'pending') {
    body = (
      <div className="stv-stack">
        <VNextMemoryReviewQueue />
        <VNextMemoryProposalQueue />
      </div>
    );
  } else if (tab === 'grants') {
    body = <MemoryGrantManager />;
  } else if (tab === 'transitions') {
    body = (
      <TransitionPanel data={transitions.data?.transitions ?? []} loading={transitions.isLoading} />
    );
  } else if (tab === 'projection') {
    body = (
      <ProjectionPanel
        data={projection.data}
        loading={projection.isLoading}
        retryingId={retryProjection.variables ?? null}
        onRetry={(id) => retryProjection.mutate(id)}
      />
    );
  } else {
    body = (
      <div className="stv-stack">
        <form
          className="stv-row"
          onSubmit={(event) => {
            event.preventDefault();
            const next = searchDraft.trim();
            if (next === search) void items.refetch();
            else setSearch(next);
          }}
        >
          <CapiroInput
            label="Search memory by title"
            placeholder="Search memory by title"
            maxLength={200}
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          <CapiroButton type="submit">Search</CapiroButton>
          {search && (
            <CapiroButton
              type="button"
              variant="secondary"
              onClick={() => {
                setSearchDraft('');
                setSearch('');
              }}
            >
              Clear search
            </CapiroButton>
          )}
        </form>
        <p className="stv-muted">Search checks matching titles beyond the displayed list.</p>
        {items.isError ? (
          <SvCallout
            kind="error"
            title="Memory items could not be loaded"
            description="Refresh or try the search again."
          />
        ) : (
          <MemoryItemTable
            key={`${bucket}:${search}`}
            items={items.data?.items ?? []}
            loading={items.isLoading}
            onOpen={setSelectedId}
          />
        )}
      </div>
    );
  }

  return (
    <SvCard
      aria-label="Memory Governance Center"
      title="Memory Governance Center"
      description="Review institutional truth, permissions, conflicts, history, and projection health. Every action is re-authorized by the server."
    >
      <div className="stv-stack">
        <CapiroTabs
          label="Memory governance sections"
          activeId={tab}
          onChange={(key) => setTab(key as GovernanceTabKey)}
          items={governanceTabs(overview.data).map((item) => ({ id: item.key, label: item.label }))}
        />
        {body}
      </div>

      <MemoryDetailDrawer
        data={detail.data?.item ?? null}
        loading={detail.isLoading}
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        onAction={openAction}
      />

      <GovernanceActionModal
        state={action}
        pending={actionMutation.isPending}
        onCancel={() => setAction(null)}
        onSubmit={(values) => {
          if (!action) return;
          actionMutation.mutate({ state: action, values });
        }}
        conflictMembers={detail.data?.item?.conflictMembers ?? []}
      />
    </SvCard>
  );
}

function GovernanceOverviewPanel({ overview }: { overview: GovernanceOverview }) {
  const stats = [
    ['Active', overview.counts.active],
    ['Pending review', overview.counts.pendingReview],
    ['Conflicts', overview.counts.conflicts],
    ['Review due', overview.counts.reviewDue],
    ['History', overview.counts.history],
    ['Active grants', overview.counts.activeGrants],
    ['Projection attention', overview.counts.projectionAttention],
  ] as const;
  return (
    <div className="stv-row" style={{ gap: 12 }}>
      {stats.map(([title, value]) => (
        <SvCard key={title}>
          <SvStat label={title} value={value} />
        </SvCard>
      ))}
    </div>
  );
}

function MemoryItemTable({
  items,
  loading,
  onOpen,
}: {
  items: GovernanceItem[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(items, 25);
  const activate = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (!isGovernanceActivationKey(event.key)) return;
    event.preventDefault();
    onOpen(id);
  };
  if (loading) {
    return (
      <div className="stv-stack" aria-label="Loading memory items">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>
    );
  }
  if (items.length === 0) return <CapiroEmptyState title="No memory in this category" />;
  return (
    <>
      <CapiroTableWrap>
        <CapiroTable>
          <CapiroTableHead>
            <tr>
              <CapiroTableHeaderCell>Memory</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>Class / authority</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>State</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>Review due</CapiroTableHeaderCell>
              <CapiroTableHeaderCell>Updated</CapiroTableHeaderCell>
            </tr>
          </CapiroTableHead>
          <CapiroTableBody>
            {pageRows.map((item) => (
              <tr
                key={item.id}
                tabIndex={0}
                role="button"
                aria-label={`Open memory ${item.title}`}
                style={{ cursor: 'pointer' }}
                onClick={() => onOpen(item.id)}
                onKeyDown={(event) => activate(event, item.id)}
              >
                <CapiroTableCell>
                  <span className="stv-strong">{item.title}</span>
                  <div className="stv-muted stv-small">{item.clientName ?? item.memoryScope}</div>
                </CapiroTableCell>
                <CapiroTableCell>
                  {humanize(item.memoryClass)}
                  <div className="stv-muted stv-small">
                    {governanceAuthorityLabel(item.memoryAuthority)}
                  </div>
                </CapiroTableCell>
                <CapiroTableCell>
                  <CapiroBadge>{governanceStatusLabel(item.governedStatus)}</CapiroBadge>
                </CapiroTableCell>
                <CapiroTableCell>{dateText(item.reviewDueAt)}</CapiroTableCell>
                <CapiroTableCell>{dateText(item.updatedAt)}</CapiroTableCell>
              </tr>
            ))}
          </CapiroTableBody>
        </CapiroTable>
      </CapiroTableWrap>
      <SvPagination currentPage={currentPage} pageCount={pageCount} onPage={setPage} />
    </>
  );
}

function MemoryDetailDrawer({
  data,
  loading,
  open,
  onClose,
  onAction,
}: {
  data: GovernanceDetailResponse['item'];
  loading: boolean;
  open: boolean;
  onClose: () => void;
  onAction: (kind: GovernanceItemAction, item: GovernanceItem) => void;
}) {
  if (!open && !loading) return null;
  return (
    <CapiroDrawer open={open || loading} title={data?.title ?? 'Memory detail'} onClose={onClose}>
      <div className="stv-drawer-wide" />
      {loading && (
        <div className="stv-stack" aria-label="Loading memory detail">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      )}
      {!loading && data && (
        <div className="stv-stack">
          <div className="stv-row">{renderActions(data, onAction)}</div>
          <SvDescriptions
            items={[
              { label: 'Scope', value: data.clientName ?? humanize(data.memoryScope) },
              { label: 'Status', value: governanceStatusLabel(data.governedStatus) },
              { label: 'Class', value: humanize(data.memoryClass) },
              { label: 'Authority', value: governanceAuthorityLabel(data.memoryAuthority) },
              { label: 'Confidence', value: data.confidence ?? 'Unscored' },
              { label: 'Legal hold', value: data.legalHold ? 'Yes' : 'No' },
              { label: 'Conflict', value: humanize(data.conflictStatus) },
              { label: 'Review state', value: humanize(data.reviewState) },
            ]}
          />

          <DetailBlock title="Content">
            {data.sections.length === 0 ? (
              <CapiroEmptyState title="No rendered sections" />
            ) : (
              data.sections.map((section, index) => (
                <div key={section.key ?? index}>
                  <span className="stv-strong">{section.heading ?? `Section ${index + 1}`}</span>
                  <p className="stv-prewrap">{section.body || '—'}</p>
                </div>
              ))
            )}
          </DetailBlock>
          <MemorySourceEvidence evidence={data.sourceEvidence} />
          <ObjectDescriptions title="Provenance" value={data.provenance} />
          <ObjectDescriptions
            title="Approvals"
            value={withActorNames(data.approvals, data.actors)}
          />
          <ObjectDescriptions title="Temporal validity" value={data.temporal} />
          <ObjectDescriptions
            title="Governance"
            value={withActorNames(data.governance, data.actors)}
          />
          <ObjectDescriptions title="Origin trace" value={data.origin} />

          <DetailBlock title="Versions">
            {data.versions.length === 0 ? (
              <span className="stv-muted">No version lineage</span>
            ) : (
              <div className="stv-stack stv-stack--tight">
                {data.versions.map((version) => (
                  <div key={version.id}>
                    <span className="stv-strong">{String(version.title ?? version.id)}</span>
                    <div className="stv-muted stv-small">
                      {governanceStatusLabel(String(version.governedStatus ?? ''))} ·{' '}
                      {dateText(String(version.createdAt))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DetailBlock>

          <DetailBlock title="Conflict control">
            {data.conflictMembers.length === 0 ? (
              <span className="stv-muted">No conflict group</span>
            ) : (
              <div className="stv-stack stv-stack--tight">
                {data.conflictMembers.map((member) => (
                  <div className="stv-row" key={member.id}>
                    <span>{member.title}</span>
                    <CapiroBadge>{humanize(member.conflictStatus)}</CapiroBadge>
                    {member.controllingItemId === member.id && (
                      <CapiroBadge tone="success">Controlling</CapiroBadge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </DetailBlock>

          <DetailBlock title="Transition history">
            {data.transitions.length === 0 ? (
              <span className="stv-muted">No transition evidence</span>
            ) : (
              <div className="stv-stack stv-stack--tight">
                {data.transitions.map((transition) => (
                  <div key={transition.id}>
                    <span className="stv-strong">
                      {humanize(String(transition.reasonCode ?? 'transition'))}
                    </span>
                    <div>{String(transition.reason ?? '')}</div>
                    <div className="stv-muted stv-small">
                      {dateText(String(transition.occurredAt))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DetailBlock>

          <DetailBlock title="Projection state">
            {data.projection.length === 0 ? (
              <span className="stv-muted">No projection obligations</span>
            ) : (
              <div className="stv-stack stv-stack--tight">
                {data.projection.map((job) => (
                  <div className="stv-row" key={job.id}>
                    <CapiroBadge>{governanceStatusLabel(String(job.status ?? ''))}</CapiroBadge>
                    <span>{humanize(String(job.operation ?? 'projection'))}</span>
                    {typeof job.lastError === 'string' && job.lastError ? (
                      <span className="stv-danger-text">{job.lastError}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </DetailBlock>
        </div>
      )}
    </CapiroDrawer>
  );
}

function renderActions(
  item: GovernanceItem,
  onAction: (kind: GovernanceItemAction, item: GovernanceItem) => void,
) {
  const actions: Array<[boolean, GovernanceItemAction, string, boolean?]> = [
    [item.capabilities.confirm, 'confirm', 'Confirm'],
    [item.capabilities.markStale, 'mark_stale', 'Mark stale'],
    [item.capabilities.secondApprove, 'second_approve', 'Second approve'],
    [item.capabilities.proposeCorrection, 'correction', 'Suggest correction'],
    [item.capabilities.restore, 'restore', 'Restore as new version'],
    [item.capabilities.resolveConflict, 'resolve_conflict', 'Resolve conflict'],
    [item.capabilities.revoke, 'revoke', 'Revoke', true],
  ];
  return actions
    .filter(([visible]) => visible)
    .map(([, kind, label, danger]) => (
      <CapiroButton
        key={kind}
        size="compact"
        className={danger ? 'stv-btn-danger' : undefined}
        onClick={() => onAction(kind, item)}
      >
        {label}
      </CapiroButton>
    ));
}

function GovernanceActionModal({
  state,
  pending,
  onCancel,
  onSubmit,
  conflictMembers,
}: {
  state: ActionState | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: GovernanceActionValues) => void;
  conflictMembers: GovernanceConflictMember[];
}) {
  const [reason, setReason] = useState('');
  const [content, setContent] = useState('');
  const [controllingItemId, setControllingItemId] = useState('');
  const [error, setError] = useState<string | undefined>();

  if (!state) return null;
  const kind = state.kind;

  const submit = () => {
    if (kind === 'correction' && !content.trim()) {
      setError('Corrected content is required.');
      return;
    }
    if (kind === 'resolve_conflict' && !controllingItemId) {
      setError('Select the controlling memory.');
      return;
    }
    if (
      (kind === 'mark_stale' || kind === 'revoke' || kind === 'resolve_conflict') &&
      !reason.trim()
    ) {
      setError('A reason is required.');
      return;
    }
    setError(undefined);
    onSubmit({
      ...(kind === 'correction' ? { content } : {}),
      ...(kind === 'resolve_conflict' ? { controllingItemId } : {}),
      ...(kind !== 'correction' ? { reason } : {}),
    });
  };

  return (
    <CapiroModal open title={governanceActionTitle(kind)} onClose={onCancel}>
      <div className="stv-stack">
        {kind === 'correction' && (
          <SvTextArea
            label="Corrected memory"
            rows={8}
            maxLength={20_000}
            showCount
            value={content}
            onChange={setContent}
          />
        )}
        {kind === 'resolve_conflict' && (
          <CapiroSelect
            label="Controlling memory"
            value={controllingItemId}
            onChange={(event) => setControllingItemId(event.target.value)}
            options={[
              { value: '', label: 'Select the controlling memory' },
              ...conflictMembers.map((member) => ({ value: member.id, label: member.title })),
            ]}
          />
        )}
        {(kind === 'mark_stale' || kind === 'revoke' || kind === 'resolve_conflict') && (
          <SvTextArea
            label="Reason"
            rows={4}
            maxLength={500}
            showCount
            value={reason}
            onChange={setReason}
          />
        )}
        {error ? <span className="capiro-field__error">{error}</span> : null}
        <div className="stv-row stv-row--end">
          <CapiroButton onClick={onCancel} disabled={pending}>
            Cancel
          </CapiroButton>
          <CapiroButton
            variant="primary"
            className={kind === 'revoke' ? 'stv-btn-danger' : undefined}
            loading={pending}
            onClick={submit}
          >
            {kind === 'revoke' ? 'Revoke memory' : 'Submit'}
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}

function MemoryGrantManager() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [clientId, setClientId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{
    userId: string;
    permissions: string[];
    reason: string;
    expiresAt: string;
  }>({ userId: '', permissions: [], reason: '', expiresAt: '' });
  const [formError, setFormError] = useState<string | undefined>();

  const clients = useQuery<{ enabled: boolean; clients: GovernanceClient[] }>({
    queryKey: ['memory-governance-clients'],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; clients: GovernanceClient[] }>(
          '/api/memory/governance/clients',
        )
      ).data,
  });
  const permissions = useQuery<{ permissions: string[] }>({
    queryKey: ['memory-grant-permissions'],
    queryFn: async () =>
      (await api.get<{ permissions: string[] }>('/api/memory/grants/permissions')).data,
  });
  const grants = useQuery<{ grants: MemoryGrant[] }>({
    queryKey: ['memory-client-grants', clientId],
    queryFn: async () =>
      (await api.get<{ grants: MemoryGrant[] }>(`/api/memory/clients/${clientId}/grants`)).data,
    enabled: Boolean(clientId),
  });

  const createGrant = useMutation({
    mutationFn: async (values: typeof form) => {
      if (!clientId) throw new Error('Select a client.');
      const expiresAt = new Date(values.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()))
        throw new Error('Expiration must be a valid date.');
      return (
        await api.post(`/api/memory/clients/${clientId}/grants`, {
          ...values,
          expiresAt: expiresAt.toISOString(),
        })
      ).data;
    },
    onSuccess: () => {
      toast.success('Memory access grant created');
      setOpen(false);
      setForm({ userId: '', permissions: [], reason: '', expiresAt: '' });
      qc.invalidateQueries({ queryKey: ['memory-client-grants', clientId] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
    },
    onError: (error: unknown) => toast.error(governanceErrorMessage(error)),
  });

  const revokeGrant = useMutation({
    mutationFn: async (userId: string) => {
      if (!clientId) throw new Error('Select a client.');
      return (await api.delete(`/api/memory/clients/${clientId}/grants/${userId}`)).data;
    },
    onSuccess: () => {
      toast.success('Memory access grant revoked');
      qc.invalidateQueries({ queryKey: ['memory-client-grants', clientId] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
    },
    onError: (error: unknown) => toast.error(governanceErrorMessage(error)),
  });

  const submitGrant = () => {
    if (
      !form.userId.trim() ||
      form.permissions.length === 0 ||
      !form.reason.trim() ||
      !form.expiresAt
    ) {
      setFormError('User ID, permissions, reason and expiration are required.');
      return;
    }
    setFormError(undefined);
    createGrant.mutate(form);
  };

  return (
    <div className="stv-stack">
      <div className="stv-row">
        <span style={{ minWidth: 280 }}>
          <CapiroSelect
            label="Client"
            value={clientId ?? ''}
            onChange={(event) => setClientId(event.target.value || null)}
            options={[
              { value: '', label: 'Select a client' },
              ...(clients.data?.clients ?? []).map((client) => ({
                value: client.id,
                label: `${client.name}${client.memoryWall ? ' · Ethical wall' : ''}`,
              })),
            ]}
          />
        </span>
        <span style={{ marginTop: 24 }}>
          <CapiroButton variant="primary" disabled={!clientId} onClick={() => setOpen(true)}>
            Add grant
          </CapiroButton>
        </span>
      </div>
      {!clientId ? (
        <CapiroEmptyState title="Select a client to manage grants" />
      ) : grants.isLoading ? (
        <div className="stv-stack" aria-label="Loading grants">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : (
        <CapiroTableWrap>
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell>User ID</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Permissions</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Expires</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Reason</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {(grants.data?.grants ?? []).map((grant) => (
                <tr key={grant.id}>
                  <CapiroTableCell>{grant.userId}</CapiroTableCell>
                  <CapiroTableCell>
                    <span className="stv-row" style={{ gap: 4 }}>
                      {grant.permissions.map((value) => (
                        <CapiroBadge key={value}>{humanize(value)}</CapiroBadge>
                      ))}
                    </span>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <CapiroBadge>{humanize(grant.status)}</CapiroBadge>
                  </CapiroTableCell>
                  <CapiroTableCell>{dateText(grant.expiresAt)}</CapiroTableCell>
                  <CapiroTableCell>{grant.reason}</CapiroTableCell>
                  <CapiroTableCell>
                    {grant.status === 'active' ? (
                      <CapiroButton
                        size="compact"
                        className="stv-btn-danger"
                        onClick={() => revokeGrant.mutate(grant.userId)}
                      >
                        Revoke
                      </CapiroButton>
                    ) : null}
                  </CapiroTableCell>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      )}
      {open ? (
        <CapiroModal open title="Grant client memory access" onClose={() => setOpen(false)}>
          <div className="stv-stack">
            <CapiroInput
              label="Active tenant member user ID"
              value={form.userId}
              onChange={(event) => setForm((c) => ({ ...c, userId: event.target.value }))}
            />
            <div>
              <span className="capiro-field__label" style={{ display: 'block', marginBottom: 6 }}>
                Permissions
              </span>
              <select
                multiple
                className="capiro-select"
                style={{ minHeight: 88, width: '100%' }}
                aria-label="Permissions"
                value={form.permissions}
                onChange={(event) =>
                  setForm((c) => ({
                    ...c,
                    permissions: Array.from(event.target.selectedOptions).map((o) => o.value),
                  }))
                }
              >
                {(permissions.data?.permissions ?? []).map((value) => (
                  <option key={value} value={value}>
                    {humanize(value)}
                  </option>
                ))}
              </select>
            </div>
            <SvTextArea
              label="Reason"
              rows={3}
              maxLength={500}
              showCount
              value={form.reason}
              onChange={(reason) => setForm((c) => ({ ...c, reason }))}
            />
            <CapiroInput
              label="Expires at"
              type="datetime-local"
              value={form.expiresAt}
              onChange={(event) => setForm((c) => ({ ...c, expiresAt: event.target.value }))}
            />
            {formError ? <span className="capiro-field__error">{formError}</span> : null}
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setOpen(false)}>Cancel</CapiroButton>
              <CapiroButton variant="primary" loading={createGrant.isPending} onClick={submitGrant}>
                Submit
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}
    </div>
  );
}

function TransitionPanel({ data, loading }: { data: GovernanceTransition[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="stv-stack" aria-label="Loading transitions">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>
    );
  }
  if (data.length === 0) return <CapiroEmptyState title="No transition evidence" />;
  return (
    <div className="stv-stack stv-stack--tight">
      {data.map((transition) => (
        <div
          key={transition.id}
          style={{ padding: '8px 0', borderBottom: '1px solid var(--stv-border)' }}
        >
          <span className="stv-strong">{humanize(transition.reasonCode)}</span>
          <div>{transition.reason}</div>
          <div className="stv-muted stv-small">
            {transition.fromStatus ? `${governanceStatusLabel(transition.fromStatus)} → ` : ''}
            {governanceStatusLabel(transition.toStatus)} · {dateText(transition.occurredAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectionPanel({
  data,
  loading,
  retryingId,
  onRetry,
}: {
  data: ProjectionHealth | undefined;
  loading: boolean;
  retryingId: string | null;
  onRetry: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="stv-stack" aria-label="Loading projection health">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>
    );
  }
  if (!data) return <CapiroEmptyState title="Projection health unavailable" />;
  return (
    <div className="stv-stack">
      <div className="stv-row" style={{ gap: 12 }}>
        {Object.entries(data.counts).map(([key, value]) => (
          <SvCard key={key}>
            <SvStat label={humanize(key)} value={value} />
          </SvCard>
        ))}
      </div>
      {(data.counts.failed > 0 || data.counts.deadLetter > 0) && (
        <SvCallout
          kind="error"
          title="Projection work needs attention"
          description="Canonical memory remains authoritative; failed secondary projections are retained for authorized retry or investigation."
        />
      )}
      {data.recentFailures.length === 0 ? (
        <span className="stv-muted">No recent projection failures</span>
      ) : (
        <div className="stv-stack stv-stack--tight">
          {data.recentFailures.map((failure) => (
            <div className="stv-row stv-row--between stv-row--start" key={failure.id}>
              <div>
                <span className="stv-strong">
                  {failure.title ?? failure.memoryItemId ?? failure.id}
                </span>
                <div>
                  {humanize(failure.operation)} · {governanceStatusLabel(failure.status)}
                </div>
                <div className="stv-danger-text">
                  {failure.lastError ?? 'Unknown projection error'}
                </div>
              </div>
              <CapiroButton
                size="compact"
                loading={retryingId === failure.id}
                onClick={() => onRetry(failure.id)}
              >
                Retry
              </CapiroButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Original evidence is separate from the approved body and has no write action. */
export function MemorySourceEvidence({
  evidence,
}: {
  evidence: NonNullable<GovernanceDetailResponse['item']>['sourceEvidence'];
}) {
  if (!evidence) return null;
  return (
    <DetailBlock title="Original source for correction">
      <p>{evidence.explanation}</p>
      {evidence.status === 'available' && (
        <>
          <span className="stv-strong">Accepted client finding</span>
          <p className="stv-prewrap">{evidence.factText}</p>
          {evidence.acceptedAt && (
            <p className="stv-muted">Accepted {dateText(evidence.acceptedAt)}</p>
          )}
          {Boolean(evidence.links?.length) && (
            <ul>
              {evidence.links!.map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </DetailBlock>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="stv-card__title" style={{ marginBottom: 8 }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function ObjectDescriptions({ title, value }: { title: string; value: Record<string, unknown> }) {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== null && item !== undefined && item !== '',
  );
  return (
    <DetailBlock title={title}>
      {entries.length === 0 ? (
        <span className="stv-muted">No recorded values</span>
      ) : (
        <SvDescriptions
          items={entries.map(([key, item]) => ({
            label: humanize(key),
            value: typeof item === 'object' ? JSON.stringify(item) : dateOrText(item),
          }))}
        />
      )}
    </DetailBlock>
  );
}

function governanceTabs(overview: GovernanceOverview) {
  return [
    { key: 'overview', label: 'Overview' },
    { key: 'active', label: `Active (${overview.counts.active})` },
    { key: 'pending', label: `Pending review (${overview.counts.pendingReview})` },
    { key: 'conflicts', label: `Conflicts (${overview.counts.conflicts})` },
    { key: 'review_due', label: `Review due (${overview.counts.reviewDue})` },
    { key: 'history', label: `History (${overview.counts.history})` },
    { key: 'grants', label: `Access grants (${overview.counts.activeGrants})` },
    { key: 'transitions', label: 'Transition history' },
    { key: 'projection', label: `Projection health (${overview.counts.projectionAttention})` },
  ] as Array<{ key: GovernanceTabKey; label: string }>;
}

function invalidateGovernance(qc: QueryClient, itemId: string): void {
  qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
  qc.invalidateQueries({ queryKey: ['memory-governance-items'] });
  qc.invalidateQueries({ queryKey: ['memory-governance-item', itemId] });
  qc.invalidateQueries({ queryKey: ['memory-governance-transitions'] });
  qc.invalidateQueries({ queryKey: ['memory-governance-projection'] });
  qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
  qc.invalidateQueries({ queryKey: ['memory-own-proposals'] });
  qc.invalidateQueries({ queryKey: ['memory-item'] });
}

function dateText(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
}

function dateOrText(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  const date = new Date(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : value;
}
