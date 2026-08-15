import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Empty, Skeleton, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';

interface DashOutreach {
  id: string;
  title: string;
  subject: string | null;
  body: string | null;
  status: 'draft' | 'sent' | 'opened_in_email' | 'failed';
  recipientCount: number;
  client: { id: string; name: string } | null;
  updatedAt: string;
}

interface DashWorkspaceDraft {
  id: string;
  docTitle: string;
  product: string | null;
  industry: string | null;
  client: string | null;
  status: 'draft' | 'complete';
  updatedAt: string;
}

interface WorkQueueItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  tag: string;
  tagColor?: string;
  rank: number;
  timestamp: number;
}

/**
 * Dashboard continuation surface: only work the team is actively producing.
 * Governance reviews and generated ActionRecommendations keep their dedicated
 * product surfaces and intentionally do not compete for these eight slots.
 */
export function DashboardWorkQueue() {
  const api = useApi();

  const outreach = useQuery<DashOutreach[]>({
    queryKey: ['dashboard-work-outreach'],
    queryFn: async () =>
      (await api.get<DashOutreach[]>('/api/engagement/outreach', { params: { limit: 50 } })).data,
    staleTime: 60_000,
  });

  const workspace = useQuery<DashWorkspaceDraft[]>({
    queryKey: ['dashboard-workspace-drafts'],
    queryFn: async () =>
      (
        await api.get<DashWorkspaceDraft[]>('/workspace-api/drafts', {
          params: { scope: 'all' },
        })
      ).data,
    staleTime: 60_000,
    retry: false,
  });

  const items = useMemo<WorkQueueItem[]>(() => {
    const out: WorkQueueItem[] = [];

    for (const draft of outreach.data ?? []) {
      if (draft.status !== 'draft') continue;
      const ready = Boolean(draft.body?.trim() && draft.recipientCount > 0);
      out.push({
        id: `outreach-${draft.id}`,
        title: draft.title,
        subtitle: [
          draft.client?.name,
          draft.subject ||
            (draft.recipientCount
              ? `${draft.recipientCount} recipient${draft.recipientCount === 1 ? '' : 's'}`
              : 'No recipients yet'),
        ]
          .filter(Boolean)
          .join(' · '),
        href: `/engagement/outreach/draft/${encodeURIComponent(draft.id)}`,
        tag: ready ? 'Ready to send' : 'Outreach draft',
        tagColor: ready ? 'green' : 'blue',
        // Ready-to-send outreach always comes first. Everything else intermixes
        // by most recent activity, regardless of whether it is outreach or a doc.
        rank: ready ? 0 : 1,
        timestamp: -new Date(draft.updatedAt).getTime(),
      });
    }

    for (const document of workspace.data ?? []) {
      if (document.status !== 'draft') continue;
      out.push({
        id: `workspace-${document.id}`,
        title: document.docTitle || 'Untitled document',
        subtitle: [document.client, document.product || document.industry || 'Workspace document']
          .filter(Boolean)
          .join(' · '),
        href: `/workspace/draft/${encodeURIComponent(document.id)}`,
        tag: 'Document',
        rank: 1,
        timestamp: -new Date(document.updatedAt).getTime(),
      });
    }

    return out
      .sort((a, b) => a.rank - b.rank || a.timestamp - b.timestamp)
      .slice(0, 8);
  }, [outreach.data, workspace.data]);

  const loading = outreach.isLoading || workspace.isLoading;

  return (
    <div className="home-panel">
      <header className="home-panel-head">
        <span className="home-panel-title">Work Queue</span>
        <span className="open">
          <Link to="/engagement">Outreach</Link>
          {' · '}
          <Link to="/workspace/documents">Workspace →</Link>
        </span>
      </header>
      {loading ? (
        <div className="home-panel-list">
          {[0, 1, 2].map((i) => (
            <div className="home-panel-row" key={i}>
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="home-panel-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No active outreach or Workspace drafts."
          />
        </div>
      ) : (
        <div className="home-work-list">
          {items.map((item) => (
            <Link key={item.id} to={item.href} className="home-work-row">
              <div className="home-work-main">
                <span className="home-work-title">{item.title}</span>
                <span className="home-work-sub">{item.subtitle}</span>
              </div>
              <Tag color={item.tagColor} className="home-panel-tag">
                {item.tag}
              </Tag>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
