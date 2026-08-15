import { App as AntApp, Button, Drawer, Space, Tag, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { openMeriWorkspaceWithContext } from '../../../components/chat/meri-window.js';
import {
  formatMarketDate,
  formatMarketMoney,
  type FederalContractMarketRow,
  type FederalForecastMarketRow,
  type FederalMarketRow,
  type FederalMarketTab,
  type FederalSubawardMarketRow,
  type FederalVehicleMarketRow,
} from './federal-market-api.js';

const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  tab: FederalMarketTab;
  row: FederalMarketRow | null;
  clientId?: string;
  clientName?: string | null;
  onClose: () => void;
}

interface DetailItem {
  label: string;
  value: string;
}

function sourceLabel(row: FederalMarketRow): string {
  return row.source === 'tango' ? 'MakeGov / Tango' : 'USAspending';
}

function titleFor(tab: FederalMarketTab, row: FederalMarketRow): string {
  if (tab === 'contracts')
    return (row as FederalContractMarketRow).recipientName ?? 'Contract award';
  if (tab === 'subawards') return (row as FederalSubawardMarketRow).subawardeeName ?? 'Subaward';
  if (tab === 'vehicles') return (row as FederalVehicleMarketRow).name ?? 'Contract vehicle';
  return (row as FederalForecastMarketRow).title;
}

function eyebrowFor(tab: FederalMarketTab): string {
  if (tab === 'contracts') return 'CONTRACT AWARD';
  if (tab === 'subawards') return 'SUBAWARD';
  if (tab === 'vehicles') return 'CONTRACT VEHICLE';
  return 'PROCUREMENT FORECAST';
}

function descriptionFor(tab: FederalMarketTab, row: FederalMarketRow): string | null {
  if (tab === 'contracts') return (row as FederalContractMarketRow).description;
  if (tab === 'subawards') return (row as FederalSubawardMarketRow).description;
  if (tab === 'forecasts') return (row as FederalForecastMarketRow).description;
  return null;
}

function sourceUrlFor(tab: FederalMarketTab, row: FederalMarketRow): string | null {
  if (tab === 'subawards') return (row as FederalSubawardMarketRow).sourceUrl;
  if (tab === 'forecasts') return (row as FederalForecastMarketRow).sourceUrl;
  return null;
}

function districtContextFor(
  tab: FederalMarketTab,
  row: FederalMarketRow,
): { districtKey: string; state: string } | null {
  if (tab === 'contracts') {
    const item = row as FederalContractMarketRow;
    return item.districtKey && item.state
      ? { districtKey: item.districtKey, state: item.state }
      : null;
  }
  if (tab === 'subawards') {
    const item = row as FederalSubawardMarketRow;
    return item.districtKey && item.state
      ? { districtKey: item.districtKey, state: item.state }
      : null;
  }
  return null;
}

