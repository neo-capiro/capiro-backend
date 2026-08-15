import { useQuery } from '@tanstack/react-query';
import { App as AntApp, Alert, Button, Skeleton, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { openMeriWorkspaceWithContext } from '../../../components/chat/meri-window.js';
import { useApi } from '../../../lib/use-api.js';
import {
  formatMarketDate,
  formatMarketMoney,
  getFederalMarketGeography,
  type FederalMarketGeographyResponse,
} from '../federal-spending/federal-market-api.js';
import { splitDistrictKey } from './district-nexus-format.js';
import './district-federal-market.css';

const { Text } = Typography;

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
): string {
  const signalSummary = futureSignals
    .slice(0, 4)
    .map(
      (signal) =>
        `${signal.source === 'agency_forecast' ? 'forecast' : 'SAM opportunity'}: ${signal.title}`,
    )
    .join('; ');
  return `Assess the federal market context for ${districtKey}. Source-backed prime contract obligations shown here: ${formatMarketMoney(contractAmount)}. District-resolved subawards: ${formatMarketMoney(districtSubawardAmount)}. State-only subawards that Capiro has NOT attributed to this district: ${formatMarketMoney(stateOnlySubawardAmount)}. Future signals: ${signalSummary || 'none in this view'}. Explain why this district may matter to the selected client, relevant government-affairs implications, and the next actions. Keep state-only subawards separate from district facts and never add future opportunities to awarded totals.`;
}

function signalGeography(signal: FutureRow): string {
  if (signal.districtKey) return signal.districtKey;
  if (signal.state) return `${signal.state} state-level`;
  return 'geography unresolved';
}

export function DistrictFederalMarketPanel({
  clientId,
  districtKey,
}: {
  clientId: string | null;
  districtKey: string;
}) {
  const api = useApi();
  const { message } = AntApp.useApp();
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

  if (query.isPending) return <Skeleton active paragraph={{ rows: 4 }} />;

  if (query.isError) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Federal market context is temporarily unavailable"
        description="The verified District Nexus score and district evidence above are unchanged."
        action={
          <Button size="small" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const data = query.data;
  if (!data) return null;
  const stateSubawards = data.stateSubawards ?? [];
  const districtRows = data.districts.filter((row) => row.districtKey === districtKey);
  const contractAmount = sumOrNull(districtRows.map((row) => row.contractAmount));
  const districtSubawardAmount = sumOrNull(districtRows.map((row) => row.subawardAmount));
  const stateOnlySubawardAmount = sumOrNull(
    stateSubawards.filter((row) => row.state === state).map((row) => row.subawardAmount),
  );
  const stateOnlySubawardCount = stateSubawards
    .filter((row) => row.state === state)
    .reduce((sum, row) => sum + row.subawardCount, 0);
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
      message.warning(
        copied
          ? 'The Meri window was blocked. The district prompt is copied to your clipboard.'
          : 'The Meri window was blocked. Allow pop-ups for Capiro and try again.',
      );
      return;
    }
    message.success(
      copied
        ? 'Meri opened with this district context. A backup copy is on your clipboard.'
        : 'Meri opened with this district context.',
    );
  };

  return (
    <div className="dn-market-context">
      <div className="dn-market-grid">
        <div>
          <span>Prime contracts</span>
          <strong>{formatMarketMoney(contractAmount)}</strong>
          <small>District place of performance</small>
        </div>
        <div>
          <span>Subawards</span>
          <strong>{formatMarketMoney(districtSubawardAmount)}</strong>
          <small>District-resolved only</small>
        </div>
        <div>
          <span>Future signals</span>
          <strong>{futureSignals.length}</strong>
          <small>Not awarded money</small>
        </div>
      </div>

      {stateOnlySubawardCount > 0 ? (
        <div className="dn-hint dn-info" style={{ marginTop: 10 }}>
          <div>
            <b>
              {formatMarketMoney(stateOnlySubawardAmount)} in {state}-level subawards
            </b>{' '}
            across {stateOnlySubawardCount} record{stateOnlySubawardCount === 1 ? '' : 's'} cannot
            be assigned to {districtKey} from the source data. They are shown as context only.
          </div>
        </div>
      ) : null}

      {data.warnings.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 10 }}
          message="Some market context is incomplete"
          description={data.warnings.join(' · ')}
        />
      ) : null}

      {futureSignals.length ? (
        <div className="dn-market-signals">
          <Text strong>Upcoming signals</Text>
          {futureSignals.map((signal) => (
            <div className="dn-market-signal" key={signal.id}>
              <div>
                <strong>{signal.title}</strong>
                <span>
                  {signal.agency ?? 'Agency not stated'} · {formatMarketDate(signal.date)} ·{' '}
                  {signalGeography(signal)}
                </span>
              </div>
              <Tag color={signal.source === 'agency_forecast' ? 'cyan' : 'blue'}>
                {signal.source === 'agency_forecast' ? 'Forecast' : 'SAM.gov'}
              </Tag>
            </div>
          ))}
        </div>
      ) : (
        <div className="dn-muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          No district- or state-backed future procurement signal is available in this view.
        </div>
      )}

      <Space wrap style={{ marginTop: 14 }}>
        <Link to={`/intelligence/federal-spending?${explorerParams.toString()}`}>
          <Button size="small">Open Federal Spending →</Button>
        </Link>
        <Button size="small" type="primary" onClick={() => void askMeri()}>
          Ask Meri
        </Button>
      </Space>
    </div>
  );
}
