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

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

const STEP_TONE: Record<TrustStep['status'], { state: string; icon: MeriIconName; spin?: boolean }> = {
  done:    { state: 'DONE',    icon: 'Check' },
  running: { state: 'RUNNING', icon: 'Loading01', spin: true },
  error:   { state: 'FAILED',  icon: 'XClose' },
};

export function MeriAgentSteps({ steps }: { steps: TrustStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 13, lineHeight: '19px', fontWeight: 500 }}>
                {step.label}
              </span>
              {step.detail ? (
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.05em', color: '#667085' }}>
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
