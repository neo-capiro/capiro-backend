import { Card, Empty, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type {
  ProgramElementContractor,
  ProgramElementContractorsResponse,
  ProgramElementNamedPrime,
} from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text } = Typography;

export interface ContractorsPanelProps {
  contractors: ProgramElementContractorsResponse | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

function dollarsCompact(amountMm: number): string {
  if (amountMm >= 1000) {
    return `$${(amountMm / 1000).toFixed(1)}B`;
  }
  return `$${amountMm.toFixed(1)}M`;
}

const columns: ColumnsType<ProgramElementContractor> = [
  {
    title: 'Contractor',
    dataIndex: 'contractorName',
    key: 'contractorName',
    render: (name: string, row) => (
      <span>
        {name} {row.contractorIsCrmClient ? <Tag color="blue">CRM Client</Tag> : null}
        {row.isNewEntrant ? <Tag color="warning">New</Tag> : null}
        {row.source === 'program' ? (
          <Tooltip title={row.attribution ?? 'Linked via DoD Acquisition Program (USAspending)'}>
            <Tag color="geekblue">via Acq Program</Tag>
          </Tooltip>
        ) : null}
      </span>
    ),
  },
  {
    title: '$ obligated (24 mo)',
    dataIndex: 'amount',
    key: 'amount',
    align: 'right',
    sorter: (a, b) => a.amount - b.amount,
    defaultSortOrder: 'descend',
    render: (value: number) => dollarsCompact(value),
  },
  {
    title: 'Awards',
    dataIndex: 'awards',
    key: 'awards',
    align: 'right',
    render: (value: number | null | undefined) =>
      typeof value === 'number' ? value.toLocaleString() : '—',
  },
];

// Named primes lifted straight from the Service's own R-3 "Product Development"
// budget exhibit. The government names the performing activity per PE, so these
// rows carry page-level provenance and need no inference.
const namedPrimeColumns: ColumnsType<ProgramElementNamedPrime> = [
  {
    title: 'Prime',
    dataIndex: 'contractorName',
    key: 'contractorName',
    render: (name: string, row) => (
      <span>
        {name}
        {row.contractMethod ? (
          <Tooltip title="Contract method per the R-3 exhibit">
            <Tag color="purple" style={{ marginLeft: 6 }}>
              {row.contractMethod}
            </Tag>
          </Tooltip>
        ) : null}
      </span>
    ),
  },
  {
    title: 'Location',
    dataIndex: 'location',
    key: 'location',
    render: (loc: string | null) => loc ?? '—',
  },
  {
    title: 'Stated value',
    dataIndex: 'totalCostM',
    key: 'totalCostM',
    align: 'right',
    sorter: (a, b) => (a.totalCostM ?? -1) - (b.totalCostM ?? -1),
    defaultSortOrder: 'descend',
    render: (value: number | null) => (typeof value === 'number' ? dollarsCompact(value) : '—'),
  },
  {
    title: 'Source',
    key: 'source',
    align: 'right',
    render: (_: unknown, row) => {
      const label = `${row.publisher ?? 'DoD'}${row.fy ? ` FY${row.fy}` : ''} R-3${
        row.pageNumber ? ` p.${row.pageNumber}` : ''
      }`;
      const tag = (
        <Tooltip title={row.attribution}>
          <Tag color="green">{label}</Tag>
        </Tooltip>
      );
      return row.sourceUrl ? (
        <a
          href={row.pageNumber ? `${row.sourceUrl}#page=${row.pageNumber}` : row.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          {tag}
        </a>
      ) : (
        tag
      );
    },
  },
];

export function ContractorsPanel({ contractors, loading = false, errored = false, onRetry }: ContractorsPanelProps) {
  if (loading) {
    return (
      <Card title="Top contractors touching this PE">
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="contractors" testId="pe-secondary-failed-contractors" onRetry={onRetry} />
    );
  }


  const namedPrimes = contractors?.namedPrimes ?? [];
  const rows = contractors?.data ?? [];

  if (namedPrimes.length === 0 && rows.length === 0) {
    return (
      <Card className="pe-contractors-card" title="Top contractors touching this PE">
        <Empty
          description={
            contractors?.todo ??
            'No contractors linked to this program element yet. Capiro links awards by DoD acquisition program; programs without a contract-level program code (services, support) will not appear here.'
          }
        />
      </Card>
    );
  }

  const top10 = rows.slice(0, 10);
  const hasProgramLinked = top10.some((r) => r.source === 'program');

  return (
    <Card className="pe-contractors-card" title="Top contractors touching this PE">
      {contractors?.todo ? (
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          {contractors.todo}
        </Text>
      ) : null}

      {namedPrimes.length > 0 ? (
        <div style={{ marginBottom: rows.length > 0 ? 20 : 0 }}>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            Named primes (per Service budget exhibit)
          </Text>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            Companies the Service names as the performing activity for this program element in
            its R-3 “Product Development” exhibit — a direct, document-level attribution.
          </Text>
          <div className="pe-scroll-5 pe-scroll-table">
            <Table<ProgramElementNamedPrime>
              rowKey={(row) => `${row.contractorName}-${row.fy ?? ''}-${row.pageNumber ?? ''}`}
              size="small"
              pagination={false}
              columns={namedPrimeColumns}
              dataSource={namedPrimes}
            />
          </div>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          {namedPrimes.length > 0 ? (
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              Award dollar flow (USAspending, last 24 months)
            </Text>
          ) : null}
          <div className="pe-scroll-5 pe-scroll-table">
            <Table<ProgramElementContractor>
              rowKey={(row) => row.contractorName}
              size="small"
              pagination={false}
              columns={columns}
              dataSource={top10}
              rowClassName={(row) => {
                if (row.isNewEntrant) return 'contractor-row-warning contractor-row-highlight';
                if (row.contractorIsCrmClient) return 'contractor-row-crm contractor-row-highlight';
                return '';
              }}
            />
          </div>
          {hasProgramLinked ? (
            <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              Rows tagged “via Acq Program” are linked through the contract’s DoD acquisition
              program code (USAspending), not a direct program-element attribution.
            </Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

export function formatContractorDollars(amountMm: number): string {
  return dollarsCompact(amountMm);
}
