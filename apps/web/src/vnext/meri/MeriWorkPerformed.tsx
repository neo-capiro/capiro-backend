import { INTENT_LABELS, type TrustStep } from '../../components/chat/WorkPerformed.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

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
  spin?: boolean;
}

// Only 'done' | 'running' | 'error' occur in real TrustStep data — the
// prototype's STEP dictionary also has 'queued' and 'skipped' entries, but
// nothing in the trust-step stream distinguishes an upcoming step from one
// that never ran, so those two tones are intentionally not reachable here.
const STEP_TONE: Record<TrustStep['status'], StepTone> = {
  done: { state: 'DONE', icon: 'Check', dotBg: '#101828', dotFg: '#ffffff', pillBg: '#F2F4F7', pillFg: '#344054', ring: 'inset 0 0 0 1px #EAECF0' },
  running: { state: 'RUNNING', icon: 'Loading01', dotBg: '#101828', dotFg: '#ffffff', pillBg: '#F2F4F7', pillFg: '#101828', ring: 'inset 0 0 0 1px #D0D5DD,0 0 0 3px #F2F4F7', spin: true },
  error: { state: 'FAILED', icon: 'XClose', dotBg: '#FEF3F2', dotFg: '#B42318', pillBg: '#FEF3F2', pillFg: '#B42318', ring: 'inset 0 0 0 1px #FECDCA' },
};

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
    <div style={{ margin: '0 18px 16px' }}>
      <div
        style={{
          padding: '16px 18px',
          borderRadius: 11,
          backgroundImage: 'var(--m-metal-bg)',
          boxShadow: 'var(--m-metal-sheen)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '.1em', color: '#98A2B3' }}>
            {planLabel.toUpperCase()}
            {tier === 'deep' ? ' · DEEP' : ''}
          </span>
          <span style={{ flex: 1 }} />
          {sourceCount > 0 ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                height: 24,
                padding: '0 9px',
                borderRadius: 6,
                background: 'rgba(255,255,255,.1)',
              }}
            >
              <span
                className={`vnext-meri__work-source-dot${isStreaming ? ' is-live' : ''}`}
                style={{ width: 6, height: 6, borderRadius: 9999, background: '#12B76A' }}
              />
              <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: '#ffffff' }}>
                {sourceCount} SOURCE{sourceCount === 1 ? '' : 'S'}
              </span>
            </span>
          ) : null}
        </div>
        <div style={{ marginTop: 10, fontSize: 16, lineHeight: '23px', fontWeight: 600, color: '#ffffff' }}>
          {title}
        </div>
        {isStreaming ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <span style={{ flex: 1, height: 6, borderRadius: 9999, background: '#1D2939', overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  width: `${pct}%`,
                  height: '100%',
                  borderRadius: 9999,
                  background: 'linear-gradient(90deg,#98A2B3,#ffffff)',
                  transition: 'width 240ms ease',
                }}
              />
            </span>
            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '.08em', color: '#ffffff' }}>
              {doneCount} OF {toolCount || '?'}
            </span>
          </div>
        ) : null}
      </div>

      {planSteps && planSteps.length > 0 ? (
        <div
          style={{
            marginTop: 10,
            padding: '11px 13px',
            borderRadius: 9,
            background: '#F9FAFB',
            boxShadow: 'inset 0 0 0 1px #EAECF0',
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.09em', color: '#667085' }}>
            PLAN
          </div>
          <ol style={{ margin: '7px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: '19px', color: '#344054' }}>
            {planSteps.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                  boxShadow: tone.ring,
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
      ) : null}

      <div style={{ marginTop: 10, fontSize: 11, lineHeight: '16px', color: '#98A2B3' }}>
        This shows bounded plans, tools, sources, and checks — not private model reasoning.
      </div>
    </div>
  );
}
