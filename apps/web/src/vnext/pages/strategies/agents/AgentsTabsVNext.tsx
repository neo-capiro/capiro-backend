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
import { ProposalsQueue } from './ProposalsQueue.js';
import { ExecutionRuns } from './ExecutionRuns.js';
import './agents.css';

export type AgentsTab = 'proposals' | 'runs';

const TABS = [
  { id: 'proposals', label: 'Proposals' },
  { id: 'runs', label: 'Execution runs' },
] as const;

export function AgentsTabsVNext({ tab }: { tab: AgentsTab }) {
  const navigate = useNavigate();
  return (
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
  );
}