function detailsFor(tab: FederalMarketTab, row: FederalMarketRow): DetailItem[] {
  if (tab === 'contracts') {
    const item = row as FederalContractMarketRow;
    return [
      { label: 'Award', value: item.awardId ?? 'Not stated' },
      { label: 'UEI', value: item.recipientUei ?? 'Not stated' },
      { label: 'Awarding agency', value: item.awardingAgency ?? 'Not stated' },
      { label: 'Obligated', value: formatMarketMoney(item.amount) },
      { label: 'Action date', value: formatMarketDate(item.actionDate) },
      { label: 'Place of performance', value: item.districtKey ?? item.state ?? 'Not stated' },
    ];
  }
  if (tab === 'subawards') {
    const item = row as FederalSubawardMarketRow;
    return [
      { label: 'Prime', value: item.primeRecipientName ?? 'Not stated' },
      { label: 'Subrecipient UEI', value: item.subawardeeUei ?? 'Not stated' },
      { label: 'Prime UEI', value: item.primeRecipientUei ?? 'Not stated' },
      {
        label: 'Awarding office',
        value:
          [item.awardingAgency, item.awardingOffice].filter(Boolean).join(' · ') || 'Not stated',
      },
      { label: 'Subaward amount', value: formatMarketMoney(item.amount) },
      { label: 'Action date', value: formatMarketDate(item.actionDate) },
      { label: 'NAICS', value: item.naicsCode ?? 'Not stated' },
      {
        label: 'Place of performance',
        value:
          item.districtKey ?? (item.state ? `${item.state} · district not verified` : 'Not stated'),
      },
    ];
  }
  if (tab === 'vehicles') {
    const item = row as FederalVehicleMarketRow;
    return [
      { label: 'Vehicle type', value: item.vehicleType ?? 'Not stated' },
      { label: 'Solicitation', value: item.solicitationIdentifier ?? 'Not stated' },
      { label: 'Agency', value: item.agency ?? 'Not stated' },
      { label: 'NAICS', value: item.naicsCode ?? 'Not stated' },
      { label: 'PSC', value: item.pscCode ?? 'Not stated' },
      { label: 'Set-aside', value: item.setAside ?? 'Not stated' },
      {
        label: 'Orders',
        value: item.orderCount == null ? 'Unknown' : item.orderCount.toLocaleString(),
      },
      { label: 'Vehicle obligations', value: formatMarketMoney(item.totalObligated) },
      { label: 'Last date to order', value: formatMarketDate(item.lastDateToOrder) },
      {
        label: 'Client position',
        value:
          item.relationship === 'self'
            ? 'Direct vehicle access evidence'
            : item.relationship === 'parent'
              ? 'Related-entity access evidence'
              : 'Market catalog record',
      },
    ];
  }

  const item = row as FederalForecastMarketRow;
  return [
    {
      label: 'Agency / office',
      value: [item.agency, item.office].filter(Boolean).join(' · ') || 'Not stated',
    },
    { label: 'Anticipated award', value: formatMarketDate(item.anticipatedAwardDate) },
    {
      label: 'Fiscal year',
      value: item.fiscalYear == null ? 'Not stated' : `FY${item.fiscalYear}`,
    },
    { label: 'NAICS', value: item.naicsCode ?? 'Not stated' },
    { label: 'PSC', value: item.pscCode ?? 'Not stated' },
    { label: 'Set-aside', value: item.setAside ?? 'Not stated' },
    { label: 'Expected vehicle', value: item.contractVehicle ?? 'Not stated' },
    { label: 'Place of performance', value: item.placeOfPerformance ?? 'Not stated' },
    { label: 'Forecast status', value: item.status ?? 'Agency forecast' },
    {
      label: 'Contact',
      value: [item.contactName, item.contactEmail].filter(Boolean).join(' · ') || 'Not stated',
    },
  ];
}

function promptFor(
  tab: FederalMarketTab,
  row: FederalMarketRow,
  clientName?: string | null,
): string {
  const title = titleFor(tab, row);
  const scope = clientName ? ` for ${clientName}` : '';
  if (tab === 'contracts') {
    const item = row as FederalContractMarketRow;
    return `Analyze this federal contract award${scope}: ${title}; award ${item.awardId ?? 'not stated'}; agency ${item.awardingAgency ?? 'not stated'}; obligated ${formatMarketMoney(item.amount)}; action date ${formatMarketDate(item.actionDate)}; place ${item.districtKey ?? item.state ?? 'not stated'}. Explain why it matters, relevant client or government context, and the next actions. Separate facts, context, and inference.`;
  }
  if (tab === 'subawards') {
    const item = row as FederalSubawardMarketRow;
    return `Analyze this federal subaward${scope}: subrecipient ${item.subawardeeName ?? 'not stated'}; prime ${item.primeRecipientName ?? 'not stated'}; agency ${item.awardingAgency ?? 'not stated'}; amount ${formatMarketMoney(item.amount)}; action date ${formatMarketDate(item.actionDate)}; place ${item.districtKey ?? item.state ?? 'not stated'}. Explain the market or relationship significance and next actions. Do not add this amount to the prime award amount.`;
  }
  if (tab === 'vehicles') {
    const item = row as FederalVehicleMarketRow;
    return `Assess this federal contract vehicle${scope}: ${title}; type ${item.vehicleType ?? 'not stated'}; solicitation ${item.solicitationIdentifier ?? 'not stated'}; orders ${item.orderCount ?? 'unknown'}; obligations ${formatMarketMoney(item.totalObligated)}; client position ${item.relationship ?? 'not established'}. Explain acquisition access, relevant incumbents or routes, risks, and what the government-affairs or capture team should do next. Do not treat vehicle access as eligibility or win probability.`;
  }
  const item = row as FederalForecastMarketRow;
  return `Assess this agency procurement forecast${scope}: ${title}; agency ${item.agency ?? 'not stated'}; anticipated award ${formatMarketDate(item.anticipatedAwardDate)}; NAICS ${item.naicsCode ?? 'not stated'}; vehicle ${item.contractVehicle ?? 'not stated'}; place ${item.placeOfPerformance ?? 'not stated'}. Treat it as an early signal, not an open solicitation. Explain why it may matter, what should be verified, and what shaping actions are appropriate now.`;
}

