import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { formatElapsed } from '../../components/chat/useMeriChatController.js';
import { MeriAgentSteps } from './MeriAgentSteps.js';

/** Elapsed time is liveness, not a completion percentage. */

interface MeriResearchProgressProps {
  isStreaming: boolean;
  progress: { note: string; elapsedMs: number; budgetMs?: number } | null;
  steps: TrustStep[];
  scope?: string | null;
}

export function MeriResearchProgress({
  isStreaming,
  progress,
  steps,
  scope,
}: MeriResearchProgressProps) {
  if (!isStreaming) return null;

  const sourceCount = steps.reduce(
    (sum, step) => sum + (typeof step.count === 'number' ? step.count : 0),
    0,
  );

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

        <div className="vnext-meri__work-card-title">{progress?.note || 'Researching…'}</div>

        <div className="vnext-meri__work-card-progress-row">
          <span className="vnext-meri__work-card-progress-track">
            <span
              className="vnext-meri__work-card-progress-fill vnext-meri__research-bar-indeterminate"
              style={{ width: '35%' }}
            />
          </span>
          <span className="vnext-meri__work-card-progress-label">
            {progress ? formatElapsed(progress.elapsedMs) : '0s'}
            {' ELAPSED'}
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
