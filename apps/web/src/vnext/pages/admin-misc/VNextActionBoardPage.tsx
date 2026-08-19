/**
 * vNext re-skin of pages/actions/ActionBoardPage.tsx (route /actions) — the
 * Step 3.2 §12.4 action board. Identical hooks (actions-api.js reused
 * verbatim) and behavior:
 *   - List: deadline-ranked (server default sort=deadline asc nulls-last, then
 *     priority desc). Kanban: the same cards grouped per §19 ActionStatus.
 *   - Generate POSTs /generate then refetches. Status/owner/dismiss mutations
 *     live on the card. Honest empty state; every collection read is
 *     Array.isArray-guarded.
 * Presentation moves to the vNext token layer; the kanban column body carries
 * an explicit viewport-clamped max-height (Phase 3 lesson 1: the vNext shell
 * scrolls the page, so the column must own its scroll).
 */
import { useMemo, useState } from 'react';
import {
  useActionsList,
  useGenerateActions,
  useTeamMembers,
  type ActionListParams,
  type TeamMemberOption,
} from '../../../pages/actions/actions-api.js';
import {
  STATUS_LABELS,
  STATUS_ORDER,
  type ActionCardDto,
  type ActionStatus,
} from '../../../pages/actions/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroThunderboltIcon } from '../../components/icons/index.js';
import { SvSegmented } from '../settings/settings-ui.js';
import { VNextActionCard } from './VNextActionCard.js';

type ViewMode = 'list' | 'kanban';

export function VNextActionBoardPage() {
  const toast = useCapiroToast();
  const [view, setView] = useState<ViewMode>('list');
  const [sort, setSort] = useState<'deadline' | 'priority'>('deadline');

  // The board pulls the full working set (up to the API max) and groups client-side for the
  // kanban; the list view honours the server's deadline/priority sort.
  const params: ActionListParams = useMemo(() => ({ sort, limit: 100, page: 1 }), [sort]);
  const list = useActionsList(params);
  const team = useTeamMembers();
  const generate = useGenerateActions();

  const cards = useMemo(
    () => (Array.isArray(list.data?.data) ? list.data!.data : []),
    [list.data],
  );
  const members = useMemo(() => (Array.isArray(team.data) ? team.data : []), [team.data]);

  function handleGenerate() {
    generate.mutate(undefined, {
      onSuccess: (res) => {
        const n = res?.generated ?? 0;
        toast.success(
          n > 0 ? `Generated ${n} action${n === 1 ? '' : 's'}` : 'No new actions to generate',
        );
      },
      onError: (err) => toast.error(err.message || 'Generation failed'),
    });
  }

  const isLoading = list.isLoading;
  const isEmpty = !isLoading && cards.length === 0;

  return (
    <div className="settings-vnext amx">
      <header className="stv-header">
        <div>
          <h1>Actions</h1>
          <p>
            {list.data?.total != null
              ? `${list.data.total} action${list.data.total === 1 ? '' : 's'}`
              : ' '}
          </p>
        </div>
        <div className="amx-header-actions">
          <CapiroButton
            onClick={() => void list.refetch()}
            loading={list.isFetching && !list.isLoading}
          >
            Refresh
          </CapiroButton>
          <CapiroButton
            variant="primary"
            leadingIcon={<CapiroThunderboltIcon />}
            onClick={handleGenerate}
            loading={generate.isPending}
          >
            Generate
          </CapiroButton>
        </div>
      </header>

      <div className="stv-body">
        <div className="amx-toolbar">
          <SvSegmented<ViewMode>
            aria-label="Board view"
            value={view}
            onChange={setView}
            options={[
              { label: 'Board', value: 'kanban' },
              { label: 'List', value: 'list' },
            ]}
          />
          <span className="amx-toolbar-hint">
            Board groups by workflow state; list keeps the evidence and recommendation visible.
          </span>
          {view === 'list' ? (
            <SvSegmented<'deadline' | 'priority'>
              aria-label="Sort actions"
              value={sort}
              onChange={setSort}
              options={[
                { label: 'Deadline', value: 'deadline' },
                { label: 'Priority', value: 'priority' },
              ]}
            />
          ) : null}
        </div>

        {isLoading ? (
          <div className="stv-stack" aria-label="Loading actions">
            <CapiroSkeleton height={120} />
            <CapiroSkeleton height={120} />
          </div>
        ) : isEmpty ? (
          <CapiroEmptyState
            title="No action recommendations yet"
            description="Generate cards from the current material budget deltas relevant to your clients."
            action={
              <CapiroButton
                variant="primary"
                leadingIcon={<CapiroThunderboltIcon />}
                onClick={handleGenerate}
                loading={generate.isPending}
              >
                Generate actions
              </CapiroButton>
            }
          />
        ) : view === 'list' ? (
          <div className="amx-action-list">
            {cards.map((card) => (
              <VNextActionCard key={card.id} card={card} teamMembers={members} />
            ))}
          </div>
        ) : (
          <KanbanView cards={cards} members={members} />
        )}
      </div>
    </div>
  );
}

function KanbanView({ cards, members }: { cards: ActionCardDto[]; members: TeamMemberOption[] }) {
  // Only render columns that have at least one card, but always preserve §19 order. An
  // all-empty set is handled upstream (the page shows the empty state instead).
  const byStatus = useMemo(() => {
    const map = new Map<ActionStatus, ActionCardDto[]>();
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
    <div className="amx-kanban">
      {visibleColumns.map((status) => {
        const columnCards = byStatus.get(status) ?? [];
        return (
          <section key={status} className="amx-kanban-column" aria-label={STATUS_LABELS[status]}>
            <div className="amx-kanban-column-header">
              <span>{STATUS_LABELS[status]}</span>
              <span className="amx-kanban-column-count">{columnCards.length}</span>
            </div>
            <div className="amx-kanban-column-body">
              {columnCards.map((card) => (
                <VNextActionCard key={card.id} card={card} teamMembers={members} compact />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