export function FederalMarketDetailDrawer({
  open,
  tab,
  row,
  clientId,
  clientName,
  onClose,
}: Props) {
  const { message } = AntApp.useApp();
  if (!row) return null;

  const title = titleFor(tab, row);
  const description = descriptionFor(tab, row);
  const sourceUrl = sourceUrlFor(tab, row);
  const districtContext = districtContextFor(tab, row);
  const details = detailsFor(tab, row);
  const prompt = promptFor(tab, row, clientName);

  const districtUrl = (() => {
    if (!districtContext) return null;
    const params = new URLSearchParams({
      state: districtContext.state,
      district: districtContext.districtKey,
    });
    if (clientId) params.set('clientId', clientId);
    return `/intelligence/district-nexus?${params.toString()}`;
  })();

  const askMeri = async () => {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
        copied = true;
      }
    } catch {
      copied = false;
    }

    const popup = openMeriWorkspaceWithContext({ prompt, clientId: clientId ?? null });
    if (!popup) {
      message.warning(
        copied
          ? 'The Meri window was blocked. The contextual prompt is copied to your clipboard.'
          : 'The Meri window was blocked. Allow pop-ups for Capiro and try again.',
      );
      return;
    }
    message.success(
      copied
        ? 'Meri opened with this record context. A backup copy is on your clipboard.'
        : 'Meri opened with this record context.',
    );
  };

  return (
    <Drawer
      className="fsm-detail-drawer"
      open={open}
      onClose={onClose}
      width={Math.min(560, typeof window !== 'undefined' ? window.innerWidth - 20 : 560)}
      destroyOnClose
      title={
        <div className="fsm-drawer-title">
          <span>{eyebrowFor(tab)}</span>
          <strong>{title}</strong>
        </div>
      }
      extra={
        <Button type="primary" onClick={() => void askMeri()}>
          Ask Meri
        </Button>
      }
    >
      <div className="fsm-drawer-meta">
        <Tag>{sourceLabel(row)}</Tag>
        <Text type="secondary">
          {row.sourceUpdatedAt
            ? `Source current to ${new Date(row.sourceUpdatedAt).toLocaleString()}`
            : 'Source freshness unavailable'}
        </Text>
      </div>

      {description ? <Paragraph className="fsm-drawer-description">{description}</Paragraph> : null}

      <div className="fsm-detail-grid">
        {details.map((detail) => (
          <div className="fsm-detail-item" key={detail.label}>
            <span>{detail.label}</span>
            <strong>{detail.value}</strong>
          </div>
        ))}
      </div>

      {tab === 'vehicles' ? (
        <div className="fsm-drawer-note">
          Vehicle obligations are market context. They are not the value of an opportunity and do
          not imply probability of win.
        </div>
      ) : null}
      {tab === 'forecasts' ? (
        <div className="fsm-drawer-note">
          This is an agency planning signal. It is not an open solicitation and has no inferred
          response deadline.
        </div>
      ) : null}

      <Space wrap style={{ marginTop: 22 }}>
        {sourceUrl ? (
          <Button href={sourceUrl} target="_blank" rel="noreferrer" icon={<ExportOutlined />}>
            Open source
          </Button>
        ) : null}
        {districtUrl ? <Button href={districtUrl}>View District Nexus</Button> : null}
        <Button onClick={onClose}>Done</Button>
      </Space>
    </Drawer>
  );
}
