import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';

const { Text } = Typography;

interface ClientIntelMapping {
  id: string;
  clientId: string;
  clientName: string;
  source: string;
  externalId: string;
  externalName: string;
  confidence: number;
  confirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ResolutionSummary {
  totalClients: number;
  mappingsCreated: number;
  autoConfirmed: number;
  needsReview: number;
}

/**
 * The mapping-source vocabulary, in one place.
 *
 * Used by the manual-attach picker AND by the empty state's copy, which names
 * the source the list is filtered to. Two hand-copied label lists would drift.
 * `MappingSource` is declared further down; TS hoists the type.
 */
const MAPPING_SOURCE_OPTIONS: Array<{ label: string; value: MappingSource }> = [
  { label: 'LDA registrant (issue codes)', value: 'lda' },
  { label: 'FEC employer (contributions)', value: 'fec_employer' },
  { label: 'Federal contractor (contracts)', value: 'contracting' },
  { label: 'Assistance recipient (grants)', value: 'assistance_recipient' },
];

/** The `?source=` value as a MappingSource, or undefined when it is not one. */
function asMappingSource(raw: string | null | undefined): MappingSource | undefined {
  return MAPPING_SOURCE_OPTIONS.find((o) => o.value === raw)?.value;
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.85) return '#52c41a';
  if (confidence >= 0.5) return '#faad14';
  return '#ff4d4f';
}

