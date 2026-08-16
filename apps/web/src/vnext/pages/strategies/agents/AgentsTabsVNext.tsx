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
import { CapiroTabs } from '../../../components/menus/index.js';
import { ScopeBar, type ScopeBarStatus } from '../ScopeBar.js';
import { useChangeSets } from '../strategies-api.js';
import { ProposalsQueue } from './ProposalsQueue.js';
import { ExecutionRuns } from './ExecutionRuns.js';
import './agents.css';

export type AgentsTab = 'proposals' | 'runs';

const TABS = [
  { id: 'proposals', label: 'Proposals' },
  { id: 'runs', label: 'Execution runs' },
] as const;

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
function useAgentScopeStatus(): ScopeBarStatus {
  const proposed = useChangeSets({ status: 'proposed' });
  const approved = useChangeSets({ status: 'approved' });

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
  const scopeStatus = useAgentScopeStatus();

  return (
    <>
      {/* Full-bleed, sticky under the shell header (§ Layout / Scope bar) —
          deliberately a sibling of `.st-page`, not nested inside its
          max-width:1360px container. */}
      <ScopeBar clientLabel="PORTFOLIO" status={scopeStatus} />

      <div className="st-page st-agents">
        <div className="st-page-header">
          <div>
            <p className="st-eyebrow">Strategy Operating System</p>
            <h1 className="st-title">Agent governance</h1>
            <p className="st-purpose">
              Review what the Watcher proposes against your plans, and what the Execution Agent stages
              from them — every change waits for a person.
            </p>
          </div>
          <div className="st-actions">
            <CapiroTabs
              label="Agent governance sections"
              items={[...TABS]}
              activeId={tab}
              onChange={(id) =>
                navigate(id === 'runs' ? '/strategies/agents/runs' : '/strategies/agents/proposals')
              }
            />
          </div>
        </div>

        {tab === 'proposals' ? <ProposalsQueue /> : <ExecutionRuns />}
      </div>
    </>
  );
}
