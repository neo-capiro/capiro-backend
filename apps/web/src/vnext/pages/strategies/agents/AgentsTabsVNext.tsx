/*
 * Agents surface — /strategies/agents/{proposals,runs} (STRATEGIES-HANDOFF
 * §7.8/§7.9). One shared two-tab shell: the tabs are ROUTES (§6 — back/forward
 * works; no local tab state), the `tab` prop comes from the route element in
 * VNextStrategiesRoutes.
 *
 * Governance lives in the tab bodies: ProposalsQueue (§7.8 — no auto-apply,
 * approve ≠ apply, subset apply, 409 regenerate state, undo) and ExecutionRuns
 * (§7.9 — STAGE only, no send control anywhere).
 */
import { useNavigate } from 'react-router-dom';
import { CapiroTabs, type CapiroTabItem } from '../../../components/menus/index.js';
import { ScopeBar, type ScopeBarStatus } from '../ScopeBar.js';
import { useChangeSets, useExecutionRuns } from '../strategies-api.js';
import { ProposalsQueue } from './ProposalsQueue.js';
import { ExecutionRuns } from './ExecutionRuns.js';
import './agents.css';

export type AgentsTab = 'proposals' | 'runs';

/*
 * Tab-dependent H1 + description (design handoff correction — an earlier
 * draft's "Proposals" label and one blended header sentence were superseded
 * by a distinct "Review queue"/"Execution" header per tab in the final
 * handoff). Wording is reused from each tab's own dark-banner copy
 * (ProposalsQueue / ExecutionRuns) rather than invented fresh — "the dark
 * banner copy is product policy — do not reword" governs the SOURCE of these
 * phrases, not a new claim about the product.
 */
const TAB_COPY: Record<AgentsTab, { h1: string; description: string }> = {
  proposals: {
    h1: 'Agent review queue',
    description:
      "Review what the Watcher proposes against your plans — every change needs a person's approval before it touches a strategy.",
  },
  runs: {
    h1: 'Execution',
    description:
      'See what the Execution Agent drafts and stages — Workspace assets and outreach records — for human review. Nothing is sent from this surface.',
  },
};

/*
 * Scope-bar status (design handoff "Scope bar" section — "warning 'Human
 * approval required' on agent review"). Grounded in the SAME two queries
 * ProposalsQueue already uses for its own `openCount` (proposed + approved —
 * there is no server 'pending' status literal; open work IS proposed+approved).
 * react-query dedupes the identical query keys against ProposalsQueue's own
 * fetch, so mounting them here too costs no extra request. Mounted once at
 * the shared shell so both tabs show the same real count — never a fabricated
 * number, and never a bare `0`/hidden pill while it is still loading or failed.
 */
function useAgentScopeStatus(
  proposed: ReturnType<typeof useChangeSets>,
  approved: ReturnType<typeof useChangeSets>,
): ScopeBarStatus {
  if (proposed.isLoading || approved.isLoading) {
    return { tone: 'gray', label: 'Checking approval status…' };
  }
  if (proposed.isError || approved.isError) {
    return { tone: 'gray', label: 'Approval status unavailable' };
  }
  const pending = (proposed.data?.length ?? 0) + (approved.data?.length ?? 0);
  return pending > 0
    ? { tone: 'warning', label: 'Human approval required' }
    : { tone: 'success', label: 'No pending review' };
}

export function AgentsTabsVNext({ tab }: { tab: AgentsTab }) {
  const navigate = useNavigate();
  const proposed = useChangeSets({ status: 'proposed' });
  const approved = useChangeSets({ status: 'approved' });
  /* Unfiltered — same queryKey ExecutionRuns.tsx itself uses whenever no
   * ?strategyId= scope is active, so react-query dedupes the fetch. */
  const runs = useExecutionRuns(null, true);
  const scopeStatus = useAgentScopeStatus(proposed, approved);

  /*
   * Per-tab count badges (design handoff — a warning-toned pending count on
   * the queue tab, a gray-toned needs-review count on the runs tab).
   * Grounded in the SAME real queries the tab bodies themselves render from
   * — never a fabricated number, and never a bare "0" while still loading or
   * on error (badge stays absent, not zeroed, in that case). Hidden outright
   * at a genuine 0, same convention as StrategyLibraryVNext's "Agent review"
   * count.
   */
  const pendingChangeSets =
    proposed.isSuccess && approved.isSuccess
      ? (proposed.data?.length ?? 0) + (approved.data?.length ?? 0)
      : null;
  const runsNeedingReview = runs.isSuccess
    ? (runs.data ?? []).filter((r) => r.state === 'ready_for_review' || r.state === 'failed_recoverable').length
    : null;

  const items: CapiroTabItem[] = [
    {
      id: 'proposals',
      label: 'Review queue',
      badge:
        pendingChangeSets !== null && pendingChangeSets > 0
          ? { count: pendingChangeSets, tone: 'warning' }
          : undefined,
    },
    {
      id: 'runs',
      label: 'Execution runs',
      badge:
        runsNeedingReview !== null && runsNeedingReview > 0
          ? { count: runsNeedingReview, tone: 'neutral' }
          : undefined,
    },
  ];

  return (
    <>
      {/* Full-bleed, sticky under the shell header (§ Layout / Scope bar) —
          deliberately a sibling of `.st-hero`, not nested inside its
          own container. */}
      <ScopeBar clientLabel="PORTFOLIO" status={scopeStatus} />

      {/* Hero/canvas split (design handoff — every view here draws a white,
          bordered hero band and a separate gray-canvas body below it, not one
          flat page; see `.st-hero`/`.st-canvas` in strategies.css and
          StrategyLibraryVNext for the identical pattern). This surface uses
          the shared default padding (28px 24px 24px) — unlike the editor's
          `.st-hero--editor`, nothing here needs a narrower override. */}
      <div className="st-hero">
        <div className="st-page-header">
          <div className="st-agents__header-left">
            {/* Back-to-library control — mirrors StrategyEditorVNext's
                `.st-editor-back` chevron button exactly (same markup, same
                aria-label), but styled under this module's own class in
                agents.css rather than reaching into strategy-editor.css,
                which is a separate lazy chunk not guaranteed to be loaded
                when this route is opened directly. */}
            <button
              type="button"
              className="st-agents__back"
              aria-label="Back to strategies"
              onClick={() => navigate('/strategies')}
            >
              ‹
            </button>
            <div>
              <p className="st-eyebrow">Strategy Operating System</p>
              <h1 className="st-title">{TAB_COPY[tab].h1}</h1>
              <p className="st-purpose">{TAB_COPY[tab].description}</p>
            </div>
          </div>
          <div className="st-actions">
            <CapiroTabs
              label="Agent governance sections"
              items={items}
              activeId={tab}
              onChange={(id) =>
                navigate(id === 'runs' ? '/strategies/agents/runs' : '/strategies/agents/proposals')
              }
            />
          </div>
        </div>
      </div>

      <div className="st-canvas">{tab === 'proposals' ? <ProposalsQueue /> : <ExecutionRuns />}</div>
    </>
  );
}
