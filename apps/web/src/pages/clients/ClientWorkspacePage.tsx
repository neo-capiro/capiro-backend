import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BankOutlined,
  FilterOutlined,
  LinkOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  hasAtLeast,
  SECTOR_LABELS,
  SUBMISSION_TRACK_LABELS,
  normalizeSector,
  type SectorTag,
  type SubmissionTrack,
} from '@capiro/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Avatar,
  Button,
  Empty,
  Popover,
  Select,
  Skeleton,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import { BulkImportClientsModal } from './BulkImportClientsModal.js';
import { FirmOnboardingWizard } from './FirmOnboardingWizard.js';
import { ClientFormModal } from './ClientFormModal.js';
import { ClientProfilePage } from './ClientProfilePage.js';
import { getClientTargets, type ClientTarget } from './targets-api.js';
import type { Client, ClientFormSubmit } from './clientTypes.js';
import type { PortfolioSummary } from '../intelligence/types.js';

interface ClientFilterState {
  sectors: string[];
  requestTypes: string[];
}

export function ClientWorkspacePage() {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();

  // Deep-link support: other pages (e.g. the Meetings share confirmation) link
  // here as `/clients?clientId=<id>&tab=documents` — there's no `/clients/:id`
  // route, so opening a specific client's profile is query-param driven.
  useEffect(() => {
    const linkedId = searchParams.get('clientId');
    if (linkedId) setSelectedId(linkedId);
  }, [searchParams]);
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [firmImportOpen, setFirmImportOpen] = useState(false);
  const [filters, setFilters] = useState<ClientFilterState>({ sectors: [], requestTypes: [] });

  const canCreateClients = Boolean(me.data && hasAtLeast(me.data.role, 'standard_user'));
  const canManageClients = Boolean(me.data && hasAtLeast(me.data.role, 'user_admin'));
  const canRemoveClients = Boolean(me.data && hasAtLeast(me.data.role, 'standard_user'));

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
  });

  const portfolioSummary = useQuery<PortfolioSummary>({
    queryKey: ['portfolio-summary'],
    queryFn: async () =>
      (await api.get<PortfolioSummary>('/api/intelligence/portfolio-summary')).data,
    staleTime: 2 * 60 * 1000,
  });

  const selectedClient = useQuery<Client>({
    queryKey: ['client', selectedId],
    queryFn: async () => (await api.get<Client>(`/api/clients/${selectedId}`)).data,
    enabled: Boolean(selectedId),
  });

  const activeClients = useMemo(
    () => (clients.data ?? []).filter((client) => client.status !== 'archived'),
    [clients.data],
  );

  const filterOptions = useMemo(
    () => ({
      sectors: uniqueSectorOptions(activeClients),
      requestTypes: uniqueOptions(
        activeClients.map((client) =>
          readText(intakeRecord(client), ['requestType', 'request_type']),
        ),
      ),
    }),
    [activeClients],
  );

  const activeFilterCount = filters.sectors.length + filters.requestTypes.length;
  const hasFilterValues = Boolean(
    filterOptions.sectors.length || filterOptions.requestTypes.length,
  );

  const visibleClients = useMemo(() => {
    return activeClients
      .filter((client) => {
        const intake = intakeRecord(client);
        const sectorTag = resolveSectorTag(client);
        const requestType = readText(intake, ['requestType', 'request_type']);
        return (
          (!filters.sectors.length || (sectorTag ? filters.sectors.includes(sectorTag) : false)) &&
          (!filters.requestTypes.length ||
            (requestType ? filters.requestTypes.includes(requestType) : false))
        );
      })
      .sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      );
  }, [activeClients, filters]);

  const uploadClientLogo = async (clientId: string, file: File) => {
    const presigned = (
      await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
        `/api/clients/${clientId}/logo/upload-url`,
        { contentType: file.type, contentLength: file.size },
      )
    ).data;
    await uploadToS3(presigned, file);
    await api.post(`/api/clients/${clientId}/logo/confirm`, {
      s3Key: presigned.s3Key,
      contentType: file.type,
    });
  };

  const uploadClientDocuments = async (clientId: string, files: File[]) => {
    for (const file of files) {
      const presigned = (
        await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
          '/api/engagement/attachments/upload-url',
          {
            clientId,
            fileName: file.name,
            contentType: file.type || 'application/octet-stream',
            contentLength: file.size,
          },
        )
      ).data;
      await uploadToS3(presigned, file);
      await api.post('/api/engagement/attachments/confirm', {
        clientId,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        s3Key: presigned.s3Key,
      });
    }
  };

  const createClient = useMutation({
    mutationFn: async (submission: ClientFormSubmit) => {
      const created = (await api.post<Client>('/api/clients', submission.payload)).data;
      if (submission.logo) await uploadClientLogo(created.id, submission.logo);
      if (submission.documents.length)
        await uploadClientDocuments(created.id, submission.documents);
      return (await api.get<Client>(`/api/clients/${created.id}`)).data;
    },
    onSuccess: (created) => {
      message.success('Client added');
      setModalMode(null);
      setEditingClient(null);
      setSelectedId(created.id);
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const updateClient = useMutation({
    mutationFn: async ({ id, submission }: { id: string; submission: ClientFormSubmit }) => {
      const updated = (await api.put<Client>(`/api/clients/${id}`, submission.payload)).data;
      if (submission.logo) await uploadClientLogo(updated.id, submission.logo);
      if (submission.documents.length)
        await uploadClientDocuments(updated.id, submission.documents);
      return (await api.get<Client>(`/api/clients/${updated.id}`)).data;
    },
    onSuccess: (updated) => {
      message.success('Client updated');
      setModalMode(null);
      setEditingClient(null);
      setSelectedId(updated.id);
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['client', updated.id] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const archiveClient = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clients/${id}`)).data,
    onSuccess: () => {
      message.success('Client removed');
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const openCreate = () => {
    if (!canCreateClients) return;
    setEditingClient(null);
    setModalMode('create');
  };

  const openEdit = (client: Client) => {
    if (!canManageClients) return;
    setEditingClient(client);
    setModalMode('edit');
  };

  const confirmRemove = (client: Client) => {
    if (!canRemoveClients) return;
    modal.confirm({
      title: `Remove ${client.name}?`,
      content:
        'This archives the client for this tenant. The record can still be recovered from the database.',
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: () => archiveClient.mutateAsync(client.id),
    });
  };

  const clearFilters = () => setFilters({ sectors: [], requestTypes: [] });

  const filterContent = (
    <div className="client-filter-popover-content">
      <div className="client-filter-popover-head">
        <Typography.Text strong>Filter Clients</Typography.Text>
        {activeFilterCount ? (
          <Button type="link" size="small" onClick={clearFilters}>
            Clear All
          </Button>
        ) : null}
      </div>
      {hasFilterValues ? (
        <>
          <div className="client-filter-field">
            <Typography.Text>Sector</Typography.Text>
            <Select
              mode="multiple"
              allowClear
              placeholder="Any sector"
              maxTagCount="responsive"
              value={filters.sectors}
              options={filterOptions.sectors}
              onChange={(sectors) => setFilters((current) => ({ ...current, sectors }))}
            />
          </div>
          <div className="client-filter-field">
            <Typography.Text>Request Type</Typography.Text>
            <Select
              mode="multiple"
              allowClear
              placeholder="Any request type"
              maxTagCount="responsive"
              value={filters.requestTypes}
              options={filterOptions.requestTypes}
              onChange={(requestTypes) => setFilters((current) => ({ ...current, requestTypes }))}
            />
          </div>
        </>
      ) : (
        <Typography.Text type="secondary">
          No client fields available to filter yet.
        </Typography.Text>
      )}
    </div>
  );

  /* ── Profile view ── */
  if (selectedId) {
    if (selectedClient.isLoading) {
      return (
        <section className="client-page">
          <Skeleton active paragraph={{ rows: 10 }} />
        </section>
      );
    }
    if (!selectedClient.data) {
      return (
        <section className="client-page">
          <Button onClick={() => setSelectedId(null)}>Back to clients</Button>
          <Empty description="Client not found." />
        </section>
      );
    }
    return (
      <>
        <ClientProfilePage
          key={selectedClient.data.id}
          client={selectedClient.data}
          canManageClients={canManageClients}
          canRemoveClients={canRemoveClients}
          onBack={() => setSelectedId(null)}
          onEdit={openEdit}
          onRemove={confirmRemove}
          onUploadLogo={async (client, file) => {
            await uploadClientLogo(client.id, file);
            qc.invalidateQueries({ queryKey: ['client', client.id] });
            qc.invalidateQueries({ queryKey: ['clients'] });
          }}
          onClientUpdated={() => {
            qc.invalidateQueries({ queryKey: ['client', selectedId] });
            qc.invalidateQueries({ queryKey: ['clients'] });
          }}
        />
        <ClientFormModal
          open={Boolean(modalMode)}
          mode={modalMode ?? 'create'}
          client={editingClient}
          submitting={createClient.isPending || updateClient.isPending}
          onCancel={() => {
            setModalMode(null);
            setEditingClient(null);
          }}
          onSubmit={(submission) => {
            if (modalMode === 'edit' && editingClient) {
              updateClient.mutate({ id: editingClient.id, submission });
              return;
            }
            createClient.mutate(submission);
          }}
        />
      </>
    );
  }

  const activeCount = visibleClients.length;
  const totalActive = activeClients.length;

  /* ── List view ── */
  return (
    <>
      <section className="client-page redesign">
        <header className="portfolio-page-head">
          <div>
            <h1>Portfolio</h1>
            <div className="portfolio-meta">
              <b className="num">{totalActive}</b> active client{totalActive === 1 ? '' : 's'}
              {portfolioSummary.data ? (
                <>
                  {' · '}
                  <b className="num">
                    {formatCompactMoney(portfolioSummary.data.ldaSpendQtd)}
                  </b>{' '}
                  tracked LDA spend this quarter
                </>
              ) : null}
              {activeFilterCount ? (
                <>
                  {' · '}
                  <b className="num">{activeCount}</b> matching filters
                </>
              ) : null}
            </div>
          </div>
          <div className="client-action-bar">
            <Popover arrow={false} content={filterContent} placement="bottomRight" trigger="click">
              <Button
                icon={<FilterOutlined />}
                disabled={clients.isLoading || !activeClients.length}
              >
                {activeFilterCount ? `Filter (${activeFilterCount})` : 'Filter'}
              </Button>
            </Popover>
            <Button
              icon={<UploadOutlined />}
              disabled={!canCreateClients}
              onClick={() => setBulkImportOpen(true)}
            >
              Import CSV
            </Button>
            <Button
              icon={<BankOutlined />}
              disabled={!canCreateClients}
              onClick={() => setFirmImportOpen(true)}
            >
              Import from LDA
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!canCreateClients}
              onClick={openCreate}
            >
              New Client
            </Button>
          </div>
        </header>

        <PortfolioStrip
          summary={portfolioSummary.data}
          loading={portfolioSummary.isLoading}
          activeClientsFallback={totalActive}
        />

        {clients.isLoading ? (
          <div className="client-card-grid">
            {Array.from({ length: 3 }).map((_, index) => (
              <div className="client-card" key={index}>
                <Skeleton active paragraph={{ rows: 5 }} />
              </div>
            ))}
          </div>
        ) : visibleClients.length ? (
          <div className="client-card-grid">
            {visibleClients.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                onClick={() => setSelectedId(client.id)}
              />
            ))}
            <AddClientCard canCreateClients={canCreateClients} onClick={openCreate} />
          </div>
        ) : (
          <div className="client-empty-state">
            <Empty
              description={
                activeFilterCount ? 'No clients match these filters.' : 'No clients yet.'
              }
            />
            {activeFilterCount ? (
              <Button onClick={clearFilters}>Clear Filters</Button>
            ) : (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!canCreateClients}
                onClick={openCreate}
              >
                Add Client
              </Button>
            )}
          </div>
        )}
      </section>

      <ClientFormModal
        open={Boolean(modalMode)}
        mode={modalMode ?? 'create'}
        client={editingClient}
        submitting={createClient.isPending || updateClient.isPending}
        onCancel={() => {
          setModalMode(null);
          setEditingClient(null);
        }}
        onSubmit={(submission) => {
          if (modalMode === 'edit' && editingClient) {
            updateClient.mutate({ id: editingClient.id, submission });
            return;
          }
          createClient.mutate(submission);
        }}
      />

      <BulkImportClientsModal open={bulkImportOpen} onClose={() => setBulkImportOpen(false)} />

      <FirmOnboardingWizard
        open={firmImportOpen}
        onClose={() => setFirmImportOpen(false)}
        canManage={canManageClients}
      />
    </>
  );
}

function ClientCard({ client, onClick }: { client: Client; onClick: () => void }) {
  const intake = intakeRecord(client);
  const tags = portfolioTags(client).slice(0, 3);

  return (
    <article
      className="client-card"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onClick();
      }}
    >
      <div className="client-card-topline">
        <Avatar
          shape="square"
          size={48}
          src={client.logoUrl || undefined}
          alt={client.name}
          className="client-avatar"
        >
          {initials(client.name)}
        </Avatar>
        <div className="client-card-title">
          <Typography.Text strong>{client.name}</Typography.Text>
          {client.website ? (
            <a
              href={externalUrl(client.website)}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
            >
              <LinkOutlined /> {client.website}
            </a>
          ) : (
            <Typography.Text type="secondary">No website recorded</Typography.Text>
          )}
        </div>
      </div>

      <div className="client-card-details">
        <DetailPair label="Primary POC" value={formatPoc(intake, client.primaryContactName)} />
        <DetailPair label="Sector" value={sectorLabelFor(client) ?? readText(intake, ['sector'])} />
        <DetailPair label="Engagement" value={formatEngagement(intake, client.createdAt)} />
        <TargetsDetailRow clientId={client.id} />
      </div>

      <div className="client-tag-row">
        {tags.length ? tags.map((tag) => <Tag key={tag}>{tag}</Tag>) : <Tag>Intake pending</Tag>}
      </div>

      <div className="client-card-footer">
        <StatusPill status={client.status} />
        <Typography.Text type="secondary">Updated {relativeTime(client.updatedAt)}</Typography.Text>
      </div>
    </article>
  );
}

const STATUS_PILL_LABEL: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactive',
  prospect: 'Prospect',
  archived: 'Archived',
};

/** Small status chip shown bottom-left of each client card. */
function StatusPill({ status }: { status: string }) {
  const key = (status || '').toLowerCase();
  const label =
    STATUS_PILL_LABEL[key] ??
    (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown');
  return (
    <span className={`client-status-pill status-${key || 'unknown'}`}>
      <span className="client-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** "Sarah Kim, VP Gov't Affairs", falls back to whichever piece we have. */
function formatPoc(
  intake: Record<string, unknown>,
  fallbackName: string | null,
): string | undefined {
  const name = readText(intake, ['pocName']) ?? fallbackName ?? undefined;
  const title = readText(intake, ['pocTitle']);
  if (name && title) return `${name}, ${title}`;
  return name ?? title;
}

/** "Active · Since Jan 2026", status comes from intake, "since" from client.createdAt. */
function formatEngagement(intake: Record<string, unknown>, createdAt: string): string | undefined {
  const statusRaw = readText(intake, ['engagement']);
  const status = statusRaw ? statusRaw.charAt(0).toUpperCase() + statusRaw.slice(1) : undefined;
  const since = (() => {
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  })();
  if (status && since) return `${status} · Since ${since}`;
  return status ?? (since ? `Since ${since}` : undefined);
}

function AddClientCard({
  canCreateClients,
  onClick,
}: {
  canCreateClients: boolean;
  onClick: () => void;
}) {
  const card = (
    <button
      className="client-add-card"
      type="button"
      disabled={!canCreateClients}
      onClick={onClick}
      aria-label="Add new client"
    >
      <span className="client-add-icon">
        <PlusOutlined />
      </span>
      <Typography.Text strong>Add new client</Typography.Text>
    </button>
  );

  if (canCreateClients) return card;
  return <Tooltip title="Only signed-in tenant members can add clients.">{card}</Tooltip>;
}

function PortfolioStrip({
  summary,
  loading,
  activeClientsFallback,
}: {
  summary: PortfolioSummary | undefined;
  loading: boolean;
  activeClientsFallback: number;
}) {
  const cells: Array<{ label: string; value: string; tone?: 'accent' | 'notable' | 'critical' }> = [
    { label: 'Active clients', value: String(summary?.activeClients ?? activeClientsFallback) },
    {
      label: 'Need attention',
      value: String(summary?.needAttention ?? 0),
      tone: (summary?.needAttention ?? 0) > 0 ? 'notable' : undefined,
    },
    { label: 'LDA spend (QTD)', value: formatCompactMoney(summary?.ldaSpendQtd ?? 0) },
    { label: 'Active bills tracked', value: String(summary?.billsTracked ?? 0) },
    { label: 'Active regulations', value: String(summary?.activeRegulations ?? 0) },
  ];
  return (
    <div className="portfolio-strip">
      {cells.map((c) => (
        <div className="portfolio-strip-cell" key={c.label}>
          <span
            className="portfolio-strip-v num"
            style={
              c.tone === 'accent'
                ? { color: 'var(--accent-ink)' }
                : c.tone === 'notable'
                  ? { color: 'var(--notable)' }
                  : c.tone === 'critical'
                    ? { color: 'var(--critical)' }
                    : undefined
            }
          >
            {loading ? '-' : c.value}
          </span>
          <span className="portfolio-strip-l">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

function formatCompactMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

function DetailPair({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="client-detail-pair">
      <Typography.Text type="secondary">{label}</Typography.Text>
      <Typography.Text>{value || '-'}</Typography.Text>
    </div>
  );
}

/**
 * Portfolio card "Targets" row. Renders party-colored pills for up to 3 target
 * offices + a "+N more" overflow pill. The row is omitted entirely when the
 * client has no targets (keeps cards compact, matches the spec). Targets are
 * fetched per card; React Query dedupes against the Targets tab's own query.
 */
function TargetsDetailRow({ clientId }: { clientId: string }) {
  const api = useApi();
  const { data } = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', clientId],
    queryFn: async () => getClientTargets(api, clientId),
    staleTime: 60_000,
  });
  const targets = data ?? [];
  if (targets.length === 0) return null;

  const shown = targets.slice(0, 3);
  const extra = targets.length - shown.length;
  const titleFor = (chamber: string | null): string => (chamber === 'Senate' ? 'Sen.' : 'Rep.');
  const lastName = (name: string | null, memberId: string): string => {
    const n = name ?? memberId;
    const head = n.includes(', ') ? n.split(', ')[0]! : n;
    return head.split(' ').pop() ?? head;
  };

  return (
    <div className="client-detail-pair">
      <Typography.Text type="secondary">Targets</Typography.Text>
      <div className="tgt-pills">
        {shown.map((t) => (
          <span key={t.memberId} className={`tgt-pill ${t.party ?? 'I'}`}>
            <span className="tgt-pill-dot" aria-hidden="true" />
            {titleFor(t.chamber)} {lastName(t.memberName, t.memberId)}
            {t.party && t.state ? ` · ${t.party}-${t.state}` : ''}
          </span>
        ))}
        {extra > 0 ? <span className="tgt-pill more">+{extra} more</span> : null}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────
   Shared helpers (used by list view)
────────────────────────────────────────── */
function intakeRecord(client: Client): Record<string, unknown> {
  return toRecord(client.intakeData);
}

function portfolioTags(client: Client): string[] {
  const intake = intakeRecord(client);
  const tags: string[] = [];
  const sectorLabel = sectorLabelFor(client);
  if (sectorLabel) tags.push(sectorLabel);
  for (const track of client.submissionTracks ?? []) {
    const label = SUBMISSION_TRACK_LABELS[track as SubmissionTrack] ?? track;
    if (label) tags.push(label);
  }
  const explicit = readList(intake, ['portfolio', 'tags']);
  for (const t of explicit) if (!tags.includes(t)) tags.push(t);
  if (!tags.length) {
    const fallback = [
      readText(intake, ['requestType', 'request_type']),
      readText(intake, ['fundingAsk', 'funding_ask']),
    ].filter((item): item is string => Boolean(item));
    tags.push(...fallback);
  }
  return tags;
}

function resolveSectorTag(client: Client): string | undefined {
  if (client.sectorTag) return client.sectorTag;
  const intakeSector = readText(intakeRecord(client), ['sector']);
  if (!intakeSector) return undefined;
  return normalizeSector(intakeSector) ?? undefined;
}

function sectorLabelFor(client: Client): string | undefined {
  const tag = resolveSectorTag(client);
  if (!tag) return undefined;
  return SECTOR_LABELS[tag as SectorTag] ?? tag;
}

function uniqueSectorOptions(clients: Client[]): Array<{ label: string; value: string }> {
  const seen = new Map<string, string>();
  for (const client of clients) {
    const tag = resolveSectorTag(client);
    if (!tag) continue;
    if (!seen.has(tag)) seen.set(tag, SECTOR_LABELS[tag as SectorTag] ?? tag);
  }
  return Array.from(seen.entries())
    .sort(([, leftLabel], [, rightLabel]) => leftLabel.localeCompare(rightLabel))
    .map(([value, label]) => ({ label, value }));
}

function readList(record: Record<string, unknown>, keys: string[]): string[] {
  const raw = readFirst(record, keys);
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
      .filter(Boolean);
  }
  const text = readText(record, keys);
  return text
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readText(record: Record<string, unknown>, keys: string[]): string | undefined {
  const value = readFirst(record, keys);
  if (value == null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function uniqueOptions(values: Array<string | undefined>): Array<{ label: string; value: string }> {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]))
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ label: value, value }));
}

function readFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'CL';
  const first = parts[0] ?? '';
  const second = parts[1] ?? '';
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
}

function externalUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function uploadToS3(presigned: { url: string; fields: Record<string, string> }, file: File) {
  const form = new FormData();
  for (const [key, value] of Object.entries(presigned.fields)) form.append(key, value);
  form.append('file', file);
  const response = await fetch(presigned.url, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}

function relativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.max(0, Math.floor(diffMs / 86_400_000));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1d ago';
  if (diffDays < 30) return `${diffDays}d ago`;
  const d = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}
