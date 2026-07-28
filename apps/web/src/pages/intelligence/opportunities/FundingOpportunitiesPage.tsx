import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { OpportunityCard } from './OpportunityCard.js';
import {
  ELIGIBILITY_LABELS,
  FUNDING_OPPORTUNITIES_FEATURE,
  KIND_LABELS,
  formatFreshness,
  type EligibilityState,
  type FundingOpportunity,
  type FundingOpportunityListResponse,
  type OpportunityKind,
} from './funding-opportunities-api.js';
import './funding-opportunities.css';

const { Text, Title, Paragraph } = Typography;

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}

type TabKey = 'all' | 'grants' | 'contracts' | 'saved' | 'pursuing' | 'deadlines' | 'dismissed';

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'grants', label: 'Grants' },
  { value: 'contracts', label: 'Government contracts' },
  { value: 'saved', label: 'Saved' },
  { value: 'pursuing', label: 'Pursuing' },
  { value: 'deadlines', label: 'Deadlines' },
  { value: 'dismissed', label: 'Dismissed' },
];

const KIND_OPTIONS: Array<{ label: string; value: OpportunityKind }> = (
  Object.keys(KIND_LABELS) as OpportunityKind[]
).map((k) => ({ label: KIND_LABELS[k], value: k }));

const ELIGIBILITY_OPTIONS: Array<{ label: string; value: EligibilityState }> = (
  Object.keys(ELIGIBILITY_LABELS) as EligibilityState[]
).map((k) => ({ label: ELIGIBILITY_LABELS[k], value: k }));

/**
 * Funding Opportunities — grants and government contract opportunities a client
 * could PURSUE.
 *
 * ── The distinction the whole page is built around ───────────────────────────
 *
 * Nothing on this page is money the client has. Every figure is a forecast about
 * a competition that has not happened, and several of them are figures the source
 * never stated at all. So:
 *
 *   - the header says so, in words, above everything else;
 *   - the KPI strip counts grants and contracts SEPARATELY and shows no dollar
 *     total at all — a blended figure would be the exact false claim this
 *     surface exists to avoid;
 *   - relevance and eligibility are two badges, never one score;
 *   - a request that FAILED renders an error, never an empty list. Those are
 *     structurally different outcomes here: an error is an error, and an empty
 *     result always arrives with a machine-readable reason.
 *
 * Gated in-page on the intel-api `funding_opportunities` flag (HearingWatchPage /
 * DistrictNexusPage precedent) — the route registers unconditionally.
 */
