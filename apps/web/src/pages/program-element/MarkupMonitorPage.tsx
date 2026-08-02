import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Empty, InputNumber, Select, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { getMarkupMonitor } from './api.js';
import type { ProgramElementMarkupMonitorItem } from './types.js';
import './program-elements-final.css';

const { Text } = Typography;

function dollarsMm(value: number | null | undefined): string {
  if (value == null) return '-';
  return `$${value.toFixed(2)}m`;
}

function ratioToRequest(mark: number | null, request: number | null): number | null {
  if (mark == null || request == null || request === 0) return null;
  return (mark / request) * 100;
}

function colorForRatio(ratio: number | null): 'green' | 'gold' | 'red' | 'default' {
  if (ratio == null) return 'default';
  if (ratio > 110) return 'green';
  if (ratio >= 95) return 'gold';
  return 'red';
}

function MarkCell({ value, request }: { value: number | null; request: number | null }) {
  const ratio = ratioToRequest(value, request);
  const color = colorForRatio(ratio);

  return (
    <Tag color={color} data-testid={`mark-cell-${color}`}>
      {dollarsMm(value)}
    </Tag>
  );
}

function DivergenceBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="pe-final-stage-bar-row">
      <div className="pe-final-stage-bar" aria-hidden>
        <i style={{ width: `${clamped}%`, background: 'var(--pef-accent, var(--accent))' }} />
      </div>
      <Text>{value.toFixed(1)}%</Text>
    </div>
  );
}

export function MarkupMonitorPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [divergenceThreshold, setDivergenceThreshold] = useState<number>(0);

  const monitorQuery = useQuery({
    queryKey: ['program-element-markup-monitor', serviceFilter, divergenceThreshold],
    queryFn: () =>
      getMarkupMonitor(api, {
        service: serviceFilter === 'all' ? undefined : serviceFilter,
        divergence_threshold: divergenceThreshold,
      }),
    staleTime: 60 * 1000,
  });

  const rows = monitorQuery.data?.data ?? [];

  const serviceOptions = useMemo(() => {
    const values = Array.from(new Set(rows.map((row) => row.service).filter((v): v is string => Boolean(v && v.trim()))));
    return [
      { label: 'All services', value: 'all' },
      ...values.sort((a, b) => a.localeCompare(b)).map((value) => ({ label: value, value })),
    ];
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows
      .filter((row) => (serviceFilter === 'all' ? true : row.service === serviceFilter))
      .filter((row) => row.divergencePct >= divergenceThreshold);
  }, [rows, serviceFilter, divergenceThreshold]);

  const columns: ColumnsType<ProgramElementMarkupMonitorItem> = [
    {
      title: 'PE code',
      dataIndex: 'peCode',
      key: 'peCode',
      sorter: (a, b) => a.peCode.localeCompare(b.peCode),
    },
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
    },
    {
      title: 'Request',
      dataIndex: 'request',
      key: 'request',
      render: (value: number | null) => dollarsMm(value),
      sorter: (a, b) => (a.request ?? -1) - (b.request ?? -1),
    },
    {
      title: 'HASC',
      dataIndex: 'hascMark',
      key: 'hascMark',
      render: (_value: number | null, row) => <MarkCell value={row.hascMark} request={row.request} />,
    },
    {
      title: 'SASC',
      dataIndex: 'sascMark',
      key: 'sascMark',
      render: (_value: number | null, row) => <MarkCell value={row.sascMark} request={row.request} />,
    },
    {
      title: 'HAC-D',
      dataIndex: 'hacDMark',
      key: 'hacDMark',
      render: (_value: number | null, row) => <MarkCell value={row.hacDMark} request={row.request} />,
    },
    {
      title: 'SAC-D',
      dataIndex: 'sacDMark',
      key: 'sacDMark',
      render: (_value: number | null, row) => <MarkCell value={row.sacDMark} request={row.request} />,
    },
    {
      title: 'Divergence',
      dataIndex: 'divergencePct',
      key: 'divergencePct',
      sorter: (a, b) => a.divergencePct - b.divergencePct,
      defaultSortOrder: 'descend',
      render: (value: number) => <DivergenceBar value={value} />,
    },
  ];

  return (
    <section className="pe-finder pe-final">
      <div className="pe-final-breadcrumb">
        <button type="button" onClick={() => navigate('/program-elements')}>
          Program elements
        </button>
        <span>›</span>
        <span>Monitoring tools</span>
        <span>›</span>
        <span>Mark-up monitor</span>
      </div>

      <div className="pe-final-page-head">
        <div className="pe-final-page-copy">
          <h1>Mark-up monitor</h1>
          <p>
            Committee marks across HASC, SASC, HAC-D and SAC-D for every program element you
            watch, with how far each mark diverges from the President&apos;s Budget request.
          </p>
        </div>
      </div>

      <div className="pe-final-card" style={{ margin: '16px 0' }}>
        <div className="pe-final-markup-filters">
          <label>
            <span>Service</span>
            <Select
              style={{ width: 220 }}
              options={serviceOptions}
              value={serviceFilter}
              onChange={(value) => setServiceFilter(value)}
            />
          </label>
          <label>
            <span>Divergence threshold</span>
            <InputNumber
              min={0}
              max={100}
              step={1}
              value={divergenceThreshold}
              onChange={(value) => setDivergenceThreshold(value ?? 0)}
              addonAfter="%"
            />
          </label>
        </div>
      </div>

      <div className="pe-final-card">
        <div className="pe-final-card-head">
          <h3>Program element mark-up monitor</h3>
        </div>
        <Table<ProgramElementMarkupMonitorItem>
          rowKey="peCode"
          dataSource={filteredRows}
          columns={columns}
          loading={monitorQuery.isLoading}
          pagination={false}
          locale={{
            emptyText: <Empty description="Watch some PEs to populate this view" />,
          }}
        />
      </div>
    </section>
  );
}