export function IntelligenceMappingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [searchParams] = useSearchParams();
  const [clientSearch, setClientSearch] = useState('');
  // Seed the source filter from the URL (?source=fec_employer) so deep links
  // from the intel profile panels (e.g. the FEC "Map an FEC employer →" CTA)
  // land the user directly on the rows they need to confirm.
  const [sourceFilter, setSourceFilter] = useState<string | undefined>(
    searchParams.get('source') ?? undefined,
  );
  const [confirmedFilter, setConfirmedFilter] = useState<'all' | 'confirmed' | 'unconfirmed'>('all');
  const [manualOpen, setManualOpen] = useState(false);
  // Human-readable name of the source the list is filtered to, for the empty
  // state's copy. Undefined when unfiltered or when ?source= is not a real source.
  const sourceFilterLabel = MAPPING_SOURCE_OPTIONS.find((o) => o.value === sourceFilter)?.label;

  const mappingsQuery = useQuery<ClientIntelMapping[]>({
    queryKey: ['intelligence-mappings'],
    queryFn: async () =>
      (await api.get<ClientIntelMapping[]>('/api/intelligence/mappings')).data,
    staleTime: 30_000,
  });

  const resolveAllMutation = useMutation({
    mutationFn: async () =>
      (await api.post<ResolutionSummary>('/api/intelligence/resolve-all')).data,
    onSuccess: (summary) => {
      notification.success({
        message: 'Resolution complete',
        description: `${summary.mappingsCreated} mappings · ${summary.autoConfirmed} auto-confirmed · ${summary.needsReview} need review · ${summary.totalClients} clients processed`,
        duration: 6,
      });
      void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
      invalidateClientIntel(qc);
    },
    onError: (err) => {
      const detail = apiErrorMessage(err);
      notification.error({ message: 'Resolution failed', description: detail });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async ({ id, confirmed }: { id: string; confirmed: boolean }) =>
      api.patch(`/api/intelligence/mappings/${id}`, { confirmed }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
      invalidateClientIntel(qc);
    },
    onError: (err) => {
      notification.error({ message: 'Update failed', description: apiErrorMessage(err) });
    },
  });

  const mappings = mappingsQuery.data ?? [];

  const distinctSources = useMemo(
    () => [...new Set(mappings.map((m) => m.source))].sort(),
    [mappings],
  );

  const filtered = useMemo(() => {
    let data = mappings;
    if (clientSearch.trim()) {
      const q = clientSearch.trim().toLowerCase();
      data = data.filter(
        (m) =>
          m.clientName.toLowerCase().includes(q) ||
          m.externalName.toLowerCase().includes(q),
      );
    }
    if (sourceFilter) data = data.filter((m) => m.source === sourceFilter);
    if (confirmedFilter === 'confirmed') data = data.filter((m) => m.confirmed);
    if (confirmedFilter === 'unconfirmed') data = data.filter((m) => !m.confirmed);
    return data;
  }, [mappings, clientSearch, sourceFilter, confirmedFilter]);

  async function handleConfirmAll() {
    const toConfirm = filtered.filter((m) => m.confidence >= 0.60 && !m.confirmed);
    for (const m of toConfirm) {
      await confirmMutation.mutateAsync({ id: m.id, confirmed: true });
    }
    notification.success({ message: `Confirmed ${toConfirm.length} mapping(s) with ≥60% confidence` });
  }

  async function handleRejectAll() {
    const toReject = filtered.filter((m) => m.confidence < 0.5 && !m.confirmed);
    for (const m of toReject) {
      await confirmMutation.mutateAsync({ id: m.id, confirmed: false });
    }
    notification.success({ message: `Rejected ${toReject.length} low-confidence mapping(s)` });
  }

  const columns: ColumnsType<ClientIntelMapping> = [
    {
      title: 'Client',
      dataIndex: 'clientName',
      ellipsis: true,
      render: (name: string) => <Text strong style={{ fontSize: 13 }}>{name}</Text>,
    },
    {
      title: 'Source',
      dataIndex: 'source',
      width: 120,
      render: (src: string) => <Tag style={{ textTransform: 'capitalize' }}>{src}</Tag>,
    },
    {
      title: 'External Name',
      dataIndex: 'externalName',
      ellipsis: true,
      render: (name: string) => <Text style={{ fontSize: 13 }}>{name}</Text>,
    },
    {
      title: 'Confidence',
      dataIndex: 'confidence',
      width: 140,
      render: (conf: number) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Progress
            percent={Math.round(conf * 100)}
            size="small"
            showInfo={false}
            strokeColor={confidenceColor(conf)}
            style={{ flex: 1, margin: 0 }}
          />
          <Text style={{ fontSize: 12, color: confidenceColor(conf), minWidth: 36 }}>
            {Math.round(conf * 100)}%
          </Text>
        </div>
      ),
      sorter: (a, b) => a.confidence - b.confidence,
      defaultSortOrder: 'descend',
    },
    {
      title: 'Confirmed',
      dataIndex: 'confirmed',
      width: 90,
      render: (confirmed: boolean, record) => (
        <Switch
          size="small"
          checked={confirmed}
          loading={confirmMutation.isPending && confirmMutation.variables?.id === record.id}
          onChange={(checked) => confirmMutation.mutate({ id: record.id, confirmed: checked })}
        />
      ),
    },
    {
      title: 'Updated',
      dataIndex: 'updatedAt',
      width: 100,
      render: (d: string) => (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {new Date(d).toLocaleDateString()}
        </Text>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Intelligence Mappings
        </Typography.Title>
        <span style={{ flex: 1 }} />
        <Space>
          <Button icon={<PlusOutlined />} onClick={() => setManualOpen(true)}>
            Add mapping manually
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined />}
            loading={resolveAllMutation.isPending}
            onClick={() => resolveAllMutation.mutate()}
          >
            Resolve All Clients
          </Button>
        </Space>
      </div>

      {/* Filters + bulk actions */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input.Search
            placeholder="Search client or external name…"
            value={clientSearch}
            onChange={(e) => setClientSearch(e.target.value)}
            style={{ width: 260 }}
            allowClear
          />
          <Select
            allowClear
            placeholder="Source"
            style={{ width: 140 }}
            value={sourceFilter}
            onChange={(v) => setSourceFilter(v ?? undefined)}
            options={distinctSources.map((s) => ({ label: s, value: s }))}
          />
          <Select
            style={{ width: 160 }}
            value={confirmedFilter}
            onChange={(v) => setConfirmedFilter(v)}
            options={[
              { label: 'All statuses', value: 'all' },
              { label: 'Confirmed', value: 'confirmed' },
              { label: 'Unconfirmed', value: 'unconfirmed' },
            ]}
          />
          <span style={{ flex: 1 }} />
          <Space>
            <Button
              size="small"
              icon={<CheckCircleOutlined />}
              onClick={() => void handleConfirmAll()}
              disabled={!filtered.some((m) => m.confidence >= 0.60 && !m.confirmed)}
            >
              Confirm All ≥ 60%
            </Button>
            <Button
              size="small"
              danger
              onClick={() => void handleRejectAll()}
              disabled={!filtered.some((m) => m.confidence < 0.5 && !m.confirmed)}
            >
              Reject All &lt; 50%
            </Button>
          </Space>
        </div>
      </Card>

      {mappingsQuery.isLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <Table<ClientIntelMapping>
          rowKey="id"
          size="small"
          dataSource={filtered}
          columns={columns}
          pagination={{ pageSize: 25, showSizeChanger: true }}
          locale={{
            // The old copy pointed only at "Resolve All Clients" — i.e. at entity
            // resolution, which by definition just found nothing. Arriving here
            // from a profile CTA (e.g. the District Nexus widget's "Map a federal
            // contractor →", which deep-links ?source=contracting) then looked
            // like a dead end: an empty table and no route forward. Manual attach
            // is the answer in that case, so the empty state offers both paths.
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null}>
                <div style={{ maxWidth: 460, margin: '0 auto', textAlign: 'center' }}>
                  <div style={{ marginBottom: 6 }}>
                    {sourceFilterLabel
                      ? `No ${sourceFilterLabel} mappings yet.`
                      : 'No mappings yet.'}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Entity resolution proposes candidates automatically, but it can only
                    match records that exist in the federal source tables. If it found
                    nothing for this client, attach the record yourself — a manual mapping
                    is confirmed straight away.
                  </Text>
                  <div style={{ marginTop: 12 }}>
                    <Space>
                      <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => setManualOpen(true)}
                      >
                        Add mapping manually
                      </Button>
                      <Button
                        icon={<SyncOutlined />}
                        loading={resolveAllMutation.isPending}
                        onClick={() => resolveAllMutation.mutate()}
                      >
                        Resolve All Clients
                      </Button>
                    </Space>
                  </div>
                </div>
              </Empty>
            ),
          }}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={6}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {filtered.length} mapping{filtered.length !== 1 ? 's' : ''} shown ·{' '}
                  {filtered.filter((m) => m.confirmed).length} confirmed ·{' '}
                  {filtered.filter((m) => m.confidence >= 0.85).length} auto-confirm eligible
                </Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      )}

      {/* Seed the picker from ?source= too, so arriving from a profile CTA opens
          the modal already on the source that CTA was about. */}
      <ManualMapModal
        open={manualOpen}
        initialSource={asMappingSource(searchParams.get('source'))}
        onClose={() => setManualOpen(false)}
      />
    </div>
  );
}

