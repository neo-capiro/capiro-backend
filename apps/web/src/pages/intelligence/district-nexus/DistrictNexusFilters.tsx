import { useQuery } from '@tanstack/react-query';
import { Select } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { METRIC_OPTIONS, formatMoney, type ChoroplethMetric } from './district-nexus-format.js';

interface ClientOption {
  id: string;
  name: string;
  status: string;
}

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'AS', 'DC', 'GU', 'MP',
  'PR', 'VI',
];

const MIN_AMOUNT_OPTIONS = [
  { value: 0, label: 'Any amount' },
  { value: 1_000_000, label: `≥ ${formatMoney(1_000_000, 0)}` },
  { value: 5_000_000, label: `≥ ${formatMoney(5_000_000, 0)}` },
  { value: 10_000_000, label: `≥ ${formatMoney(10_000_000, 0)}` },
];

export interface DistrictNexusFilterState {
  clientId: string | null;
  state: string | null;
  metric: ChoroplethMetric;
  minAmount: number;
}

interface Props {
  value: DistrictNexusFilterState;
  onChange: (next: DistrictNexusFilterState) => void;
  resultCount: number;
}

/**
 * WS-G filter bar. Client and State are server-backed (real query params on
 * GET district-nexus/map); Colour-by and Minimum funding are computed
 * client-side over the already-fetched response. Deliberately omits the
 * plan's aspirational Nexus-type / Agency / Assistance-Listing / Verification
 * filters: DistrictNexusDistrictSummary (the map-aggregate row WS-E1 actually
 * ships) carries no per-type evidence flags, no agency breakdown and no
 * verification-status field to filter on — building those controls would be
 * dead UI wired to nothing. Closing that gap needs an E1 response
 * enrichment, which is backend work outside WS-G.
 */
export function DistrictNexusFilters({ value, onChange, resultCount }: Props) {
  const api = useApi();
  const clients = useQuery<ClientOption[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientOption[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const visibleClients = (clients.data ?? []).filter((c) => c.status !== 'archived');

  const hasFilters = value.clientId != null || value.state != null || value.minAmount > 0;

  return (
    <div className="dn-fbar">
      <Select<string | null>
        allowClear
        showSearch
        placeholder="Client"
        style={{ minWidth: 168 }}
        suffixIcon={<DownOutlined />}
        optionFilterProp="label"
        value={value.clientId}
        loading={clients.isLoading}
        onChange={(clientId) => onChange({ ...value, clientId: clientId ?? null })}
        options={visibleClients.map((c) => ({ value: c.id, label: c.name }))}
      />
      <Select<string | null>
        allowClear
        showSearch
        placeholder="State"
        style={{ width: 128 }}
        suffixIcon={<DownOutlined />}
        value={value.state}
        onChange={(state) => onChange({ ...value, state: state ?? null })}
        options={US_STATES.map((s) => ({ value: s, label: s }))}
      />
      <Select<ChoroplethMetric>
        style={{ width: 190 }}
        suffixIcon={<DownOutlined />}
        value={value.metric}
        onChange={(metric) => onChange({ ...value, metric })}
        options={METRIC_OPTIONS.map((m) => ({ value: m.value, label: `Colour by: ${m.label}` }))}
      />
      <Select<number>
        style={{ width: 150 }}
        suffixIcon={<DownOutlined />}
        value={value.minAmount}
        onChange={(minAmount) => onChange({ ...value, minAmount })}
        options={MIN_AMOUNT_OPTIONS}
      />
      <div className="dn-rt">
        <span className="dn-num" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>
          {resultCount}
        </span>{' '}
        district{resultCount === 1 ? '' : 's'}
        {hasFilters ? (
          <button
            type="button"
            className="dn-link-btn"
            onClick={() => onChange({ clientId: null, state: null, metric: value.metric, minAmount: 0 })}
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
