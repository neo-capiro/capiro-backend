import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
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
} from '../../../pages/intelligence/federal-spending/federal-market-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { FederalMarketDetailDrawerVNext } from './FederalMarketDetailDrawerVNext.js';
import {
  IntelAlert,
  IntelCard,
  IntelFilterIcon,
  IntelPill,
  IntelRefreshIcon,
  IntelSegmented,
  IntelSkeletonRows,
} from './intel-ui.js';

/**
 * Federal Spending & Market Intelligence — vNext port of the canonical page
 * (pages/intelligence/federal-spending/FederalSpendingPage.tsx).
 *
 * Re-skin contract: identical endpoints (getFederalMarket → /api/federal-
 * spending/market/:tab), identical query keys, identical URL state (tab, q,
 * agency, recipient, state, district, fiscalYear, clientId, page), identical
 * copy, empty/loading/error states, and per-tab filter applicability. Only
 * presentation moves onto the vNext token layer.
 */

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

function Chip({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <span className="intel-chip">
      {children}
      <button type="button" className="intel-chip__close" aria-label="Remove filter" onClick={onClose}>
        ×
      </button>
    </span>
  );
}

export function FederalSpendingPageVNext() {
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

  const submitSearch = () => {
    setQuery(searchDraft.trim());
    setPage(1);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSearch();
    }
  };

  const openRow = (row: FederalMarketRow) => setSelectedRow(row);

  return (
    <div className="intel intel-federal-spending">
      <header className="intel-head">
        <div>
          <h2 className="intel-head__title">Federal Spending</h2>
          <p className="intel-head__subtitle">
            Explore federal market activity without mixing historical spending, acquisition access,
            and future procurement into one number.
          </p>
        </div>
        <CapiroButton
          leadingIcon={<IntelRefreshIcon size={14} />}
          loading={market.isFetching}
          onClick={() => void market.refetch()}
        >
          Refresh
        </CapiroButton>
      </header>

      <div className="intel-scope-bar">
        <label className="capiro-field">
          <span className="capiro-field__label">Client</span>
          <select
            className="capiro-select"
            aria-label="Client"
            value={clientApplies ? (clientId ?? '') : ''}
            disabled={!clientApplies}
            onChange={(event) => {
              setClientId(event.target.value || undefined);
              setPage(1);
            }}
          >
            <option value="">{clientApplies ? 'All clients' : 'Market-wide forecasts'}</option>
            {visibleClients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="capiro-field intel-scope-bar__search">
          <span className="capiro-field__label">Search</span>
          <input
            className="capiro-input"
            aria-label="Search federal market"
            placeholder="Search company, award, vehicle, agency, or description"
            value={searchDraft}
            onChange={(event) => {
              const next = event.target.value;
              setSearchDraft(next);
              if (!next) {
                setQuery('');
                setPage(1);
              }
            }}
            onKeyDown={onSearchKeyDown}
          />
        </label>
        <CapiroButton size="compact" onClick={submitSearch}>
          Search
        </CapiroButton>
        <CapiroButton
          size="compact"
          leadingIcon={<IntelFilterIcon size={13} />}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Filters{advancedFilterCount ? ` · ${advancedFilterCount}` : ''}
        </CapiroButton>
      </div>

      {showAdvancedFilters ? (
        <div className="intel-filter-panel" aria-label="Federal market filters">
          <label className="capiro-field" style={{ width: 210 }}>
            <span className="capiro-field__label">Agency</span>
            <input
              className="capiro-input"
              aria-label="Agency"
              placeholder="Agency or office"
              value={agency}
              onChange={(event) => {
                setAgency(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {districtApplies ? (
            <label className="capiro-field" style={{ width: 220 }}>
              <span className="capiro-field__label">Recipient</span>
              <input
                className="capiro-input"
                aria-label="Recipient"
                placeholder={tab === 'subawards' ? 'Prime or subrecipient' : 'Recipient'}
                value={recipient}
                onChange={(event) => {
                  setRecipient(event.target.value);
                  setPage(1);
                }}
              />
            </label>
          ) : null}
          {tab !== 'vehicles' ? (
            <label className="capiro-field" style={{ width: 110 }}>
              <span className="capiro-field__label">State</span>
              <input
                className="capiro-input"
                aria-label="Place of performance state"
                placeholder="State"
                maxLength={2}
                value={state}
                onChange={(event) => {
                  setState(event.target.value.toUpperCase());
                  setPage(1);
                }}
              />
            </label>
          ) : null}
          {districtApplies ? (
            <label className="capiro-field" style={{ width: 120 }}>
              <span className="capiro-field__label">District</span>
              <input
                className="capiro-input"
                aria-label="Congressional district"
                placeholder="District"
                maxLength={2}
                value={district}
                onChange={(event) => {
                  setDistrict(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''));
                  setPage(1);
                }}
              />
            </label>
          ) : null}
          {tab === 'subawards' || tab === 'forecasts' ? (
            <label className="capiro-field" style={{ width: 140 }}>
              <span className="capiro-field__label">Fiscal year</span>
              <input
                className="capiro-input"
                aria-label="Fiscal year"
                placeholder="Fiscal year"
                type="number"
                min={1900}
                max={2200}
                value={fiscalYear ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  setFiscalYear(raw === '' ? null : Number(raw));
                  setPage(1);
                }}
              />
            </label>
          ) : null}
          {advancedFilterCount ? (
            <CapiroButton size="compact" variant="quiet" onClick={clearAdvancedFilters}>
              Clear filters
            </CapiroButton>
          ) : null}
        </div>
      ) : null}

      {query || advancedFilterCount > 0 || (clientApplies && selectedClient) ? (
        <div className="intel-active-filters">
          <span>View</span>
          {clientApplies && selectedClient ? (
            <Chip onClose={() => setClientId(undefined)}>{selectedClient.name}</Chip>
          ) : null}
          {query ? (
            <Chip
              onClose={() => {
                setQuery('');
                setSearchDraft('');
              }}
            >
              “{query}”
            </Chip>
          ) : null}
          {agency ? <Chip onClose={() => setAgency('')}>Agency: {agency}</Chip> : null}
          {districtApplies && recipient ? (
            <Chip onClose={() => setRecipient('')}>Recipient: {recipient}</Chip>
          ) : null}
          {tab !== 'vehicles' && state ? (
            <Chip onClose={() => setState('')}>State: {state}</Chip>
          ) : null}
          {districtApplies && district ? (
            <Chip onClose={() => setDistrict('')}>District: {district}</Chip>
          ) : null}
          {(tab === 'subawards' || tab === 'forecasts') && fiscalYear != null ? (
            <Chip onClose={() => setFiscalYear(null)}>FY{fiscalYear}</Chip>
          ) : null}
        </div>
      ) : null}

      <div className="intel-tabs-row" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <IntelSegmented<FederalMarketTab>
          value={tab}
          options={TABS}
          ariaLabel="Federal market data type"
          onChange={(next) => {
            setTab(next);
            setPage(1);
            setSelectedRow(null);
          }}
        />
        <div className="intel-muted">
          {tab === 'forecasts' && clientId
            ? 'Forecasts stay market-wide. Client matching belongs in Funding Opportunities.'
            : TAB_COPY[tab]}
        </div>
      </div>

      {market.data ? (
        <div className="intel-status-line">
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
        <IntelSkeletonRows rows={10} />
      ) : market.isError ? (
        <IntelAlert
          tone="error"
          message="Federal market data could not be loaded"
          description="This is a request failure, not evidence that no records exist."
          action={
            <CapiroButton size="compact" onClick={() => void market.refetch()}>
              Retry
            </CapiroButton>
          }
        />
      ) : (market.data?.items.length ?? 0) === 0 ? (
        <IntelCard>
          <CapiroEmptyState
            title="No records match this view."
            description="Try removing a filter or changing the market tab."
          />
        </IntelCard>
      ) : (
        <IntelCard className="intel-table-card">
          <CapiroTableWrap>
            <CapiroTable style={{ minWidth: 900 }}>
              <MarketTableHead tab={tab} />
              <CapiroTableBody>
                {(market.data?.items ?? []).map((row) => (
                  <tr
                    key={`${tab}:${row.id}`}
                    className="intel-row"
                    tabIndex={0}
                    aria-label={`Open ${tab} record`}
                    onClick={() => openRow(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openRow(row);
                      }
                    }}
                  >
                    <MarketRowCells tab={tab} row={row} />
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          <div className="intel-pagination">
            <span>
              Page {page} · showing {market.data?.items.length ?? 0} of{' '}
              {(market.data?.total ?? 0).toLocaleString()}
            </span>
            <CapiroButton size="compact" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              Previous
            </CapiroButton>
            <CapiroButton
              size="compact"
              disabled={page * pageSize >= (market.data?.total ?? 0)}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </CapiroButton>
          </div>
        </IntelCard>
      )}

      <FederalMarketDetailDrawerVNext
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
    <div className="intel-primary-cell">
      <strong>{title ?? 'Not stated'}</strong>
      {subtitle ? <span>{subtitle}</span> : null}
    </div>
  );
}

function openCell() {
  return (
    <span className="intel-micro" aria-hidden="true">
      ›
    </span>
  );
}

function MarketTableHead({ tab }: { tab: FederalMarketTab }) {
  if (tab === 'contracts') {
    return (
      <CapiroTableHead>
        <tr>
          <CapiroTableHeaderCell>Recipient</CapiroTableHeaderCell>
          <CapiroTableHeaderCell>Agency</CapiroTableHeaderCell>
          <CapiroTableHeaderCell className="intel-cell-num">Obligated</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 125 }}>Action date</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 120 }}>Place</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 34 }} aria-label="Open record" />
        </tr>
      </CapiroTableHead>
    );
  }
  if (tab === 'subawards') {
    return (
      <CapiroTableHead>
        <tr>
          <CapiroTableHeaderCell>Subrecipient</CapiroTableHeaderCell>
          <CapiroTableHeaderCell>Agency</CapiroTableHeaderCell>
          <CapiroTableHeaderCell className="intel-cell-num">Amount</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 125 }}>Action date</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 150 }}>Place</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 34 }} aria-label="Open record" />
        </tr>
      </CapiroTableHead>
    );
  }
  if (tab === 'vehicles') {
    return (
      <CapiroTableHead>
        <tr>
          <CapiroTableHeaderCell>Vehicle</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 150 }}>Client position</CapiroTableHeaderCell>
          <CapiroTableHeaderCell className="intel-cell-num" style={{ width: 90 }}>
            Orders
          </CapiroTableHeaderCell>
          <CapiroTableHeaderCell className="intel-cell-num" style={{ width: 150 }}>
            Vehicle obligations
          </CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 130 }}>Last order date</CapiroTableHeaderCell>
          <CapiroTableHeaderCell style={{ width: 34 }} aria-label="Open record" />
        </tr>
      </CapiroTableHead>
    );
  }
  return (
    <CapiroTableHead>
      <tr>
        <CapiroTableHeaderCell>Forecast</CapiroTableHeaderCell>
        <CapiroTableHeaderCell style={{ width: 140 }}>Anticipated award</CapiroTableHeaderCell>
        <CapiroTableHeaderCell>Acquisition context</CapiroTableHeaderCell>
        <CapiroTableHeaderCell>Place</CapiroTableHeaderCell>
        <CapiroTableHeaderCell style={{ width: 135 }}>Status</CapiroTableHeaderCell>
        <CapiroTableHeaderCell style={{ width: 34 }} aria-label="Open record" />
      </tr>
    </CapiroTableHead>
  );
}