interface ClientLite {
  id: string;
  name: string;
}

interface LdaSearchResult {
  id: string;
  name: string;
  state: string | null;
  totalFilings: number;
  latestFilingYear: number | null;
  totalSpending: number | null;
  issueCodes: string[];
  similarity: number;
}

function formatSpend(v: number | null): string {
  if (v == null || v <= 0) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}

interface FecEmployerResult {
  id: string;
  name: string;
  contributionCount: number;
  totalAmount: number | null;
  latestYear: number | null;
  similarity: number;
}

interface ContractorResult {
  id: string;
  name: string;
  uei: string | null;
  category: string | null;
  totalContracts: number | null;
  rankByContracts: number | null;
  similarity: number;
}

interface AssistanceRecipientResult {
  id: string;
  uei: string | null;
  // Always present — the search query filters WHERE recipient_name IS NOT NULL.
  name: string;
  state: string | null;
  awardCount: number;
  totalObligated: number | null;
  similarity: number;
}

type MappingSource = 'lda' | 'fec_employer' | 'contracting' | 'assistance_recipient';

/**
 * Attach an external record to a client by its exact identifier. Fuzzy
 * auto-resolve keys off the client's NAME, so a renamed/legacy entity
 * ("RAYTHEON TECHNOLOGIES" registrants, or "RAYTHEON" contribution-employer
 * strings, under a client named "RTX") never surfaces and can't be confirmed.
 * Here the user searches the federal registry freely and pins the exact
 * record(s) — saved as confirmed mappings the union logic reads at once.
 * Supports LDA registrants (by id/name) and FEC contributor-employers.
 */
