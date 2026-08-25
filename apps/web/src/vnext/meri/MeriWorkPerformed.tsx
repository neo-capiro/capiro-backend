import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { INTENT_LABELS } from '../../components/chat/work-performed-shared.js';
import { MeriAgentSteps } from './MeriAgentSteps.js';

/**
 * MeriWorkPerformed — the v4 agent-run hero card (dark gradient header,
 * step-by-step progress) replacing the plain `<details>/<summary>`
 * disclosure that shipped in vNext.
 *
 * This is a re-skin, not a new data source: `components/chat/WorkPerformed.tsx`
 * already renders this exact data (intent, tier, steps, planSteps, isStreaming)
 * in the legacy chat surface, and its real call site
 * (`MeriWorkspaceConversation.tsx`) never populates `assumptions`, `warnings`,
 * `contextPacketId` or `asOf` — so this component doesn't accept them either;
 * the header-text and step-count logic below mirrors WorkPerformed's, so the
 * two surfaces agree on what "3 tools · 2 sources" means.
 *
 * The step-row rendering itself lives in MeriAgentSteps, shared with
 * MeriResearchProgress so the two hero cards don't carry two copies of the
 * same STEP-tone styling.
 */

interface MeriWorkPerformedProps {
  intent?: string | null;
  tier?: 'fast' | 'deep' | null;
  steps: TrustStep[];
  planSteps?: string[];
  isStreaming: boolean;
}

export function MeriWorkPerformed({ intent, tier, steps, planSteps, isStreaming }: MeriWorkPerformedProps) {
  const hasWorkLog = isStreaming || steps.length > 0;
  if (!hasWorkLog) return null;

  const toolCount = steps.length;
  const sourceCount = steps.reduce((sum, step) => sum + (typeof step.count === 'number' ? step.count : 0), 0);
  const errorCount = steps.filter((step) => step.status === 'error').length;
  const doneCount = steps.filter((step) => step.status === 'done').length;
  const planLabel = (intent && INTENT_LABELS[intent]) || 'Working';
  const runningStep = steps.find((step) => step.status === 'running');

  const title = isStreaming
    ? runningStep?.label || `${planLabel}…`
    : toolCount === 0
      ? 'Sources and context'
      : [
          `Work performed · ${toolCount} tool${toolCount === 1 ? '' : 's'}`,
          sourceCount ? `${sourceCount} source${sourceCount === 1 ? '' : 's'}` : null,
          errorCount ? `${errorCount} issue${errorCount === 1 ? '' : 's'}` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  // A real, step-count-based fraction — not a fabricated percentage. There is
  // no elapsed/budget time for the ordinary chat tool loop (unlike deep
  // research), so progress is "how many of the known steps finished."
  const pct = toolCount > 0 ? Math.round((doneCount / toolCount) * 100) : isStreaming ? 0 : 100;

  return (
    <div className="vnext-meri__work-card">
      <div className="vnext-meri__work-card-metal">
        <div className="vnext-meri__work-card-head">
          <span className="vnext-meri__work-card-label">
            {planLabel.toUpperCase()}
            {tier === 'deep' ? ' · DEEP' : ''}
          </span>
          <span className="vnext-meri__work-card-spacer" />
          {sourceCount > 0 ? (
            <span className="vnext-meri__work-card-badge">
              <span className={`vnext-meri__work-source-dot${isStreaming ? ' is-live' : ''}`} />
              <span className="vnext-meri__work-card-badge-text">
                {sourceCount} SOURCE{sourceCount === 1 ? '' : 'S'}
              </span>
            </span>
          ) : null}
        </div>
        <div className="vnext-meri__work-card-title">
          {title}
        </div>
        {isStreaming ? (
          <div className="vnext-meri__work-card-progress-row">
            <span className="vnext-meri__work-card-progress-track">
              <span
                className="vnext-meri__work-card-progress-fill"
                style={{ width: `${pct}%`, transition: 'width 240ms ease' }}
              />
            </span>
            <span className="vnext-meri__work-card-progress-label">
              {doneCount} OF {toolCount || '?'}
            </span>
          </div>
        ) : null}
      </div>

      {planSteps && planSteps.length > 0 ? (
        <div className="vnext-meri__work-plan">
          <div className="vnext-meri__work-plan-label">
            PLAN
          </div>
          <ol className="vnext-meri__work-plan-list">
            {planSteps.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="vnext-meri__work-card-steps">
          <MeriAgentSteps steps={steps} />
        </div>
      ) : null}

      <div className="vnext-meri__work-disclaimer">
        This shows bounded plans, tools, sources, and checks — not private model reasoning.
      </div>
    </div>
  );
}
