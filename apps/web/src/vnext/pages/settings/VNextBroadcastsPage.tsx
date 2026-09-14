/**
 * Settings → Broadcasts (capiro_admin only). Compose a message to one
 * tenant — the whole firm or selected members — and track who has
 * acknowledged it. Users see pending broadcasts in VNextBroadcastAckGate
 * until they acknowledge; archiving a broadcast withdraws it from anyone who
 * has not yet acknowledged.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput, Combobox } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroSearchIcon } from '../../components/icons/index.js';
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
  SvPagination,
  SvProgress,
  SvSegmented,
  SvTextArea,
  useSvConfirm,
  useSvPagination,
} from './settings-ui.js';
import {
  broadcastKeys,
  memberDisplayName,
  type BroadcastAudience,
  type BroadcastDetail,
  type BroadcastSummary,
  type TenantMemberOption,
} from '../../broadcasts/broadcasts-api.js';

interface TenantOption {
  id: string;
  slug: string;
  name: string;
  status: string;
  _count: { memberships: number };
}

interface ComposeState {
  title: string;
  body: string;
  audience: BroadcastAudience;
  userIds: string[];
}

const EMPTY_COMPOSE: ComposeState = { title: '', body: '', audience: 'all_users', userIds: [] };
const TITLE_MAX = 200;
const BODY_MAX = 5000;

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function VNextBroadcastsPage() {
  const api = useApi();
  const [tenantId, setTenantId] = useState<string | undefined>();
  const [tenantSearch, setTenantSearch] = useState('');

  const tenants = useQuery<TenantOption[]>({
    queryKey: ['capiro-admin', 'tenants'],
    queryFn: async () => (await api.get('/api/capiro-admin/tenants')).data,
  });

  const tenantOptions = useMemo(() => {
    const q = tenantSearch.trim().toLowerCase();
    return (tenants.data ?? [])
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q))
      .map((t) => ({
        value: t.id,
        label: t.name,
        meta: `${t.slug} · ${t._count.memberships} member${t._count.memberships === 1 ? '' : 's'}`,
      }));
  }, [tenants.data, tenantSearch]);

  const tenant = tenants.data?.find((t) => t.id === tenantId);

  return (
    <div className="stv-stack">
      <div>
        <h2 className="stv-card__title" style={{ margin: 0 }}>
          Broadcasts
        </h2>
        <p className="stv-card__desc">
          Send a message to a tenant's users. It appears the next time each person signs in and
          stays until they acknowledge it; you can see who has and hasn't.
        </p>
      </div>

      <SvCard title="Tenant" description="Choose the firm this broadcast is for.">
        <div style={{ maxWidth: 420 }}>
          <Combobox
            value={tenantId}
            valueLabel={tenant ? tenant.name : undefined}
            onChange={(option) => setTenantId(option.value)}
            options={tenantOptions}
            loading={tenants.isLoading}
            placeholder="Choose a tenant"
            searchValue={tenantSearch}
            onSearchChange={setTenantSearch}
            searchPlaceholder="Search tenants"
            emptyMessage="No tenants match."
            leadingIcon={<CapiroSearchIcon size={1} />}
          />
        </div>
      </SvCard>

      {tenant ? (
        <TenantBroadcasts key={tenant.id} tenant={tenant} />
      ) : (
        <CapiroEmptyState
          title="Pick a tenant to get started"
          description="You'll be able to compose a new broadcast and review past ones."
        />
      )}
    </div>
  );
}

function TenantBroadcasts({ tenant }: { tenant: TenantOption }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [compose, setCompose] = useState<ComposeState>(EMPTY_COMPOSE);
  const [errors, setErrors] = useState<{ title?: string; body?: string; userIds?: string }>({});
  const [detailId, setDetailId] = useState<string | null>(null);

  const members = useQuery<TenantMemberOption[]>({
    queryKey: broadcastKeys.members(tenant.id),
    queryFn: async () =>
      (
        await api.get('/api/capiro-admin/broadcasts/tenant-members', {
          params: { tenantId: tenant.id },
        })
      ).data,
  });

  const broadcasts = useQuery<BroadcastSummary[]>({
    queryKey: broadcastKeys.list(tenant.id),
    queryFn: async () =>
      (await api.get('/api/capiro-admin/broadcasts', { params: { tenantId: tenant.id } })).data,
  });

  const create = useMutation({
    mutationFn: async (input: {
      tenantId: string;
      title: string;
      body: string;
      audience: BroadcastAudience;
      userIds?: string[];
    }) => (await api.post('/api/capiro-admin/broadcasts', input)).data as BroadcastDetail,
    onSuccess: (data) => {
      toast.success(`Broadcast sent to ${data.recipientCount} user${data.recipientCount === 1 ? '' : 's'}`);
      setCompose(EMPTY_COMPOSE);
      setErrors({});
      void qc.invalidateQueries({ queryKey: broadcastKeys.list(tenant.id) });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const memberRows = members.data ?? [];
  const recipientCount =
    compose.audience === 'all_users' ? memberRows.length : compose.userIds.length;

  const toggleUser = (userId: string, checked: boolean) =>
    setCompose((c) => ({
      ...c,
      userIds: checked ? [...c.userIds, userId] : c.userIds.filter((id) => id !== userId),
    }));

  const submit = () => {
    const next: typeof errors = {};
    const title = compose.title.trim();
    const body = compose.body.trim();
    if (!title) next.title = 'A title is required';
    if (!body) next.body = 'A message is required';
    if (compose.audience === 'selected_users' && compose.userIds.length === 0)
      next.userIds = 'Choose at least one user';
    if (compose.audience === 'all_users' && memberRows.length === 0)
      next.userIds = 'This tenant has no members to send to';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const payload = {
      tenantId: tenant.id,
      title,
      body,
      audience: compose.audience,
      ...(compose.audience === 'selected_users' ? { userIds: compose.userIds } : {}),
    };
    confirm({
      title: `Send to ${recipientCount} user${recipientCount === 1 ? '' : 's'} of ${tenant.name}?`,
      body: `"${title}" will appear to ${
        compose.audience === 'all_users' ? 'everyone in the firm' : 'the selected users'
      } the next time they sign in, and stays until each person acknowledges it.`,
      okText: 'Send now',
      onOk: () => create.mutateAsync(payload),
    });
  };

  const rows = broadcasts.data ?? [];
  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(rows, 10);

  return (
    <>
      <div className="stv-grid-2">
        <SvCard
          title="New broadcast"
          description={`Members of ${tenant.name} will see this after signing in.`}
        >
          <form
            className="stv-stack"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <CapiroInput
              label="Title"
              placeholder="Scheduled maintenance this Friday"
              maxLength={TITLE_MAX}
              error={errors.title}
              value={compose.title}
              onChange={(e) => setCompose((c) => ({ ...c, title: e.target.value }))}
            />
            <div>
              <SvTextArea
                label="Message"
                rows={6}
                maxLength={BODY_MAX}
                showCount
                placeholder="What do these users need to know?"
                value={compose.body}
                onChange={(body) => setCompose((c) => ({ ...c, body }))}
              />
              {errors.body ? <span className="capiro-field__error">{errors.body}</span> : null}
            </div>
            <div className="stv-stack stv-stack--tight">
              <span className="capiro-field__label">Recipients</span>
              <SvSegmented<BroadcastAudience>
                aria-label="Recipients"
                block
                value={compose.audience}
                onChange={(audience) => setCompose((c) => ({ ...c, audience }))}
                options={[
                  { label: `Entire firm (${memberRows.length})`, value: 'all_users' },
                  { label: 'Specific users', value: 'selected_users' },
                ]}
              />
              {compose.audience === 'selected_users' ? (
                <MemberChecklist
                  members={memberRows}
                  loading={members.isLoading}
                  selected={compose.userIds}
                  onToggle={toggleUser}
                  onSelectAll={() =>
                    setCompose((c) => ({ ...c, userIds: memberRows.map((m) => m.userId) }))
                  }
                  onClear={() => setCompose((c) => ({ ...c, userIds: [] }))}
                />
              ) : null}
              {errors.userIds ? <span className="capiro-field__error">{errors.userIds}</span> : null}
            </div>
            <div className="stv-row stv-row--between">
              <span className="stv-muted stv-small">
                {recipientCount} recipient{recipientCount === 1 ? '' : 's'}
              </span>
              <CapiroButton variant="primary" type="submit" loading={create.isPending}>
                Send broadcast
              </CapiroButton>
            </div>
          </form>
        </SvCard>

        <SvCard
          title="Sent broadcasts"
          description="Acknowledgement progress for every broadcast sent to this tenant."
          extra={
            <CapiroButton
              size="compact"
              onClick={() => broadcasts.refetch()}
              loading={broadcasts.isFetching}
            >
              Refresh
            </CapiroButton>
          }
        >
          {broadcasts.isLoading ? (
            <div className="stv-stack" aria-label="Loading broadcasts">
              <CapiroSkeleton height={16} />
              <CapiroSkeleton height={16} width="70%" />
            </div>
          ) : rows.length === 0 ? (
            <CapiroEmptyState
              title="No broadcasts yet"
              description={`Nothing has been sent to ${tenant.name}.`}
            />
          ) : (
            <>
              <CapiroTableWrap>
                <CapiroTable>
                  <CapiroTableHead>
                    <tr>
                      <CapiroTableHeaderCell>Title</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Recipients</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Acknowledged</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell>Sent</CapiroTableHeaderCell>
                      <CapiroTableHeaderCell />
                    </tr>
                  </CapiroTableHead>
                  <CapiroTableBody>
                    {pageRows.map((b) => (
                      <tr key={b.id}>
                        <CapiroTableCell>
                          <span className="stv-strong">{b.title}</span>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          {b.audience === 'all_users' ? 'Entire firm' : 'Selected'} · {b.recipientCount}
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <span className="stv-row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 140 }}>
                            <SvProgress
                              percent={
                                b.recipientCount === 0
                                  ? 0
                                  : (b.acknowledgedCount / b.recipientCount) * 100
                              }
                              tone={b.acknowledgedCount === b.recipientCount ? 'success' : undefined}
                              label={`${b.acknowledgedCount} of ${b.recipientCount} acknowledged`}
                            />
                            <span className="stv-small" style={{ whiteSpace: 'nowrap' }}>
                              {b.acknowledgedCount} / {b.recipientCount}
                            </span>
                          </span>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <BroadcastStatusBadge b={b} />
                        </CapiroTableCell>
                        <CapiroTableCell>{formatWhen(b.createdAt)}</CapiroTableCell>
                        <CapiroTableCell>
                          <CapiroButton size="compact" onClick={() => setDetailId(b.id)}>
                            View
                          </CapiroButton>
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
      </div>

      {detailId ? (
        <BroadcastDetailModal
          id={detailId}
          tenantId={tenant.id}
          onClose={() => setDetailId(null)}
        />
      ) : null}

      {dialog}
    </>
  );
}

function BroadcastStatusBadge({ b }: { b: BroadcastSummary }) {
  if (b.archivedAt) return <CapiroBadge tone="neutral">Archived</CapiroBadge>;
  if (b.recipientCount > 0 && b.acknowledgedCount === b.recipientCount)
    return <CapiroBadge tone="success">All acknowledged</CapiroBadge>;
  return <CapiroBadge tone="warning">Awaiting {b.recipientCount - b.acknowledgedCount}</CapiroBadge>;
}

function MemberChecklist({
  members,
  loading,
  selected,
  onToggle,
  onSelectAll,
  onClear,
}: {
  members: TenantMemberOption[];
  loading: boolean;
  selected: string[];
  onToggle: (userId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  if (loading) {
    return (
      <div className="stv-stack stv-stack--tight" aria-label="Loading members">
        <CapiroSkeleton height={14} />
        <CapiroSkeleton height={14} width="60%" />
      </div>
    );
  }
  if (members.length === 0) {
    return <CapiroEmptyState title="This tenant has no members yet." />;
  }
  return (
    <div className="stv-stack stv-stack--tight">
      <div className="stv-row stv-row--between">
        <span className="stv-muted stv-small">
          {selected.length} of {members.length} selected
        </span>
        <span className="stv-row" style={{ gap: 4 }}>
          <CapiroButton size="compact" onClick={onSelectAll}>
            Select all
          </CapiroButton>
          <CapiroButton size="compact" onClick={onClear} disabled={selected.length === 0}>
            Clear
          </CapiroButton>
        </span>
      </div>
      <div className="stv-checklist" role="group" aria-label="Choose recipients">
        {members.map((m) => {
          const checked = selected.includes(m.userId);
          const name = memberDisplayName(m);
          const subtitle = [name !== m.email ? m.email : null, m.status === 'invited' ? 'invited' : null]
            .filter(Boolean)
            .join(' · ');
          return (
            <label key={m.userId}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onToggle(m.userId, e.target.checked)}
              />
              <span style={{ display: 'grid', minWidth: 0 }}>
                <span className="stv-checklist__name">{name}</span>
                {subtitle ? <span className="stv-checklist__email">{subtitle}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function BroadcastDetailModal({
  id,
  tenantId,
  onClose,
}: {
  id: string;
  tenantId: string;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();

  const detail = useQuery<BroadcastDetail>({
    queryKey: broadcastKeys.detail(id),
    queryFn: async () => (await api.get(`/api/capiro-admin/broadcasts/${id}`)).data,
  });

  const archive = useMutation({
    mutationFn: async () => (await api.post(`/api/capiro-admin/broadcasts/${id}/archive`)).data,
    onSuccess: () => {
      toast.success('Broadcast archived. It no longer appears to users who had not acknowledged it.');
      void qc.invalidateQueries({ queryKey: broadcastKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: broadcastKeys.list(tenantId) });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const b = detail.data;
  const recipients = useMemo(() => {
    const list = [...(b?.recipients ?? [])];
    // Pending first, then alphabetical — the people you still need to chase.
    list.sort((x, y) => {
      const xa = x.acknowledgedAt ? 1 : 0;
      const ya = y.acknowledgedAt ? 1 : 0;
      if (xa !== ya) return xa - ya;
      return memberDisplayName(x).localeCompare(memberDisplayName(y));
    });
    return list;
  }, [b]);

  return (
    <CapiroModal open title={b?.title ?? 'Broadcast'} onClose={onClose}>
      <div className="stv-stack stv-modal-mid">
        {detail.isLoading || !b ? (
          <div className="stv-stack" aria-label="Loading broadcast">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : (
          <>
            <div className="stv-row" style={{ gap: 8 }}>
              <BroadcastStatusBadge b={b} />
              <span className="stv-muted stv-small">
                Sent {formatWhen(b.createdAt)}
                {b.createdBy ? ` by ${memberDisplayName(b.createdBy)}` : ''} ·{' '}
                {b.audience === 'all_users' ? 'entire firm' : 'selected users'}
                {b.archivedAt ? ` · archived ${formatWhen(b.archivedAt)}` : ''}
              </span>
            </div>
            <p className="stv-pre" style={{ margin: 0, fontFamily: 'inherit', fontSize: 'inherit' }}>
              {b.body}
            </p>
            <div className="stv-row stv-row--between">
              <span className="stv-subhead" style={{ margin: 0 }}>
                Recipients · {b.acknowledgedCount} of {b.recipientCount} acknowledged
              </span>
            </div>
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>Name</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Email</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Acknowledged</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {recipients.map((r) => (
                    <tr key={r.userId}>
                      <CapiroTableCell>{memberDisplayName(r)}</CapiroTableCell>
                      <CapiroTableCell>{r.email}</CapiroTableCell>
                      <CapiroTableCell>
                        {r.acknowledgedAt ? (
                          <CapiroBadge tone="success">Acknowledged</CapiroBadge>
                        ) : (
                          <CapiroBadge tone="warning">Pending</CapiroBadge>
                        )}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {r.acknowledgedAt ? formatWhen(r.acknowledgedAt) : <span className="stv-muted">—</span>}
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            <div className="stv-row stv-row--end">
              {!b.archivedAt ? (
                <CapiroButton
                  className="stv-btn-danger"
                  loading={archive.isPending}
                  onClick={() =>
                    confirm({
                      title: 'Archive this broadcast?',
                      body: `Users who haven't acknowledged "${b.title}" will stop seeing it. Acknowledgements already recorded are kept.`,
                      okText: 'Archive',
                      danger: true,
                      onOk: () => archive.mutateAsync(),
                    })
                  }
                >
                  Archive
                </CapiroButton>
              ) : null}
              <CapiroButton onClick={onClose}>Close</CapiroButton>
            </div>
          </>
        )}
        {dialog}
      </div>
    </CapiroModal>
  );
}
