import { useQuery } from '@tanstack/react-query';
import { CapiroSelect } from '../../components/fields/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { useApi } from '../../../lib/use-api.js';
import { METRIC_OPTIONS, formatMoney, type ChoroplethMetric } from '../../../pages/intelligence/district-nexus/district-nexus-format.js';

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
  { value: '0', label: 'Any amount' },
  { value: '1000000', label: `≥ ${formatMoney(1_000_000, 0)}` },
  { value: '5000000', label: `≥ ${formatMoney(5_000_000, 0)}` },
  { value: '10000000', label: `≥ ${formatMoney(10_000_000, 0)}` },
];

export interface DistrictNexusFilterState {
  clientId: string | null;
  state: string | null;
  metric: ChoroplethMetric;
  minAmount: number;
  /** When true and a client is selected, filter map/table to strategic gap districts. */
  gapFilter: boolean;
}

interface Props {
  value: DistrictNexusFilterState;
  onChange: (next: DistrictNexusFilterState) => void;
  resultCount: number;
  /** Strategic gap toggle is only meaningful with client + strategic flag. */
  strategicGapAvailable?: boolean;
}

/**
 * vNext port of the canonical WS-G filter bar. Client and State are
 * server-backed (real query params on GET district-nexus/map); Colour-by and
 * Minimum funding are computed client-side over the already-fetched response.
 * Deliberately omits the plan's aspirational Nexus-type / Agency /
 * Assistance-Listing / Verification filters: DistrictNexusDistrictSummary
 * (the map-aggregate row WS-E1 actually ships) carries no per-type evidence
 * flags, no agency breakdown and no verification-status field to filter on —
 * building those controls would be dead UI wired to nothing. Closing that gap
 * needs an E1 response enrichment, which is backend work outside WS-G.
 *
 * Presentation deviation from canonical (antd Select → CapiroSelect): native
 * selects carry visible field labels and explicit "All …" options in place of
 * antd's placeholder + allowClear + type-ahead search.
 */
export function DistrictNexusFiltersVNext({
  value,
  onChange,
  resultCount,
  strategicGapAvailable,
}: Props) {
  const api = useApi();
  const clients = useQuery<ClientOption[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientOption[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const visibleClients = (clients.data ?? []).filter((c) => c.status !== 'archived');

  const hasFilters =
    value.clientId != null || value.state != null || value.minAmount > 0 || value.gapFilter;

  return (
    <div className="dnx-fbar">
      <CapiroSelect
        label="Client"
        aria-label="Filter by client"
        className="dnx-select-client"
        value={value.clientId ?? ''}
        onChange={(e) =>
          onChange({
            ...value,
            clientId: e.target.value || null,
            // Gap analysis is client-scoped — clear when client clears.
            gapFilter: e.target.value ? value.gapFilter : false,
          })
        }
        options={[
          { value: '', label: clients.isLoading ? 'Loading clients…' : 'All clients' },
          ...visibleClients.map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      <CapiroSelect
        label="State"
        aria-label="Filter by state"
        value={value.state ?? ''}
        onChange={(e) => onChange({ ...value, state: e.target.value || null })}
        options={[{ value: '', label: 'All states' }, ...US_STATES.map((s) => ({ value: s, label: s }))]}
      />
      <CapiroSelect
        label="Colour by"
        aria-label="Colour the map by"
        value={value.metric}
        onChange={(e) => onChange({ ...value, metric: e.target.value as ChoroplethMetric })}
        options={METRIC_OPTIONS.map((m) => ({ value: m.value, label: m.label }))}
      />
      <CapiroSelect
        label="Minimum funding"
        aria-label="Minimum public funding"
        value={String(value.minAmount)}
        onChange={(e) => onChange({ ...value, minAmount: Number(e.target.value) || 0 })}
        options={MIN_AMOUNT_OPTIONS}
      />
      {strategicGapAvailable ? (
        <CapiroSelect
          label="Opportunity / gaps"
          aria-label="Filter by strategic gaps"
          value={value.gapFilter ? 'gaps' : ''}
          onChange={(e) => onChange({ ...value, gapFilter: e.target.value === 'gaps' })}
          options={[
            { value: '', label: 'All districts' },
            { value: 'gaps', label: 'Strategic gaps only' },
          ]}
        />
      ) : null}
      <div className="dnx-rt">
        <span className="dnx-num dnx-count">{resultCount}</span> district{resultCount === 1 ? '' : 's'}
        {hasFilters ? (
          <CapiroButton
            variant="quiet"
            size="compact"
            onClick={() =>
              onChange({
                clientId: null,
                state: null,
                metric: value.metric,
                minAmount: 0,
                gapFilter: false,
              })
            }
          >
            Clear filters
          </CapiroButton>
        ) : null}
      </div>
    </div>
  );
}
