import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { openMeriWorkspaceWithContext } from '../../../components/chat/meri-window.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeatureEnabled } from '../../../lib/intel-feature-flags.js';
import {
  DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE,
  getSupplierFootprintStatus,
  supplierStatusLabel,
} from '../../../pages/intelligence/district-nexus/supplier-footprint-api.js';
import {
  formatMarketDate,
  futureSignalsAvailable,
  formatMarketMoney,
  getFederalMarketGeography,
  type FederalMarketGeographyResponse,
} from '../../../pages/intelligence/federal-spending/federal-market-api.js';
import { splitDistrictKey } from '../../../pages/intelligence/district-nexus/district-nexus-format.js';
import { DistrictEconomicFootprintPanelVNext } from './DistrictEconomicFootprintPanelVNext.js';
import { DnxInfoIcon } from './icons.js';

type FutureRow = FederalMarketGeographyResponse['futureSignals'][number];

function sumOrNull(values: Array<number | null>): number | null {
  const held = values.filter((value): value is number => value != null);
  return held.length ? held.reduce((sum, value) => sum + value, 0) : null;
}

function promptForDistrict(
  districtKey: string,
  contractAmount: number | null,
  districtSubawardAmount: number | null,
  stateOnlySubawardAmount: number | null,
  futureSignals: FutureRow[],
  futureAvailable: boolean,
  supplierContext: string,
): string {
  const signalSummary = futureSignals
    .slice(0, 4)
    .map(
      (signal) =>
        `${signal.source === 'agency_forecast' ? 'forecast' : 'SAM opportunity'}: ${signal.title}`,
    )
    .join('; ');
  return `Assess the federal market context for ${districtKey}. Source-backed prime contract obligations shown here: ${formatMarketMoney(contractAmount)}. Supplier coverage: ${supplierContext}. ${districtSubawardAmount == null ? '' : `District-resolved subawards: ${formatMarketMoney(districtSubawardAmount)}.`} ${stateOnlySubawardAmount == null ? '' : `State-only subawards that Capiro has NOT attributed to this district: ${formatMarketMoney(stateOnlySubawardAmount)}.`} Future signals: ${futureAvailable ? signalSummary || 'none in this view' : 'unavailable; lookup failed, not zero'}. Explain why this district may matter to the selected client, relevant government-affairs implications, and the next actions. Keep state-only subawards separate from district facts and never add future opportunities to awarded totals.`;
}

function signalGeography(signal: FutureRow): string {
  if (signal.districtKey) return signal.districtKey;
  if (signal.state) return `${signal.state} state-level`;
  return 'geography unresolved';
}

/**
 * Federal Market remains the typed source of truth for prime awards,
 * district-resolved subawards, state-only fallback context and future signals.
 * Release 3 composes its separately gated economic-footprint panel underneath;
 * it never replaces or heuristically reparses this established contract.
 */
