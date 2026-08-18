import type { TrustStep } from '../../components/chat/WorkPerformed.js';
import { INTENT_LABELS } from '../../components/chat/WorkPerformed.js';
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

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

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
        <div style={{ marginTop: 8 }}>
          <MeriAgentSteps steps={steps} />
        </div>
      ) : null}

      <div style={{ marginTop: 10, fontSize: 11, lineHeight: '16px', color: '#98A2B3' }}>
        This shows bounded plans, tools, sources, and checks — not private model reasoning.
      </div>
    </div>
  );
}
