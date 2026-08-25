import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { formatElapsed } from '../../components/chat/useMeriChatController.js';
import { MeriAgentSteps } from './MeriAgentSteps.js';

/**
 * MeriResearchProgress — the deep-research running hero (screen H2). Unlike
 * MeriWorkPerformed's step-count progress, this one has a real elapsed-vs-
 * budget time from the server's `progress` heartbeat
 * (`{ note, elapsedMs, budgetMs }`), which previously was composed directly
 * into the message body as text and thrown away rather than kept as state —
 * see useMeriChatController's `researchProgress`/`isResearchStreaming`.
 *
 * When budgetMs is absent the bar still shows real elapsed time as a
 * moving indeterminate fill rather than inventing a percentage against an
 * unknown budget.
 */

interface MeriResearchProgressProps {
  isStreaming: boolean;
  progress: { note: string; elapsedMs: number; budgetMs?: number } | null;
  steps: TrustStep[];
  scope?: string | null;
}

export function MeriResearchProgress({ isStreaming, progress, steps, scope }: MeriResearchProgressProps) {
  if (!isStreaming) return null;

  const sourceCount = steps.reduce((sum, step) => sum + (typeof step.count === 'number' ? step.count : 0), 0);
  const hasBudget = typeof progress?.budgetMs === 'number' && progress.budgetMs > 0;
  const pct = hasBudget
    ? Math.max(2, Math.min(100, Math.round(((progress!.elapsedMs / progress!.budgetMs!) * 100))))
    : null;

  return (
    <div className="vnext-meri__work-card">
      <div className="vnext-meri__work-card-metal">
        <div className="vnext-meri__work-card-head">
          <span className="vnext-meri__work-card-label">
            MERI RESEARCH RUN{scope ? ` · ${scope.toUpperCase()}` : ''}
          </span>
          <span className="vnext-meri__work-card-spacer" />
          {sourceCount > 0 ? (
            <span className="vnext-meri__work-card-badge">
              <span className="vnext-meri__work-source-dot is-live" />
              <span className="vnext-meri__work-card-badge-text">
                {sourceCount} SOURCE{sourceCount === 1 ? '' : 'S'}
              </span>
            </span>
          ) : null}
        </div>

        <div className="vnext-meri__work-card-title">
          {progress?.note || 'Researching…'}
        </div>

        <div className="vnext-meri__work-card-progress-row">
          <span className="vnext-meri__work-card-progress-track">
            <span
              className={`vnext-meri__work-card-progress-fill${pct === null ? ' vnext-meri__research-bar-indeterminate' : ''}`}
              style={{
                width: pct === null ? '35%' : `${pct}%`,
                transition: pct === null ? undefined : 'width 400ms ease',
              }}
            />
          </span>
          <span className="vnext-meri__work-card-progress-label">
            {progress ? formatElapsed(progress.elapsedMs) : '0s'}
            {hasBudget ? ` OF ${formatElapsed(progress!.budgetMs!)}` : ' ELAPSED'}
          </span>
        </div>
      </div>

      {steps.length > 0 ? (
        <div className="vnext-meri__work-card-steps">
          <MeriAgentSteps steps={steps} />
        </div>
      ) : null}
    </div>
  );
}
