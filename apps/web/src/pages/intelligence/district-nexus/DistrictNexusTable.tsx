import { Table, Tag, Tooltip } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import type { DistrictNexusDistrictSummary } from './district-nexus-api.js';
import { bandOf, formatMoney, formatNumber } from './district-nexus-format.js';

interface Props {
  districts: DistrictNexusDistrictSummary[];
  selectedDistrictKey: string | null;
  onSelectDistrict: (districtKey: string) => void;
  /** Compact variant is used as the map's failure fallback (§8.6); the
   * standalone variant gets more breathing room. Both share every column and
   * every honest-state rule below. */
  compact?: boolean;
}

/**
 * WS-G Step G5 — the district table. A first-class alternative to the map,
 * not an afterthought: every district the map could show is reachable here
 * by keyboard, and this is what replaces the map entirely when the boundary
 * artifact or WebGL is unavailable (§8.6).
 *
 * Deliberately has NO "Representative" column: DistrictNexusDistrictSummary
 * (the map-aggregate row) does not carry representation — that only exists
 * on the per-district detail response, and fetching it for every row here
 * would be exactly the N+1 the aggregation service's docblock forbids. Open
 * a row to see representatives in the drawer.
 */
export function DistrictNexusTable({ districts, selectedDistrictKey, onSelectDistrict, compact }: Props) {
  return (
    <Table<DistrictNexusDistrictSummary>
      className="dn-table"
      size={compact ? 'small' : 'middle'}
      rowKey="districtKey"
      dataSource={districts}
      pagination={!compact && districts.length > 25 ? { pageSize: 25, size: 'small' } : false}
      scroll={compact ? { y: '100%' } : undefined}
      locale={{
        emptyText: 'No districts match these filters. Nothing was hidden by an error — the filter set simply has no results.',
      }}
      onRow={(record) => ({
        onClick: () => onSelectDistrict(record.districtKey),
        style: { cursor: 'pointer' },
      })}
      rowClassName={(record) => (record.districtKey === selectedDistrictKey ? 'dn-table-row-selected' : '')}
      columns={[
        {
          title: 'District',
          dataIndex: 'districtKey',
          key: 'districtKey',
          width: 92,
          render: (key: string, record) => (
            <span className="dn-num" style={{ fontWeight: 700 }}>
              {key}
              {record.status === 'F' ? (
                <Tag color="purple" style={{ marginLeft: 6 }}>
                  future
                </Tag>
              ) : null}
            </span>
          ),
        },
        {
          title: 'Name',
          dataIndex: 'name',
          key: 'name',
          ellipsis: true,
          render: (name: string | null) => name ?? <span className="dn-muted">—</span>,
        },
        {
          title: 'Nexus',
          dataIndex: 'score',
          key: 'score',
          width: 130,
          sorter: (a, b) => (a.score ?? -1) - (b.score ?? -1),
          render: (score: number | null) => {
            const band = bandOf(score);
            if (!band) return <span className="dn-muted">Unscored</span>;
            return (
              <span style={{ color: band.color, fontWeight: 700 }}>
                {band.label} <span className="dn-num">{score}</span>
              </span>
            );
          },
        },
        {
          title: 'Coverage',
          dataIndex: 'coveragePercent',
          key: 'coveragePercent',
          width: 92,
          align: 'right',
          sorter: (a, b) => a.coveragePercent - b.coveragePercent,
          render: (pct: number) => <span className="dn-num">{pct}%</span>,
        },
        {
          title: 'Contracts',
          key: 'contracts',
          width: 110,
          align: 'right',
          sorter: (a, b) => (a.awarded.contractObligations ?? -1) - (b.awarded.contractObligations ?? -1),
          render: (_: unknown, record) => (
            <span className="dn-num">{formatMoney(record.awarded.contractObligations)}</span>
          ),
        },
        {
          title: 'Grants',
          key: 'grants',
          width: 110,
          align: 'right',
          sorter: (a, b) => (a.awarded.grantObligations ?? -1) - (b.awarded.grantObligations ?? -1),
          render: (_: unknown, record) => (
            <span className="dn-num">{formatMoney(record.awarded.grantObligations)}</span>
          ),
        },
        {
          title: 'Employees',
          key: 'employees',
          width: 100,
          align: 'right',
          render: (_: unknown, record) => (
            <span className="dn-num">
              {record.employeeCount != null
                ? formatNumber(record.employeeCount)
                : record.employeesUnreported
                  ? 'n/r'
                  : '—'}
            </span>
          ),
        },
        {
          title: 'Clients',
          dataIndex: 'clientCount',
          key: 'clientCount',
          width: 80,
          align: 'right',
          render: (n: number) => <span className="dn-num">{n}</span>,
        },
        {
          title: '',
          key: 'warnings',
          width: 36,
          render: (_: unknown, record) =>
            record.warnings.length ? (
              <Tooltip title={record.warnings.map((w) => w.message).join(' ')}>
                <WarningOutlined style={{ color: 'var(--notable)' }} />
              </Tooltip>
            ) : null,
        },
      ]}
    />
  );
}
