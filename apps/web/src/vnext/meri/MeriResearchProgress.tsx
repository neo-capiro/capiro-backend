import type { TrustStep } from '../../components/chat/WorkPerformed.js';
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

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

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
            MERI RESEARCH RUN{scope ? ` · ${scope.toUpperCase()}` : ''}
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
                className="vnext-meri__work-source-dot is-live"
                style={{ width: 6, height: 6, borderRadius: 9999, background: '#12B76A' }}
              />
              <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: '#ffffff' }}>
                {sourceCount} SOURCE{sourceCount === 1 ? '' : 'S'}
              </span>
            </span>
          ) : null}
        </div>

        <div style={{ marginTop: 10, fontSize: 16, lineHeight: '23px', fontWeight: 600, color: '#ffffff' }}>
          {progress?.note || 'Researching…'}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
          <span
            style={{
              flex: 1,
              height: 6,
              borderRadius: 9999,
              background: '#1D2939',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <span
              className={pct === null ? 'vnext-meri__research-bar-indeterminate' : undefined}
              style={{
                display: 'block',
                width: pct === null ? '35%' : `${pct}%`,
                height: '100%',
                borderRadius: 9999,
                background: 'linear-gradient(90deg,#98A2B3,#ffffff)',
                transition: pct === null ? undefined : 'width 400ms ease',
              }}
            />
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '.08em', color: '#ffffff', whiteSpace: 'nowrap' }}>
            {progress ? formatElapsed(progress.elapsedMs) : '0s'}
            {hasBudget ? ` OF ${formatElapsed(progress!.budgetMs!)}` : ' ELAPSED'}
          </span>
        </div>
      </div>

      {steps.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <MeriAgentSteps steps={steps} />
        </div>
      ) : null}
    </div>
  );
}
