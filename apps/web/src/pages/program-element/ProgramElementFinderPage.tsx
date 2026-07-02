import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Input, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import { getProgramElementsList } from './api.js';
import type { ProgramElementListItem } from './types.js';

const SERVICE_OPTIONS = [
  // Values are the CANONICAL program_element.service codes (the API also
  // normalizes display aliases, but send codes so the two never drift again).
  { label: 'All services', value: '' },
  { label: 'Army', value: 'ARMY' },
  { label: 'Navy', value: 'NAVY' },
  { label: 'Air Force', value: 'AF' },
  { label: 'Space Force', value: 'SF' },
  { label: 'Marine Corps', value: 'USMC' },
  { label: 'Defense-Wide', value: 'DW' },
  { label: 'DARPA', value: 'DARPA' },
];

const PAGE_SIZE = 50;

export function ProgramElementFinderPage() {
  const api = useApi();
  const navigate = useNavigate();
  const me = useMe();
  const [term, setTerm] = useState('');
  const [service, setService] = useState('');
  const [hasDataOnly, setHasDataOnly] = useState(false);
  const [page, setPage] = useState(1);

  const listQuery = useQuery({
    queryKey: ['program-element-finder', term.trim(), service, hasDataOnly, page],
    queryFn: () =>
      getProgramElementsList(api, {
        q: term.trim() || undefined,
        service: service || undefined,
        has_data: hasDataOnly ? 'true' : undefined,
        page,
        limit: PAGE_SIZE,
      }),
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;

  // Reset to page 1 whenever a filter changes so we never sit on an out-of-range page.
  const onFilterChange = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const columns: ColumnsType<ProgramElementListItem> = useMemo(
    () => [
      {
        title: 'PE code',
        dataIndex: 'peCode',
        key: 'peCode',
        width: 160,
        render: (value: string) => (
          <a onClick={() => navigate(`/program-elements/${encodeURIComponent(value)}`)}>{value}</a>
        ),
        sorter: (a, b) => a.peCode.localeCompare(b.peCode),
      },
      { title: 'Title', dataIndex: 'title', key: 'title', ellipsis: true },
      {
        title: 'Service',
        dataIndex: 'service',
        key: 'service',
        width: 140,
        render: (value: string | null) => <Tag>{value ?? '—'}</Tag>,
      },
      {
        title: 'Budget activity',
        dataIndex: 'budgetActivity',
        key: 'budgetActivity',
        width: 150,
        render: (value: string | null) => (value ? <Tag color="blue">{value}</Tag> : '—'),
      },
      {
        title: 'Data',
        key: 'hasData',
        width: 90,
        render: (_value: unknown, row: ProgramElementListItem) =>
          row.hasData === false ? (
            <Tooltip title="No FY history, contract awards, or bills linked yet — detail panels will be empty.">
              <Tag>none</Tag>
            </Tooltip>
          ) : (
            <Tag color="green">data</Tag>
          ),
      },
      {
        title: '',
        key: 'open',
        width: 100,
        render: (_value: unknown, row: ProgramElementListItem) => (
          <Button
            size="small"
            onClick={() => navigate(`/program-elements/${encodeURIComponent(row.peCode)}`)}
          >
            View
          </Button>
        ),
      },
    ],
    [navigate],
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="Program Element Finder"
        extra={
          <Space>
            {(me.data?.role === 'capiro_admin' || me.data?.role === 'user_admin') && (
              <Button onClick={() => navigate('/program-elements/contacts')}>
                {me.data?.role === 'capiro_admin' ? 'Contact Review Queue' : 'Suggest a Contact'}
              </Button>
            )}
            <Button onClick={() => navigate('/program-elements/mark-up-monitor')}>
              Mark-up Monitor
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Search by PE code or title, then open a Program Element to watch it and review its
          history.
        </Typography.Paragraph>

        <Space wrap style={{ marginBottom: 16 }}>
          <Input
            value={term}
            onChange={(event) => onFilterChange(() => setTerm(event.target.value))}
            placeholder="Search code or title (e.g. 0603270A, electronic warfare)"
            style={{ width: 460 }}
            allowClear
          />
          <Select
            value={service}
            onChange={(value) => onFilterChange(() => setService(value))}
            options={SERVICE_OPTIONS}
            style={{ width: 180 }}
          />
          <Space>
            <Switch
              checked={hasDataOnly}
              onChange={(checked) => onFilterChange(() => setHasDataOnly(checked))}
            />
            <Tooltip title="Hide program elements that have no FY history, contract awards, or linked bills yet.">
              <Typography.Text>Has data only</Typography.Text>
            </Tooltip>
          </Space>
        </Space>

        {!listQuery.isError && total > 0 ? (
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            {total.toLocaleString()} program element{total === 1 ? '' : 's'}
            {hasDataOnly ? ' with data' : ''}
            {total > PAGE_SIZE
              ? ` · page ${page} of ${Math.ceil(total / PAGE_SIZE)}`
              : ''}
          </Typography.Text>
        ) : null}

        {listQuery.isError ? (
          <Alert
            type="error"
            showIcon
            message="Unable to load program elements"
            description={
              listQuery.error instanceof Error
                ? listQuery.error.message
                : 'Please retry in a moment.'
            }
          />
        ) : (
          <Table<ProgramElementListItem>
            rowKey="peCode"
            loading={listQuery.isLoading}
            dataSource={rows}
            columns={columns}
            pagination={{
              current: page,
              pageSize: PAGE_SIZE,
              total,
              showSizeChanger: false,
              onChange: (next) => setPage(next),
              showTotal: (t, range) => `${range[0]}-${range[1]} of ${t.toLocaleString()}`,
            }}
            locale={{
              emptyText: <Empty description="No program elements matched your search" />,
            }}
          />
        )}
      </Card>
    </Space>
  );
}
