import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import './meri-agent-steps.css';

/**
 * Shared step-row rendering for the v4 agent-run hero (MeriWorkPerformed) and
 * the deep-research hero (MeriResearchProgress) — both drive the same
 * TrustStep[] shape and should render one visual language, not two.
 *
 * Only 'done' | 'running' | 'error' occur in real TrustStep data — the
 * prototype's STEP dictionary also has 'queued' and 'skipped' entries, but
 * nothing in the trust-step stream distinguishes an upcoming step from one
 * that never ran, so those two tones are intentionally not reachable.
 */

const STEP_TONE: Record<TrustStep['status'], { state: string; icon: MeriIconName; spin?: boolean }> = {
  done:    { state: 'DONE',    icon: 'Check' },
  running: { state: 'RUNNING', icon: 'Loading01', spin: true },
  error:   { state: 'FAILED',  icon: 'XClose' },
};

export function MeriAgentSteps({ steps }: { steps: TrustStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="meri-agent-steps-list">
      {steps.map((step, index) => {
        const tone = STEP_TONE[step.status];
        return (
          <div
            key={`${step.tool}-${index}`}
            className="meri-agent-step"
            data-status={step.status}
          >
            <span className={`meri-agent-step__dot${tone.spin ? ' is-running' : ''}`}>
              <MeriIcon name={tone.icon} size={11} />
            </span>
            <span className="meri-agent-step__body">
              <span className="meri-agent-step__label">
                {step.label}
              </span>
              {step.detail ? (
                <span className="meri-agent-step__detail">
                  {step.detail}
                </span>
              ) : null}
            </span>
            <span className="meri-agent-step__pill">{tone.state}</span>
          </div>
        );
      })}
    </div>
  );
}
