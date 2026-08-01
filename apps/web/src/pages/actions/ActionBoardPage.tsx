/**
 * ActionBoardPage (route /actions) — the Step 3.2 §12.4 action board.
 *
 * Two views over GET /api/intelligence/actions:
 *   - List: deadline-ranked (server default sort=deadline asc nulls-last, then priority desc).
 *   - Kanban: the same cards grouped into one column per §19 ActionStatus.
 * A Generate button POSTs /generate then refetches. Status/owner/dismiss mutations live on
 * the card. Honest empty state; every collection read is Array.isArray-guarded.
 */
import { useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  Empty,
  Radio,
  Segmented,
  Skeleton,
  Space,
  Typography,
} from 'antd';
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { ActionCard } from './ActionCard.js';
import {
  useActionsList,
  useGenerateActions,
  useTeamMembers,
  type ActionListParams,
} from './actions-api.js';
import { STATUS_LABELS, STATUS_ORDER, type ActionStatus } from './types.js';
import './actions.css';

const { Title, Text } = Typography;

type ViewMode = 'list' | 'kanban';

export function ActionBoardPage() {
  const { message } = AntApp.useApp();
  const [view, setView] = useState<ViewMode>('list');
  const [sort, setSort] = useState<'deadline' | 'priority'>('deadline');

  // The board pulls the full working set (up to the API max) and groups client-side for the
  // kanban; the list view honours the server's deadline/priority sort.
  const params: ActionListParams = useMemo(
    () => ({ sort, limit: 100, page: 1 }),
    [sort],
  );
  const list = useActionsList(params);
  const team = useTeamMembers();
  const generate = useGenerateActions();

  const cards = useMemo(
    () => (Array.isArray(list.data?.data) ? list.data!.data : []),
    [list.data],
  );
  const members = useMemo(
    () => (Array.isArray(team.data) ? team.data : []),
    [team.data],
  );

  function handleGenerate() {
    generate.mutate(undefined, {
      onSuccess: (res) => {
        const n = res?.generated ?? 0;
        message.success(
          n > 0 ? `Generated ${n} action${n === 1 ? '' : 's'}` : 'No new actions to generate',
        );
      },
      onError: (err) => message.error(err.message || 'Generation failed'),
    });
  }

  const isLoading = list.isLoading;
  const isEmpty = !isLoading && cards.length === 0;

  return (
    <div className="action-board">
      <div className="action-board-header">
        <Title level={4} className="action-board-title" style={{ margin: 0 }}>
          Actions
        </Title>
        <Text type="secondary">
          {list.data?.total != null ? `${list.data.total} action${list.data.total === 1 ? '' : 's'}` : ''}
        </Text>
        <span style={{ flex: 1 }} />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => list.refetch()}
          loading={list.isFetching && !list.isLoading}
        >
          Refresh
        </Button>
        <Button
          type="primary"
          className="action-board-generate"
          icon={<ThunderboltOutlined />}
          onClick={handleGenerate}
          loading={generate.isPending}
        >
          Generate
        </Button>
      </div>

      <div className="action-board-toolbar">
        <Segmented<ViewMode>
          value={view}
          onChange={(v) => setView(v as ViewMode)}
          options={[
            { label: 'Board', value: 'kanban' },
            { label: 'List', value: 'list' },
          ]}
        />
        <span className="action-board-hint">
          Board groups by workflow state; list keeps the evidence and recommendation visible.
        </span>
        {view === 'list' ? (
          <Radio.Group
            size="small"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            optionType="button"
          >
            <Radio.Button value="deadline">Deadline</Radio.Button>
            <Radio.Button value="priority">Priority</Radio.Button>
          </Radio.Group>
        ) : null}
      </div>

      {isLoading ? (
        <Space direction="vertical" style={{ width: '100%' }} size={14}>
          <Skeleton active paragraph={{ rows: 4 }} />
          <Skeleton active paragraph={{ rows: 4 }} />
        </Space>
      ) : isEmpty ? (
        <div className="action-board-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" align="center">
                <Text strong>No action recommendations yet</Text>
                <Text type="secondary">
                  Generate cards from the current material budget deltas relevant to your clients.
                </Text>
                <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleGenerate} loading={generate.isPending}>
                  Generate actions
                </Button>
              </Space>
            }
          />
        </div>
      ) : view === 'list' ? (
        <div className="action-list">
          {cards.map((card) => (
            <ActionCard key={card.id} card={card} teamMembers={members} />
          ))}
        </div>
      ) : (
        <KanbanView cards={cards} members={members} />
      )}
    </div>
  );
}

function KanbanView({
  cards,
  members,
}: {
  cards: import('./types.js').ActionCardDto[];
  members: import('./actions-api.js').TeamMemberOption[];
}) {
  // Only render columns that have at least one card, but always preserve §19 order. An
  // all-empty set is handled upstream (the page shows the empty state instead).
  const byStatus = useMemo(() => {
    const map = new Map<ActionStatus, typeof cards>();
    for (const status of STATUS_ORDER) map.set(status, []);
    for (const card of cards) {
      const bucket = map.get(card.status);
      if (bucket) bucket.push(card);
      else map.set(card.status, [card]); // tolerate an unknown status from the API
    }
    return map;
  }, [cards]);

  const visibleColumns = STATUS_ORDER.filter((s) => (byStatus.get(s)?.length ?? 0) > 0);

  return (
    <div className="action-kanban">
      {visibleColumns.map((status) => {
        const columnCards = byStatus.get(status) ?? [];
        return (
          <section key={status} className="action-kanban-column" aria-label={STATUS_LABELS[status]}>
            <div className="action-kanban-column-header">
              <Text strong>{STATUS_LABELS[status]}</Text>
              <span className="action-kanban-column-count">{columnCards.length}</span>
            </div>
            <div className="action-kanban-column-body">
              {columnCards.map((card) => (
                <ActionCard key={card.id} card={card} teamMembers={members} compact />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