function ManualMapModal({
  open,
  initialSource,
  onClose,
}: {
  open: boolean;
  /** Preselect this source when the modal opens (from the URL's ?source=). */
  initialSource?: MappingSource;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [source, setSource] = useState<MappingSource>(initialSource ?? 'lda');
  const [clientId, setClientId] = useState<string | undefined>(undefined);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');

  // The modal stays mounted between opens, so useState's initial value only
  // applies once. Re-apply the deep-linked source each time it opens, otherwise
  // a user who opened it earlier gets whichever source they last looked at.
  useEffect(() => {
    if (open && initialSource) setSource(initialSource);
  }, [open, initialSource]);

  const clientsQuery = useQuery<ClientLite[]>({
    queryKey: ['clients-lite-for-mapping'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    enabled: open,
    staleTime: 60_000,
  });

  const ldaSearch = useQuery<LdaSearchResult[]>({
    queryKey: ['lda-client-search', query],
    queryFn: async () =>
      (
        await api.get<LdaSearchResult[]>(
          `/api/intelligence/lda-clients/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'lda' && query.trim().length > 0,
  });

  const fecSearch = useQuery<FecEmployerResult[]>({
    queryKey: ['fec-employer-search', query],
    queryFn: async () =>
      (
        await api.get<FecEmployerResult[]>(
          `/api/intelligence/fec-employers/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'fec_employer' && query.trim().length > 0,
  });

  const contractorSearch = useQuery<ContractorResult[]>({
    queryKey: ['contractor-search', query],
    queryFn: async () =>
      (
        await api.get<ContractorResult[]>(
          `/api/intelligence/contractors/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'contracting' && query.trim().length > 0,
  });

  const assistanceRecipientSearch = useQuery<AssistanceRecipientResult[]>({
    queryKey: ['assistance-recipient-search', query],
    queryFn: async () =>
      (
        await api.get<AssistanceRecipientResult[]>(
          `/api/intelligence/assistance-recipients/search?q=${encodeURIComponent(query)}`,
        )
      ).data,
    enabled: open && source === 'assistance_recipient' && query.trim().length > 0,
  });

  const isFetching =
    source === 'lda'
      ? ldaSearch.isFetching
      : source === 'fec_employer'
        ? fecSearch.isFetching
        : source === 'contracting'
          ? contractorSearch.isFetching
          : assistanceRecipientSearch.isFetching;

  const attachMutation = useMutation({
    mutationFn: async (r: { id: string; name: string }) =>
      api.post(`/api/intelligence/mappings/${clientId}/manual`, {
        source,
        externalId: r.id,
        externalName: r.name,
      }),
    onSuccess: (_d, r) => {
      const sourceLabel =
        source === 'lda'
          ? 'LDA'
          : source === 'fec_employer'
            ? 'FEC employer'
            : source === 'contracting'
              ? 'federal contractor'
              : 'assistance recipient';
      const feeds =
        source === 'lda'
          ? 'issue-code matching'
          : source === 'fec_employer'
            ? 'contribution panel'
            : source === 'contracting'
              ? 'contract/obligation footprint'
              : 'grant/assistance footprint';
      notification.success({
        message: 'Mapping attached',
        description: `"${r.name}" is now a confirmed ${sourceLabel} mapping. It feeds this client's ${feeds} immediately.`,
      });
      void qc.invalidateQueries({ queryKey: ['intelligence-mappings'] });
      invalidateClientIntel(qc);
    },
    onError: (err) =>
      notification.error({ message: 'Attach failed', description: apiErrorMessage(err) }),
  });

  const attachButton = (record: { id: string; name: string }) => (
    <Button
      size="small"
      type="primary"
      disabled={!clientId}
      loading={attachMutation.isPending && attachMutation.variables?.id === record.id}
      onClick={() => attachMutation.mutate({ id: record.id, name: record.name })}
    >
      Attach
    </Button>
  );

  const ldaColumns: ColumnsType<LdaSearchResult> = [
    { title: 'LDA id', dataIndex: 'id', width: 80, render: (v: string) => <Text code>{v}</Text> },
    {
      title: 'Registrant name',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string) => <Text style={{ fontSize: 13 }}>{v}</Text>,
    },
    { title: 'State', dataIndex: 'state', width: 64, render: (v: string | null) => v ?? '—' },
    { title: 'Filings', dataIndex: 'totalFilings', width: 72 },
    {
      title: 'Latest',
      dataIndex: 'latestFilingYear',
      width: 72,
      render: (v: number | null) => v ?? '—',
    },
    {
      title: 'Spend',
      dataIndex: 'totalSpending',
      width: 80,
      render: (v: number | null) => formatSpend(v),
    },
    {
      title: 'Issue codes',
      dataIndex: 'issueCodes',
      width: 150,
      render: (codes: string[]) =>
        codes.length ? (
          <span>
            {codes.slice(0, 4).map((c) => (
              <Tag key={c} style={{ marginInlineEnd: 2 }}>
                {c}
              </Tag>
            ))}
            {codes.length > 4 ? <Text type="secondary">+{codes.length - 4}</Text> : null}
          </span>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    { title: '', key: 'attach', width: 90, render: (_v, record) => attachButton(record) },
  ];

  const fecColumns: ColumnsType<FecEmployerResult> = [
    {
      title: 'Contributor employer',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string) => <Text style={{ fontSize: 13 }}>{v}</Text>,
    },
    { title: 'Contributions', dataIndex: 'contributionCount', width: 110 },
    {
      title: 'Total',
      dataIndex: 'totalAmount',
      width: 90,
      render: (v: number | null) => formatSpend(v),
    },
    {
      title: 'Latest',
      dataIndex: 'latestYear',
      width: 72,
      render: (v: number | null) => v ?? '—',
    },
    { title: '', key: 'attach', width: 90, render: (_v, record) => attachButton(record) },
  ];

  const contractorColumns: ColumnsType<ContractorResult> = [
    {
      title: 'Contractor name',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string) => <Text style={{ fontSize: 13 }}>{v}</Text>,
    },
    { title: 'UEI', dataIndex: 'uei', width: 110, render: (v: string | null) => v ?? '—' },
    {
      title: 'Category',
      dataIndex: 'category',
      width: 100,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: 'Total contracts',
      dataIndex: 'totalContracts',
      width: 120,
      render: (v: number | null) => formatSpend(v),
    },
    {
      title: 'Rank',
      dataIndex: 'rankByContracts',
      width: 70,
      render: (v: number | null) => (v ? `#${v}` : '—'),
    },
    { title: '', key: 'attach', width: 90, render: (_v, record) => attachButton(record) },
  ];

  const assistanceRecipientColumns: ColumnsType<AssistanceRecipientResult> = [
    {
      title: 'Recipient name',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string) => <Text style={{ fontSize: 13 }}>{v}</Text>,
    },
    { title: 'UEI', dataIndex: 'uei', width: 110, render: (v: string | null) => v ?? '—' },
    { title: 'State', dataIndex: 'state', width: 64, render: (v: string | null) => v ?? '—' },
    { title: 'Awards', dataIndex: 'awardCount', width: 72 },
    {
      title: 'Total obligated',
      dataIndex: 'totalObligated',
      width: 130,
      render: (v: number | null) => formatSpend(v),
    },
    { title: '', key: 'attach', width: 90, render: (_v, record) => attachButton(record) },
  ];

  const resetSearch = () => {
    setSearchInput('');
    setQuery('');
  };

  return (
    <Modal
      title="Attach a federal record manually"
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
      width={860}
      afterClose={() => {
        setSource('lda');
        setClientId(undefined);
        resetSearch();
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        Use this for records the automatic matcher can&apos;t find — a renamed or legacy entity
        (&quot;RAYTHEON TECHNOLOGIES&quot; under a client named &quot;RTX&quot;). Pick the client,
        search the federal registry, and pin the exact record. It&apos;s saved as a confirmed
        mapping and folded into that client&apos;s footprint right away.
      </Text>

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Segmented<MappingSource>
          block
          value={source}
          onChange={(v) => {
            setSource(v);
            resetSearch();
          }}
          options={MAPPING_SOURCE_OPTIONS}
        />

        <Select
          showSearch
          placeholder="1 · Select the client to attach to"
          style={{ width: '100%' }}
          value={clientId}
          loading={clientsQuery.isLoading}
          onChange={(v) => setClientId(v)}
          optionFilterProp="label"
          options={(clientsQuery.data ?? []).map((c) => ({ label: c.name, value: c.id }))}
        />

        <Input.Search
          placeholder={
            source === 'lda'
              ? '2 · Search LDA registry by name or id (e.g. raytheon, or 4321)'
              : source === 'fec_employer'
                ? '2 · Search FEC contributor-employers by name (e.g. raytheon)'
                : source === 'contracting'
                  ? '2 · Search federal contractors by name (e.g. raytheon)'
                  : '2 · Search assistance recipients by name or UEI'
          }
          enterButton="Search"
          allowClear
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onSearch={(v) => setQuery(v)}
          loading={isFetching}
        />

        {query.trim().length > 0 &&
          (source === 'lda' ? (
            <Table<LdaSearchResult>
              rowKey="id"
              size="small"
              loading={ldaSearch.isFetching}
              dataSource={ldaSearch.data ?? []}
              columns={ldaColumns}
              pagination={false}
              scroll={{ y: 320 }}
              locale={{
                emptyText: (
                  <Empty
                    description="No LDA registrants matched. Try a shorter name or the numeric id."
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                ),
              }}
            />
          ) : source === 'fec_employer' ? (
            <Table<FecEmployerResult>
              rowKey="id"
              size="small"
              loading={fecSearch.isFetching}
              dataSource={fecSearch.data ?? []}
              columns={fecColumns}
              pagination={false}
              scroll={{ y: 320 }}
              locale={{
                emptyText: (
                  <Empty
                    description="No FEC employers matched. Try a shorter or alternate spelling."
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                ),
              }}
            />
          ) : source === 'contracting' ? (
            <Table<ContractorResult>
              rowKey="id"
              size="small"
              loading={contractorSearch.isFetching}
              dataSource={contractorSearch.data ?? []}
              columns={contractorColumns}
              pagination={false}
              scroll={{ y: 320 }}
              locale={{
                emptyText: (
                  <Empty
                    description="No federal contractors matched. Try a shorter or alternate spelling, or paste the contractor UUID."
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                ),
              }}
            />
          ) : (
            <Table<AssistanceRecipientResult>
              rowKey="id"
              size="small"
              loading={assistanceRecipientSearch.isFetching}
              dataSource={assistanceRecipientSearch.data ?? []}
              columns={assistanceRecipientColumns}
              pagination={false}
              scroll={{ y: 320 }}
              locale={{
                emptyText: (
                  <Empty
                    description="No assistance recipients matched. Try a shorter name or the exact UEI."
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                ),
              }}
            />
          ))}
      </Space>
    </Modal>
  );
}

// Profile/intel react-query keys that depend on a client's mappings. Invalidated
// after any mapping change so the Intelligence tab (aggregate, snapshot, setup
// checklist, derived issue-code signal) reflects the change without a hard reload.
const CLIENT_INTEL_QUERY_KEYS = [
  'client-intel-v1-profile',
  'client-intel-v1-aggregate',
  'intel-setup-completeness',
  'intel-issue-code-signal',
];
function invalidateClientIntel(qc: QueryClient) {
  for (const key of CLIENT_INTEL_QUERY_KEYS) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

function apiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
