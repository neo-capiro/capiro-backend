import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

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

interface StepTone {
  state: string;
  icon: MeriIconName;
  dotBg: string;
  dotFg: string;
  pillBg: string;
  pillFg: string;
  ring: string;
  halo?: string;
  spin?: boolean;
}

const STEP_TONE: Record<TrustStep['status'], StepTone> = {
  done: { state: 'DONE', icon: 'Check', dotBg: '#101828', dotFg: '#ffffff', pillBg: '#F2F0EB', pillFg: '#344054', ring: '#E8E5DF' },
  running: { state: 'RUNNING', icon: 'Loading01', dotBg: '#101828', dotFg: '#ffffff', pillBg: '#F2F0EB', pillFg: '#101828', ring: '#E0DCD4', halo: '0 0 0 3px #F2F0EB', spin: true },
  error: { state: 'FAILED', icon: 'XClose', dotBg: '#FEF3F2', dotFg: '#B42318', pillBg: '#FEF3F2', pillFg: '#B42318', ring: '#FECDCA' },
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
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 11,
              padding: '11px 13px',
              borderRadius: 9,
              background: '#ffffff',
              border: `1px solid ${tone.ring}`,
              boxShadow: tone.halo,
            }}
          >
            <span
              className={`vnext-meri__work-step-icon${tone.spin ? ' is-running' : ''}`}
              style={{
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                marginTop: 1,
                borderRadius: 9999,
                background: tone.dotBg,
              }}
            >
              <MeriIcon name={tone.icon} size={11} color={tone.dotFg} />
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 13, lineHeight: '19px', fontWeight: 500, color: '#101828' }}>
                {step.label}
              </span>
              {step.detail ? (
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.05em', color: '#667085' }}>
                  {step.detail}
                </span>
              ) : null}
            </span>
            <span
              style={{
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                height: 20,
                padding: '0 7px',
                borderRadius: 5,
                background: tone.pillBg,
                fontFamily: MONO,
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '.08em',
                color: tone.pillFg,
              }}
            >
              {tone.state}
            </span>
          </div>
        );
      })}
    </div>
  );
}
