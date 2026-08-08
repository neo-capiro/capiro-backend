import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FilterOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { FederalMarketDetailDrawer } from './FederalMarketDetailDrawer.js';
import {
  formatMarketDate,
  formatMarketMoney,
  getFederalMarket,
  type FederalContractMarketRow,
  type FederalForecastMarketRow,
  type FederalMarketPage,
  type FederalMarketRow,
  type FederalMarketTab,
  type FederalSubawardMarketRow,
  type FederalVehicleMarketRow,
} from './federal-market-api.js';
import './federal-market.css';

const { Title, Paragraph, Text } = Typography;

const TABS: Array<{ value: FederalMarketTab; label: string }> = [
  { value: 'contracts', label: 'Awards' },
  { value: 'subawards', label: 'Subawards' },
  { value: 'vehicles', label: 'Vehicles' },
  { value: 'forecasts', label: 'Forecasts' },
];

const TAB_COPY: Record<FederalMarketTab, string> = {
  contracts: 'Prime federal contract obligations from Capiro’s first-party USAspending rail.',
  subawards: 'Individual subawards from MakeGov/Tango, kept separate from prime-award dollars.',
  vehicles: 'Acquisition vehicles and reviewed client access evidence — not win probability.',
  forecasts: 'Agency planning signals that can surface before a solicitation is open.',
};

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}

function asTab(value: string | null): FederalMarketTab {
  return TABS.some((tab) => tab.value === value) ? (value as FederalMarketTab) : 'contracts';
}

function filterCount(values: Array<string | number | null | undefined>): number {
  return values.filter((value) => value !== undefined && value !== null && String(value).trim())
    .length;
}