export function DistrictFederalMarketPanelVNext({
  clientId,
  districtKey,
}: {
  clientId: string | null;
  districtKey: string;
}) {
  const api = useApi();
  const toast = useCapiroToast();
  const supplierEnabled = useIntelFeatureEnabled(DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE);
  const supplierQuery = useQuery({
    queryKey: ['district-nexus', 'supplier-footprint-status', clientId],
    queryFn: () => getSupplierFootprintStatus(api, clientId!),
    enabled: supplierEnabled && Boolean(clientId),
    staleTime: 60_000,
    retry: false,
  });
  const supplierDenied =
    (supplierQuery.error as { response?: { status?: number } } | null)?.response?.status === 404;
  const showSupplier = supplierEnabled && !supplierDenied;
  const supplierStatus = supplierQuery.isError ? 'unavailable' : supplierQuery.data?.status;
  const supplierAvailable = showSupplier && supplierStatus === 'available';
  // Partial corpus coverage is explicit EVEN when matches exist: the label is
  // qualified by sourceCompleteness, never collapsing "no matches yet" into a
  // real empty result while the sync is still in progress.
  const supplierLabel = !clientId
    ? 'Select a client'
    : supplierStatusLabel(supplierStatus, supplierQuery.data?.sourceCompleteness);
  const { state, districtNo } = splitDistrictKey(districtKey);
  const query = useQuery<FederalMarketGeographyResponse>({
    queryKey: ['district-nexus', 'federal-market-geography', clientId, districtKey],
    queryFn: () =>
      getFederalMarketGeography(api, {
        clientId: clientId ?? undefined,
        state,
        district: districtNo,
      }),
    staleTime: 60_000,
    retry: 1,
    enabled: Boolean(state && districtNo),
  });

  let marketContent: React.ReactNode = null;

  if (query.isPending) {
    marketContent = (
      <div className="dnx-skel-rows" aria-busy="true">
        <CapiroSkeleton height={14} width="42%" />
        <CapiroSkeleton height={14} />
        <CapiroSkeleton height={14} />
        <CapiroSkeleton height={14} width="72%" />
      </div>
    );
  } else if (query.isError) {
    marketContent = (
      <CapiroErrorState
        title="Federal market context is temporarily unavailable"
        description="The verified District Nexus score and district evidence above are unchanged."
        onRetry={() => void query.refetch()}
        retryLabel="Retry"
      />
    );
  } else if (query.data) {
    const data = query.data;
    const stateSubawards = data.stateSubawards ?? [];
    const districtRows = data.districts.filter((row) => row.districtKey === districtKey);
    const contractAmount = sumOrNull(districtRows.map((row) => row.contractAmount));
    const districtSubawardAmount = supplierAvailable
      ? sumOrNull(districtRows.map((row) => row.subawardAmount))
      : null;
    const stateOnlySubawardAmount = supplierAvailable
      ? sumOrNull(
          stateSubawards.filter((row) => row.state === state).map((row) => row.subawardAmount),
        )
      : null;
    const stateOnlySubawardCount = stateSubawards
      .filter((row) => row.state === state)
      .reduce((sum, row) => sum + row.subawardCount, 0);
    const futureAvailable = futureSignalsAvailable(data);
    const futureSignals = data.futureSignals
      .filter(
        (signal) =>
          signal.districtKey === districtKey || (!signal.districtKey && signal.state === state),
      )
      .slice(0, 5);

    const explorerParams = new URLSearchParams({ state, district: districtNo });
    if (clientId) explorerParams.set('clientId', clientId);

    const askMeri = async () => {
      const prompt = promptForDistrict(
        districtKey,
        contractAmount,
        districtSubawardAmount,
        stateOnlySubawardAmount,
        futureSignals,
        futureAvailable,
        showSupplier
          ? `${supplierLabel}${
              supplierQuery.data?.note && !supplierQuery.isError
                ? `. ${supplierQuery.data.note}`
                : ''
            }${
              supplierQuery.data?.sourceCompleteness &&
              supplierQuery.data.sourceCompleteness !== 'complete' &&
              supplierQuery.data.sourceCoverageNote &&
              !supplierQuery.isError
                ? ` ${supplierQuery.data.sourceCoverageNote}`
                : ''
            }`
          : 'Not enabled in this view',
      );
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(prompt);
          copied = true;
        }
      } catch {
        copied = false;
      }
      const popup = openMeriWorkspaceWithContext({ prompt, clientId });
      if (!popup) {
        toast.error(
          copied
            ? 'The Meri window was blocked. The district prompt is copied to your clipboard.'
            : 'The Meri window was blocked. Allow pop-ups for Capiro and try again.',
        );
        return;
      }
      toast.success(
        copied
          ? 'Meri opened with this district context. A backup copy is on your clipboard.'
          : 'Meri opened with this district context.',
      );
    };

    marketContent = (
      <div className="dnx-market-context">
        <div className="dnx-market-grid">
          <div>
            <span>Prime contracts</span>
            <strong>{formatMarketMoney(contractAmount)}</strong>
            <small>District place of performance</small>
          </div>
          {showSupplier ? (
            <div aria-label="Supplier coverage">
              <span>Subawards</span>
              <strong>
                {supplierAvailable
                  ? districtSubawardAmount != null
                    ? formatMarketMoney(districtSubawardAmount)
                    : districtRows.some((row) => row.subawardCount > 0)
                      ? 'Amount not reported'
                      : 'No district-resolved records'
                  : supplierLabel}
              </strong>
              <small>
                {supplierAvailable
                  ? supplierQuery.data?.sourceCompleteness === 'complete'
                    ? 'District-resolved only'
                    : 'District-resolved · records ingested so far'
                  : 'Client supplier coverage'}
              </small>
            </div>
          ) : null}
          <div>
            <span>Future signals</span>
            <strong>{futureAvailable ? futureSignals.length : 'Unavailable'}</strong>
            <small>Not awarded money</small>
          </div>
        </div>

        {showSupplier && supplierQuery.data && !supplierQuery.isError ? (
          <div className="dnx-muted" style={{ marginTop: 10 }}>
            {supplierQuery.data.note}
            {supplierQuery.data.lastSuccessfulSyncAt
              ? ` Last subaward sync: ${formatMarketDate(supplierQuery.data.lastSuccessfulSyncAt)}.`
              : ''}
            {supplierQuery.data.sourceCompleteness !== 'complete' &&
            supplierQuery.data.sourceCoverageNote
              ? ` ${supplierQuery.data.sourceCoverageNote}`
              : ''}
          </div>
        ) : null}

        {supplierAvailable && stateOnlySubawardCount > 0 ? (
          <div className="dnx-hint dnx-info" style={{ marginTop: 10 }}>
            <div>
              <b>
                {formatMarketMoney(stateOnlySubawardAmount)} in {state}-level subawards
              </b>{' '}
              across {stateOnlySubawardCount} record
              {stateOnlySubawardCount === 1 ? '' : 's'} cannot be assigned to {districtKey} from the
              source data. They are shown as context only.
            </div>
          </div>
        ) : null}

        {data.warnings.length ? (
          <div className="dnx-hint dnx-notable" style={{ marginTop: 10 }}>
            <span className="dnx-hico">
              <DnxInfoIcon />
            </span>
            <div>
              <b>Some market context is incomplete</b>
              <div>{data.warnings.join(' · ')}</div>
            </div>
          </div>
        ) : null}

        {!futureAvailable ? (
          <div className="dnx-muted" style={{ marginTop: 10 }}>
            Future procurement signals are temporarily unavailable.
          </div>
        ) : futureSignals.length ? (
          <div className="dnx-market-signals">
            <strong className="dnx-market-signals-title">Upcoming signals</strong>
            {futureSignals.map((signal) => (
              <div className="dnx-market-signal" key={signal.id}>
                <div>
                  <strong>{signal.title}</strong>
                  <span>
                    {signal.agency ?? 'Agency not stated'} · {formatMarketDate(signal.date)} ·{' '}
                    {signalGeography(signal)}
                  </span>
                </div>
                <CapiroBadge tone={signal.source === 'agency_forecast' ? 'success' : 'info'}>
                  {signal.source === 'agency_forecast' ? 'Forecast' : 'SAM.gov'}
                </CapiroBadge>
              </div>
            ))}
          </div>
        ) : (
          <div className="dnx-muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            No district- or state-backed future procurement signal is available in this view.
          </div>
        )}

        <div className="dnx-actions-row">
          <Link to={`/intelligence/federal-spending?${explorerParams.toString()}`}>
            <CapiroButton size="compact">Open Federal Spending →</CapiroButton>
          </Link>
          <CapiroButton size="compact" variant="primary" onClick={() => void askMeri()}>
            Ask Meri
          </CapiroButton>
        </div>
      </div>
    );
  }

  return (
    <div className="dnx-federal-market">
      {marketContent}
      <div
        style={{
          marginTop: 16,
          paddingTop: 16,
          borderTop: '1px solid var(--uui-gray-200)',
        }}
      >
        <DistrictEconomicFootprintPanelVNext clientId={clientId} districtKey={districtKey} />
      </div>
    </div>
  );
}
