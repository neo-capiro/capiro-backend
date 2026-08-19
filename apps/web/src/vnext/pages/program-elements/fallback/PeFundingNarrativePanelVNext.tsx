/**
 * Funding narrative — native vNext port of
 * `pages/program-element/FundingNarrativePanel.tsx` (Phase 4 §4.1). Read-only;
 * data + math come from GET /api/program-elements/:peCode/narrative.
 * Phase 5 — failed ≠ valid empty: isError must paint the secondary-failed
 * state, never the success Empty for missing stages.
 */
import type {
  FundingNarrativeStep,
  ProgramElementNarrative,
} from '../../../../pages/program-element/api.js';
import {
  PeFbEmpty,
  PeFbPanel,
  PeFbSecondaryFailed,
  PeFbSkeleton,
  PeFbTag,
} from './pe-fallback-ui.js';

export interface FundingNarrativePanelVNextProps {
  peCode: string;
  data?: ProgramElementNarrative | null;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

export function PeFundingNarrativePanelVNext({
  peCode: _peCode,
  data = null,
  loading = false,
  errored = false,
  onRetry,
}: FundingNarrativePanelVNextProps) {
  const title = data?.currentCycleFy
    ? `Funding narrative — FY${data.currentCycleFy}`
    : 'Funding narrative';

  if (loading) {
    return (
      <PeFbPanel title={title}>
        <PeFbSkeleton rows={3} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbPanel title={title}>
        <PeFbSecondaryFailed
          label="funding narrative"
          testId="pe-secondary-failed-narrative"
          onRetry={onRetry}
        />
      </PeFbPanel>
    );
  }

  return (
    <PeFbPanel title={title}>
      {!data?.steps?.length ? (
        <PeFbEmpty description="No current-cycle funding stages recorded for this program element yet." />
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.steps.map((s, i) => (
              <NarrativeStepRow key={s.stage} step={s} first={i === 0} />
            ))}
          </div>
          {(data.materiality?.length ?? 0) > 0 && (
            <div style={{ marginTop: 12 }}>
              <span className="pe-fb-muted" style={{ fontSize: 12 }}>
                Most material moves this cycle
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {data.materiality.map((m, i) => (
                  <PeFbTag
                    key={i}
                    color="geekblue"
                    title={
                      m.materialityScore != null
                        ? `Materiality ${m.materialityScore.toFixed(2)}`
                        : undefined
                    }
                  >
                    {m.deltaType ?? 'change'}
                  </PeFbTag>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </PeFbPanel>
  );
}

const VEHICLE_COLOR: Record<string, string> = {
  request: 'default',
  authorization: 'purple',
  appropriation: 'green',
};

function NarrativeStepRow({ step, first }: { step: FundingNarrativeStep; first: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <PeFbTag
        color={VEHICLE_COLOR[step.vehicle] ?? 'default'}
        style={{ minWidth: 78, textAlign: 'center', justifyContent: 'center' }}
      >
        {step.label}
      </PeFbTag>
      <strong>{fmtM(step.valueM)}</strong>
      {!first && step.deltaVsPriorStageM != null && step.deltaVsPriorStageM !== 0 && (
        <span
          style={{
            fontSize: 12,
            color:
              step.deltaVsPriorStageM > 0
                ? 'var(--capiro-color-success)'
                : 'var(--capiro-color-danger)',
          }}
        >
          {signed(step.deltaVsPriorStageM)} vs prior
        </span>
      )}
      {step.deltaVsRequestM != null && step.deltaVsRequestM !== 0 && (
        <span className="pe-fb-muted" style={{ fontSize: 12 }}>
          ({signed(step.deltaVsRequestM)} vs request)
        </span>
      )}
      <span className="pe-fb-muted" style={{ fontSize: 12 }}>
        · {step.vehicle}
      </span>
    </div>
  );
}

function fmtM(m: number): string {
  return `$${m.toFixed(1)}M`;
}
function signed(m: number): string {
  return `${m > 0 ? '+' : ''}${m.toFixed(1)}M`;
}