function MarketRowCells({ tab, row }: { tab: FederalMarketTab; row: FederalMarketRow }) {
  if (tab === 'contracts') {
    const item = row as FederalContractMarketRow;
    return (
      <>
        <CapiroTableCell>{primaryCell(item.recipientName, item.awardId)}</CapiroTableCell>
        <CapiroTableCell>{item.awardingAgency ?? 'Not stated'}</CapiroTableCell>
        <CapiroTableCell className="intel-cell-num">{formatMarketMoney(item.amount)}</CapiroTableCell>
        <CapiroTableCell>{formatMarketDate(item.actionDate)}</CapiroTableCell>
        <CapiroTableCell>{item.districtKey ?? item.state ?? 'Not stated'}</CapiroTableCell>
        <CapiroTableCell>{openCell()}</CapiroTableCell>
      </>
    );
  }
  if (tab === 'subawards') {
    const item = row as FederalSubawardMarketRow;
    return (
      <>
        <CapiroTableCell>
          {primaryCell(
            item.subawardeeName,
            item.primeRecipientName ? `Prime · ${item.primeRecipientName}` : null,
          )}
        </CapiroTableCell>
        <CapiroTableCell>{primaryCell(item.awardingAgency, item.awardingOffice)}</CapiroTableCell>
        <CapiroTableCell className="intel-cell-num">{formatMarketMoney(item.amount)}</CapiroTableCell>
        <CapiroTableCell>{formatMarketDate(item.actionDate)}</CapiroTableCell>
        <CapiroTableCell>
          {item.districtKey ?? (item.state ? `${item.state} · state only` : 'Not stated')}
        </CapiroTableCell>
        <CapiroTableCell>{openCell()}</CapiroTableCell>
      </>
    );
  }
  if (tab === 'vehicles') {
    const item = row as FederalVehicleMarketRow;
    return (
      <>
        <CapiroTableCell>{primaryCell(item.name, item.vehicleType)}</CapiroTableCell>
        <CapiroTableCell>
          {item.relationship === 'self' ? (
            <IntelPill tone="green">Direct</IntelPill>
          ) : item.relationship === 'parent' ? (
            <IntelPill tone="gold">Related entity</IntelPill>
          ) : (
            <span className="intel-micro">Market catalog</span>
          )}
        </CapiroTableCell>
        <CapiroTableCell className="intel-cell-num">{item.orderCount ?? 'Unknown'}</CapiroTableCell>
        <CapiroTableCell className="intel-cell-num">
          {formatMarketMoney(item.totalObligated)}
        </CapiroTableCell>
        <CapiroTableCell>{formatMarketDate(item.lastDateToOrder)}</CapiroTableCell>
        <CapiroTableCell>{openCell()}</CapiroTableCell>
      </>
    );
  }
  const item = row as FederalForecastMarketRow;
  return (
    <>
      <CapiroTableCell>
        {primaryCell(item.title, [item.agency, item.office].filter(Boolean).join(' · ') || null)}
      </CapiroTableCell>
      <CapiroTableCell>{formatMarketDate(item.anticipatedAwardDate)}</CapiroTableCell>
      <CapiroTableCell>
        {[item.contractVehicle, item.setAside].filter(Boolean).join(' · ') || 'Not stated'}
      </CapiroTableCell>
      <CapiroTableCell>{item.placeOfPerformance ?? 'Not stated'}</CapiroTableCell>
      <CapiroTableCell>
        <IntelPill>{item.status ?? 'Agency forecast'}</IntelPill>
      </CapiroTableCell>
      <CapiroTableCell>{openCell()}</CapiroTableCell>
    </>
  );
}
