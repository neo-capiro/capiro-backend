import { Card, Empty, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProgramElementProject } from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text, Paragraph } = Typography;

export interface ProjectsPanelProps {
  projects: ProgramElementProject[] | null | undefined;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

/** Open-at-page deep link for a project's R-2A citation. */
export function projectSourceHref(p: Pick<ProgramElementProject, 'sourceUrl' | 'pageNumber'>): string | null {
  if (!p.sourceUrl) return null;
  return p.pageNumber ? `${p.sourceUrl}#page=${p.pageNumber}` : p.sourceUrl;
}

/**
 * Step 1.2 — R-2A projects/sub-elements for a PE. Each row deep-links to the exact exhibit
 * page; the mission narrative is collapsible. Honest empty state when no projects exist.
 */
export function ProjectsPanel({ projects, loading = false, errored = false, onRetry }: ProjectsPanelProps) {
  if (loading) {
    return (
      <Card title="Projects (R-2A)">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="R-2A projects" testId="pe-secondary-failed-projects" onRetry={onRetry} />
    );
  }


  const rows = Array.isArray(projects) ? projects : [];
  if (rows.length === 0) {
    return (
      <Card className="pe-projects-card" title="Projects (R-2A)">
        <Empty description="No R-2A projects extracted for this PE — it may be procurement-only or pre-FY27." />
      </Card>
    );
  }

  const columns: ColumnsType<ProgramElementProject> = [
    {
      title: 'Project',
      dataIndex: 'projectCode',
      key: 'projectCode',
      width: 110,
      render: (v: string) => <Text code>{v}</Text>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title' },
    {
      title: 'FY',
      dataIndex: 'fy',
      key: 'fy',
      width: 70,
      render: (v: number | null) => (v ? <Tag>FY{v}</Tag> : '—'),
    },
    {
      title: 'Source',
      key: 'source',
      width: 120,
      align: 'right',
      render: (_v: unknown, p: ProgramElementProject) => {
        const href = projectSourceHref(p);
        const label = `R-2A${p.pageNumber ? ` p.${p.pageNumber}` : ''}`;
        return href ? (
          <a href={href} target="_blank" rel="noreferrer">
            <Tag color="green">{label}</Tag>
          </a>
        ) : (
          <Tag>{label}</Tag>
        );
      },
    },
  ];

  return (
    <Card className="pe-projects-card" title={`Projects (R-2A) · ${rows.length}`}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        Sub-elements from the Service&apos;s R-2A justification exhibit. Expand a row for its mission
        narrative; the source chip opens the exact exhibit page.
      </Text>
      <Table<ProgramElementProject>
        rowKey="id"
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
        expandable={{
          rowExpandable: (p) => Boolean(p.mission),
          expandedRowRender: (p) =>
            p.mission ? (
              <Paragraph style={{ margin: 0 }}>{p.mission}</Paragraph>
            ) : (
              <Text type="secondary">No mission narrative extracted.</Text>
            ),
        }}
      />
    </Card>
  );
}

export default ProjectsPanel;