export function FundingOpportunitiesPage() {
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const api = useApi();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const clientId = searchParams.get('clientId') ?? undefined;
  const [tab, setTab] = useState<TabKey>('all');
  const [search, setSearch] = useState('');
  const [agency, setAgency] = useState('');
  const [naics, setNaics] = useState('');
  const [psc, setPsc] = useState('');
  const [setAside, setSetAside] = useState('');
  const [kinds, setKinds] = useState<OpportunityKind[]>([]);
  const [eligibility, setEligibility] = useState<EligibilityState[]>([]);
  const [minRelevance, setMinRelevance] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled: ready && enabled,
  });

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (clientId) params.set('clientId', clientId);
    if (tab === 'grants') params.set('source', 'grants_gov');
    if (tab === 'contracts') params.set('source', 'sam_gov');
    if (tab === 'saved') params.set('workflowStatus', 'saved');
    if (tab === 'pursuing') params.set('workflowStatus', 'pursuing');
    if (tab === 'dismissed') params.set('workflowStatus', 'dismissed');
    if (tab === 'deadlines') {
      params.set('deadlineFrom', new Date().toISOString());
      params.set('deadlineTo', new Date(Date.now() + 30 * 86_400_000).toISOString());
    }
    // The Dismissed tab must show closed ones too — a dismissal survives the
    // notice closing, and hiding it would make the tab look broken.
    params.set('activeState', tab === 'dismissed' ? 'all' : 'active');
    if (search.trim()) params.set('q', search.trim());
    if (agency.trim()) params.set('agency', agency.trim());
    if (naics.trim()) params.set('naics', naics.trim());
    if (psc.trim()) params.set('psc', psc.trim());
    if (setAside.trim()) params.set('setAside', setAside.trim());
    if (kinds.length) params.set('kind', kinds.join(','));
    if (eligibility.length) params.set('eligibility', eligibility.join(','));
    if (minRelevance != null) params.set('minRelevance', String(minRelevance));
    params.set('page', String(page));
    params.set('pageSize', '25');
    return params.toString();
  }, [clientId, tab, search, agency, naics, psc, setAside, kinds, eligibility, minRelevance, page]);

  const listQuery = useQuery<FundingOpportunityListResponse>({
    queryKey: ['funding-opportunities', query],
    queryFn: async () =>
      (await api.get<FundingOpportunityListResponse>(`/api/intelligence/opportunities?${query}`))
        .data,
    enabled: ready && enabled,
    // A load error must SURFACE. Swallowing it into an empty array is the single
    // most misleading thing this page could do.
    retry: 1,
    staleTime: 30_000,
  });

  const workflowMutation = useMutation({
    mutationFn: async (input: {
      o: FundingOpportunity;
      action: 'save' | 'pursue' | 'dismiss' | 'restore';
    }) => {
      const { o, action } = input;
      const base = `/api/intelligence/clients/${clientId}/opportunities/${o.source}/${o.sourceRecordId}`;
      if (action === 'dismiss') return api.post(`${base}/dismiss`, {});
      if (action === 'restore') return api.post(`${base}/restore`, {});
      return api.post(`${base}/save`, { status: action === 'pursue' ? 'pursuing' : 'saved' });
    },
    onSuccess: (_r, input) => {
      notification.success({
        message:
          input.action === 'dismiss'
            ? 'Dismissed'
            : input.action === 'restore'
              ? 'Restored'
              : input.action === 'pursue'
                ? 'Marked as pursuing'
                : 'Saved',
        description: input.o.title,
      });
      void qc.invalidateQueries({ queryKey: ['funding-opportunities'] });
      void qc.invalidateQueries({ queryKey: ['client-funding-opportunities'] });
    },
    onError: (err) =>
      notification.error({ message: 'Action failed', description: apiErrorMessage(err) }),
  });

  function setClient(next: string | undefined) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('clientId', next);
    else params.delete('clientId');
    setSearchParams(params);
    setPage(1);
  }

  // The flag is fail-closed and settles fast; rendering nothing while it resolves
  // avoids a flash of a surface the tenant may not have.
  if (!ready) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (!enabled) {
    return (
      <Alert
        type="info"
        showIcon
        message="Funding Opportunities is not enabled for this workspace"
        description="Grants.gov and SAM.gov opportunity matching is available on request."
      />
    );
  }

  const data = listQuery.data;
  const counts = data?.counts;
  const visibleClients = (clients.data ?? []).filter((c) => c.status !== 'archived');

  return (
    <div className="fo-page">
      <header className="fo-page__header">
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Funding Opportunities
          </Title>
          <Paragraph type="secondary" style={{ margin: '4px 0 0', maxWidth: 760, fontSize: 12 }}>
            Grants and government contract opportunities a client could <strong>pursue</strong>.
            These are future competitions, not awarded funding — a grant ceiling is the most any
            single award will be, not what this client will receive, and SAM.gov states no value at
            all for most notices.
          </Paragraph>
          {data?.freshness?.length ? (
            <div className="fo-page__freshness">
              <Space size={8} wrap>
                {data.freshness.map((f) => (
                  <Tag key={f.verb} color={f.neverSynced ? 'red' : f.lastRunDegraded ? 'orange' : 'default'}>
                    {formatFreshness(f)} · {f.activeRecordCount.toLocaleString()} active of{' '}
                    {f.recordCount.toLocaleString()}
                  </Tag>
                ))}
              </Space>
            </div>
          ) : null}
        </div>
        <Space>
          <Select
            allowClear
            showSearch
            placeholder="Select a client"
            style={{ width: 260 }}
            value={clientId}
            loading={clients.isLoading}
            optionFilterProp="label"
            onChange={(v) => setClient(v ?? undefined)}
            options={visibleClients.map((c) => ({ label: c.name, value: c.id }))}
            aria-label="Client"
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void listQuery.refetch()}
            loading={listQuery.isFetching}
          >
            Refresh
          </Button>
        </Space>
      </header>

      {/* Ant Design does not forward arbitrary DOM props through Alert/Skeleton, so
          test hooks go on a wrapping element rather than on the component. */}
      {!clientId ? (
        <div data-testid="fo-no-client">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Showing the raw opportunity catalog"
            description="Relevance and eligibility are always relative to a specific client, so no scores are shown until you pick one. Saving and pursuing also need a client."
          />
        </div>
      ) : null}

      {/* KPI strip. Counts only — grants and contracts are separate numbers and
          there is deliberately NO dollar total anywhere on this page. */}
      <div className="fo-kpis" data-testid="fo-kpis">
        <Kpi label="Active grants" value={counts?.activeGrants} loading={listQuery.isPending} />
        <Kpi
          label="Active contract opportunities"
          value={counts?.activeContracts}
          loading={listQuery.isPending}
        />
        <Kpi label="Saved" value={counts?.saved} loading={listQuery.isPending} />
        <Kpi label="Pursuing" value={counts?.pursuing} loading={listQuery.isPending} />
        <Kpi
          label="Deadlines in 30 days"
          value={counts?.deadlinesIn30Days}
          loading={listQuery.isPending}
        />
      </div>

      <Segmented<TabKey>
        block
        value={tab}
        onChange={(v) => {
          setTab(v);
          setPage(1);
        }}
        options={TABS}
        style={{ marginBottom: 12 }}
      />

      <Card size="small" style={{ marginBottom: 12 }}>
        <div className="fo-filters">
          <Input.Search
            allowClear
            placeholder="Search title, agency or reference…"
            style={{ width: 240 }}
            onSearch={(v) => {
              setSearch(v);
              setPage(1);
            }}
            aria-label="Search opportunities"
          />
          <Input
            allowClear
            placeholder="Agency"
            style={{ width: 160 }}
            value={agency}
            onChange={(e) => {
              setAgency(e.target.value);
              setPage(1);
            }}
            aria-label="Agency"
          />
          <Input
            allowClear
            placeholder="NAICS"
            style={{ width: 110 }}
            value={naics}
            onChange={(e) => {
              setNaics(e.target.value);
              setPage(1);
            }}
            aria-label="NAICS code"
          />
          <Input
            allowClear
            placeholder="PSC"
            style={{ width: 100 }}
            value={psc}
            onChange={(e) => {
              setPsc(e.target.value);
              setPage(1);
            }}
            aria-label="PSC code"
          />
          <Input
            allowClear
            placeholder="Set-aside"
            style={{ width: 140 }}
            value={setAside}
            onChange={(e) => {
              setSetAside(e.target.value);
              setPage(1);
            }}
            aria-label="Set-aside"
          />
          <Select
            allowClear
            mode="multiple"
            placeholder="Notice type"
            style={{ minWidth: 200 }}
            value={kinds}
            onChange={(v) => {
              setKinds(v);
              setPage(1);
            }}
            options={KIND_OPTIONS}
            aria-label="Notice type"
          />
          <Select
            allowClear
            mode="multiple"
            placeholder="Eligibility"
            style={{ minWidth: 170 }}
            value={eligibility}
            onChange={(v) => {
              setEligibility(v);
              setPage(1);
            }}
            options={ELIGIBILITY_OPTIONS}
            aria-label="Eligibility"
          />
          <InputNumber
            min={0}
            max={100}
            placeholder="Min relevance"
            style={{ width: 130 }}
            value={minRelevance}
            onChange={(v) => {
              setMinRelevance(v ?? null);
              setPage(1);
            }}
            aria-label="Minimum relevance"
          />
        </div>
      </Card>

      {/* A FAILED REQUEST IS NOT AN EMPTY LIST. */}
      {listQuery.isError ? (
        <div data-testid="fo-error">
        <Alert
          type="error"
          showIcon
          message="Funding opportunities failed to load"
          description={
            <span>
              This is a request failure, not an empty result — no conclusion can be drawn about how
              many opportunities exist.
              {(() => {
                const err = listQuery.error as unknown;
                const status =
                  err && typeof err === 'object' && 'response' in err
                    ? (err as { response?: { status?: number } }).response?.status
                    : undefined;
                return status ? ` (HTTP ${status})` : '';
              })()}
            </span>
          }
          action={
            <Button size="small" onClick={() => void listQuery.refetch()}>
              Retry
            </Button>
          }
        />
        </div>
      ) : listQuery.isPending ? (
        <div data-testid="fo-loading">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      ) : (data?.opportunities.length ?? 0) === 0 ? (
        <Card size="small" data-testid="fo-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null}>
            <div style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
              <div style={{ marginBottom: 6 }}>
                <Text strong>No opportunities to show</Text>
              </div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {data?.emptyExplanation ??
                  'No opportunities match the current filters. Clearing filters will widen the view.'}
              </Text>
              {data?.missingProfileFields?.length ? (
                <div style={{ marginTop: 12, textAlign: 'left' }}>
                  <Text strong style={{ fontSize: 12 }}>
                    What would improve matching for this client:
                  </Text>
                  <ul className="fo-gaps">
                    {data.missingProfileFields.map((f) => (
                      <li key={f.field}>
                        {f.href ? <a href={f.href}>{f.label}</a> : f.label} — {f.impact}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Empty>
        </Card>
      ) : (
        <>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {data!.opportunities.map((o) => (
              <OpportunityCard
                key={o.id}
                opportunity={o}
                clientId={clientId ?? null}
                busy={workflowMutation.isPending}
                onSave={(x) => workflowMutation.mutate({ o: x, action: 'save' })}
                onPursue={(x) => workflowMutation.mutate({ o: x, action: 'pursue' })}
                onDismiss={(x) => workflowMutation.mutate({ o: x, action: 'dismiss' })}
                onRestore={(x) => workflowMutation.mutate({ o: x, action: 'restore' })}
              />
            ))}
          </Space>

          <div className="fo-pager">
            <Text type="secondary" style={{ fontSize: 12 }}>
              Showing {data!.opportunities.length} of {data!.total}
              {data!.totalIsCapped ? '+ (scan bound reached — narrow the filters to see more)' : ''}
            </Text>
            <Space>
              <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                size="small"
                disabled={page * data!.pageSize >= data!.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </Space>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
}) {
  return (
    <div className="fo-kpi">
      <div className="fo-kpi__label">{label}</div>
      <div className="fo-kpi__value">
        {loading ? <Skeleton.Button active size="small" /> : (value ?? '—')}
      </div>
    </div>
  );
}

function apiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