export function FederalSpendingPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<FederalMarketTab>(() => asTab(params.get('tab')));
  const [searchDraft, setSearchDraft] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [agency, setAgency] = useState(params.get('agency') ?? '');
  const [recipient, setRecipient] = useState(params.get('recipient') ?? '');
  const [state, setState] = useState(params.get('state') ?? '');
  const [district, setDistrict] = useState(params.get('district') ?? '');
  const [fiscalYear, setFiscalYear] = useState<number | null>(() => {
    const raw = params.get('fiscalYear');
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
  });
  const [clientId, setClientId] = useState<string | undefined>(params.get('clientId') ?? undefined);
  const [page, setPage] = useState(() => Math.max(Number(params.get('page') ?? 1) || 1, 1));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedRow, setSelectedRow] = useState<FederalMarketRow | null>(null);
  const pageSize = 25;

  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients', 'federal-market'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
  });

  useEffect(() => {
    const next = new URLSearchParams();
    next.set('tab', tab);
    if (query) next.set('q', query);
    if (agency) next.set('agency', agency);
    if (recipient) next.set('recipient', recipient);
    if (state) next.set('state', state.toUpperCase());
    if (district) next.set('district', district.toUpperCase());
    if (fiscalYear != null) next.set('fiscalYear', String(fiscalYear));
    if (clientId) next.set('clientId', clientId);
    if (page > 1) next.set('page', String(page));
    setParams(next, { replace: true });
  }, [agency, clientId, district, fiscalYear, page, query, recipient, setParams, state, tab]);

  const clientApplies = tab !== 'forecasts';
  const districtApplies = tab === 'contracts' || tab === 'subawards';
  const market = useQuery<FederalMarketPage<FederalMarketRow>>({
    queryKey: [
      'federal-market',
      tab,
      query,
      agency,
      recipient,
      state,
      districtApplies ? district : undefined,
      fiscalYear,
      clientApplies ? clientId : undefined,
      page,
    ],
    queryFn: () =>
      getFederalMarket<FederalMarketRow>(api, tab, {
        clientId: clientApplies ? clientId : undefined,
        q: query || undefined,
        agency: agency || undefined,
        recipient: districtApplies ? recipient || undefined : undefined,
        state: tab === 'vehicles' ? undefined : state || undefined,
        district: districtApplies ? district || undefined : undefined,
        fiscalYear:
          tab === 'subawards' || tab === 'forecasts' ? (fiscalYear ?? undefined) : undefined,
        page,
        pageSize,
      }),
    retry: 1,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });

  const columns = useMemo(() => columnsFor(tab), [tab]);
  const visibleClients = (clients.data ?? []).filter((client) => client.status !== 'archived');
  const selectedClient = visibleClients.find((client) => client.id === clientId) ?? null;
  const advancedFilterCount = filterCount([
    agency,
    districtApplies ? recipient : null,
    tab !== 'vehicles' ? state : null,
    districtApplies ? district : null,
    tab === 'subawards' || tab === 'forecasts' ? fiscalYear : null,
  ]);
  const showAdvancedFilters = filtersOpen || advancedFilterCount > 0;

  const clearAdvancedFilters = () => {
    setAgency('');
    setRecipient('');
    setState('');
    setDistrict('');
    setFiscalYear(null);
    setPage(1);
  };

  return (
    <div className="fsm-page">
      <header className="fsm-head">
        <div>
          <Title level={3}>Federal Spending</Title>
          <Paragraph type="secondary">
            Explore federal market activity without mixing historical spending, acquisition access,
            and future procurement into one number.
          </Paragraph>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={market.isFetching}
          onClick={() => void market.refetch()}
        >
          Refresh
        </Button>
      </header>

      <div className="fsm-scope-bar">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={clientApplies ? 'All clients' : 'Market-wide forecasts'}
          value={clientApplies ? clientId : undefined}
          disabled={!clientApplies}
          loading={clients.isLoading}
          options={visibleClients.map((client) => ({ label: client.name, value: client.id }))}
          onChange={(value) => {
            setClientId(value ?? undefined);
            setPage(1);
          }}
          aria-label="Client"
        />
        <Input.Search
          allowClear
          value={searchDraft}
          placeholder="Search company, award, vehicle, agency, or description"
          onChange={(event) => {
            const next = event.target.value;
            setSearchDraft(next);
            if (!next) {
              setQuery('');
              setPage(1);
            }
          }}
          onSearch={(value) => {
            setQuery(value.trim());
            setPage(1);
          }}
          aria-label="Search federal market"
        />
        <Button
          icon={<FilterOutlined />}
          className={`fsm-filter-toggle${advancedFilterCount ? ' is-active' : ''}`}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Filters{advancedFilterCount ? ` · ${advancedFilterCount}` : ''}
        </Button>
      </div>

      {showAdvancedFilters ? (
        <div className="fsm-filter-panel" aria-label="Federal market filters">
          <Input
            allowClear
            style={{ width: 210 }}
            value={agency}
            placeholder="Agency or office"
            onChange={(event) => {
              setAgency(event.target.value);
              setPage(1);
            }}
            aria-label="Agency"
          />
          {districtApplies ? (
            <Input
              allowClear
              style={{ width: 220 }}
              value={recipient}
              placeholder={tab === 'subawards' ? 'Prime or subrecipient' : 'Recipient'}
              onChange={(event) => {
                setRecipient(event.target.value);
                setPage(1);
              }}
              aria-label="Recipient"
            />
          ) : null}
          {tab !== 'vehicles' ? (
            <Input
              allowClear
              style={{ width: 110 }}
              value={state}
              maxLength={2}
              placeholder="State"
              onChange={(event) => {
                setState(event.target.value.toUpperCase());
                setPage(1);
              }}
              aria-label="Place of performance state"
            />
          ) : null}
          {districtApplies ? (
            <Input
              allowClear
              style={{ width: 120 }}
              value={district}
              maxLength={2}
              placeholder="District"
              onChange={(event) => {
                setDistrict(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''));
                setPage(1);
              }}
              aria-label="Congressional district"
            />
          ) : null}
          {tab === 'subawards' || tab === 'forecasts' ? (
            <InputNumber
              min={1900}
              max={2200}
              style={{ width: 140 }}
              value={fiscalYear}
              placeholder="Fiscal year"
              onChange={(value) => {
                setFiscalYear(value == null ? null : Number(value));
                setPage(1);
              }}
              aria-label="Fiscal year"
            />
          ) : null}
          {advancedFilterCount ? (
            <Button type="text" onClick={clearAdvancedFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

      {query || advancedFilterCount > 0 || (clientApplies && selectedClient) ? (
        <div className="fsm-active-filters">
          <span>View</span>
          {clientApplies && selectedClient ? (
            <Tag closable onClose={() => setClientId(undefined)}>
              {selectedClient.name}
            </Tag>
          ) : null}
          {query ? (
            <Tag
              closable
              onClose={() => {
                setQuery('');
                setSearchDraft('');
              }}
            >
              “{query}”
            </Tag>
          ) : null}
          {agency ? (
            <Tag closable onClose={() => setAgency('')}>
              Agency: {agency}
            </Tag>
          ) : null}
          {districtApplies && recipient ? (
            <Tag closable onClose={() => setRecipient('')}>
              Recipient: {recipient}
            </Tag>
          ) : null}
          {tab !== 'vehicles' && state ? (
            <Tag closable onClose={() => setState('')}>
              State: {state}
            </Tag>
          ) : null}
          {districtApplies && district ? (
            <Tag closable onClose={() => setDistrict('')}>
              District: {district}
            </Tag>
          ) : null}
          {(tab === 'subawards' || tab === 'forecasts') && fiscalYear != null ? (
            <Tag closable onClose={() => setFiscalYear(null)}>
              FY{fiscalYear}
            </Tag>
          ) : null}
        </div>
      ) : null}

      <div className="fsm-tabs">
        <Segmented<FederalMarketTab>
          value={tab}
          options={TABS}
          onChange={(next) => {
            setTab(next);
            setPage(1);
            setSelectedRow(null);
          }}
          aria-label="Federal market data type"
        />
        <div className="fsm-trust-note">
          {tab === 'forecasts' && clientId
            ? 'Forecasts stay market-wide. Client matching belongs in Funding Opportunities.'
            : TAB_COPY[tab]}
        </div>
      </div>

      {market.data ? (
        <div className="fsm-status-line">
          <strong>{market.data.total.toLocaleString()} records</strong>
          <span>·</span>
          <span>{market.data.source}</span>
          <span>·</span>
          <span>
            {market.data.asOf
              ? `current to ${new Date(market.data.asOf).toLocaleString()}`
              : 'freshness unavailable'}
          </span>
        </div>
      ) : null}

      {market.isPending ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : market.isError ? (
        <Alert
          type="error"
          showIcon
          message="Federal market data could not be loaded"
          description="This is a request failure, not evidence that no records exist."
          action={
            <Button size="small" onClick={() => void market.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (market.data?.items.length ?? 0) === 0 ? (
        <Card className="fsm-empty" size="small">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No records match this view. Try removing a filter or changing the market tab."
          />
        </Card>
      ) : (
        <Card className="fsm-table-card" size="small">
          <Table<FederalMarketRow>
            rowKey={(row) => `${tab}:${row.id}`}
            dataSource={market.data?.items ?? []}
            columns={columns}
            size="small"
            pagination={false}
            scroll={{ x: 900 }}
            onRow={(row) => ({
              className: 'fsm-row',
              onClick: () => setSelectedRow(row),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedRow(row);
                }
              },
              tabIndex: 0,
              'aria-label': `Open ${tab} record`,
            })}
          />
          <div className="fsm-pagination">
            <span>
              Page {page} · showing {market.data?.items.length ?? 0} of{' '}
              {(market.data?.total ?? 0).toLocaleString()}
            </span>
            <Button size="small" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              Previous
            </Button>
            <Button
              size="small"
              disabled={page * pageSize >= (market.data?.total ?? 0)}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </div>
        </Card>
      )}

      <FederalMarketDetailDrawer
        open={Boolean(selectedRow)}
        tab={tab}
        row={selectedRow}
        clientId={clientApplies ? clientId : undefined}
        clientName={clientApplies ? (selectedClient?.name ?? null) : null}
        onClose={() => setSelectedRow(null)}
      />
    </div>
  );
}

function primaryCell(title: string | null, subtitle: string | null) {
  return (
    <div className="fsm-primary-cell">
      <strong>{title ?? 'Not stated'}</strong>
      {subtitle ? <span>{subtitle}</span> : null}
    </div>
  );
}

function openCell() {
  return <RightOutlined style={{ color: '#8a94a1', fontSize: 11 }} aria-hidden="true" />;
}

function columnsFor(tab: FederalMarketTab): ColumnsType<FederalMarketRow> {
  if (tab === 'contracts') {
    return [
      {
        title: 'Recipient',
        render: (_value, row) => {
          const item = row as FederalContractMarketRow;
          return primaryCell(item.recipientName, item.awardId);
        },
      },
      {
        title: 'Agency',
        render: (_value, row) => (row as FederalContractMarketRow).awardingAgency ?? 'Not stated',
      },
      {
        title: 'Obligated',
        align: 'right',
        render: (_value, row) => (
          <span className="fsm-money">
            {formatMarketMoney((row as FederalContractMarketRow).amount)}
          </span>
        ),
      },
      {
        title: 'Action date',
        width: 125,
        render: (_value, row) => formatMarketDate((row as FederalContractMarketRow).actionDate),
      },
      {
        title: 'Place',
        width: 120,
        render: (_value, row) =>
          (row as FederalContractMarketRow).districtKey ??
          (row as FederalContractMarketRow).state ??
          'Not stated',
      },
      { title: '', width: 34, render: openCell },
    ];
  }

  if (tab === 'subawards') {
    return [
      {
        title: 'Subrecipient',
        render: (_value, row) => {
          const item = row as FederalSubawardMarketRow;
          return primaryCell(
            item.subawardeeName,
            item.primeRecipientName ? `Prime · ${item.primeRecipientName}` : null,
          );
        },
      },
      {
        title: 'Agency',
        render: (_value, row) => {
          const item = row as FederalSubawardMarketRow;
          return primaryCell(item.awardingAgency, item.awardingOffice);
        },
      },
      {
        title: 'Amount',
        align: 'right',
        render: (_value, row) => (
          <span className="fsm-money">
            {formatMarketMoney((row as FederalSubawardMarketRow).amount)}
          </span>
        ),
      },
      {
        title: 'Action date',
        width: 125,
        render: (_value, row) => formatMarketDate((row as FederalSubawardMarketRow).actionDate),
      },
      {
        title: 'Place',
        width: 150,
        render: (_value, row) => {
          const item = row as FederalSubawardMarketRow;
          return item.districtKey ?? (item.state ? `${item.state} · state only` : 'Not stated');
        },
      },
      { title: '', width: 34, render: openCell },
    ];
  }

  if (tab === 'vehicles') {
    return [
      {
        title: 'Vehicle',
        render: (_value, row) => {
          const item = row as FederalVehicleMarketRow;
          return primaryCell(item.name, item.vehicleType);
        },
      },
      {
        title: 'Client position',
        width: 150,
        render: (_value, row) => {
          const relationship = (row as FederalVehicleMarketRow).relationship;
          return relationship === 'self' ? (
            <Tag color="green">Direct</Tag>
          ) : relationship === 'parent' ? (
            <Tag color="gold">Related entity</Tag>
          ) : (
            <span className="fsm-subtle">Market catalog</span>
          );
        },
      },
      {
        title: 'Orders',
        align: 'right',
        width: 90,
        render: (_value, row) => (row as FederalVehicleMarketRow).orderCount ?? 'Unknown',
      },
      {
        title: 'Vehicle obligations',
        align: 'right',
        width: 150,
        render: (_value, row) => (
          <span className="fsm-money">
            {formatMarketMoney((row as FederalVehicleMarketRow).totalObligated)}
          </span>
        ),
      },
      {
        title: 'Last order date',
        width: 130,
        render: (_value, row) => formatMarketDate((row as FederalVehicleMarketRow).lastDateToOrder),
      },
      { title: '', width: 34, render: openCell },
    ];
  }

  return [
    {
      title: 'Forecast',
      render: (_value, row) => {
        const item = row as FederalForecastMarketRow;
        return primaryCell(
          item.title,
          [item.agency, item.office].filter(Boolean).join(' · ') || null,
        );
      },
    },
    {
      title: 'Anticipated award',
      width: 140,
      render: (_value, row) =>
        formatMarketDate((row as FederalForecastMarketRow).anticipatedAwardDate),
    },
    {
      title: 'Acquisition context',
      render: (_value, row) => {
        const item = row as FederalForecastMarketRow;
        const context = [item.contractVehicle, item.setAside].filter(Boolean).join(' · ');
        return context || 'Not stated';
      },
    },
    {
      title: 'Place',
      render: (_value, row) => (row as FederalForecastMarketRow).placeOfPerformance ?? 'Not stated',
    },
    {
      title: 'Status',
      width: 135,
      render: (_value, row) => (
        <Tag>{(row as FederalForecastMarketRow).status ?? 'Agency forecast'}</Tag>
      ),
    },
    { title: '', width: 34, render: openCell },
  ];
}
