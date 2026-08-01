import { Card, Empty, Skeleton, Tag, Tooltip, Typography } from 'antd';
import type { FundingNarrativeStep, ProgramElementNarrative } from './api.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text } = Typography;

export interface FundingNarrativePanelProps {
  peCode: string;
  data?: ProgramElementNarrative | null;
  loading?: boolean;
  errored?: boolean;
  onRetry?: () => void;
}

/**
 * Phase 4 (4.1) — the assembled "request → marks → enactment" narrative for a
 * single PE's current budget cycle. Each acted stage is one labeled step with
 * its vehicle (authorization vs appropriation) and signed deltas; the FY's
 * material moves are surfaced beneath (4.1.2). Read-only; data + math come from
 * GET /api/program-elements/:peCode/narrative.
 *
 * Phase 5 — failed ≠ valid empty: isError must paint PeSecondaryFailed, never
 * the success Empty for missing stages.
 */
export function FundingNarrativePanel({
  peCode: _peCode,
  data = null,
  loading = false,
  errored = false,
  onRetry,
}: FundingNarrativePanelProps) {
  const title = data?.currentCycleFy
    ? `Funding narrative — FY${data.currentCycleFy}`
    : 'Funding narrative';

  if (loading) {
    return (
      <Card size="small" title={title}>
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <Card size="small" title={title}>
        <PeSecondaryFailed
          label="funding narrative"
          testId="pe-secondary-failed-narrative"
          onRetry={onRetry}
        />
      </Card>
    );
  }

  return (
    <Card size="small" title={title}>
      {!data?.steps?.length ? (
        <Empty description="No current-cycle funding stages recorded for this program element yet." />
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.steps.map((s, i) => (
              <NarrativeStepRow key={s.stage} step={s} first={i === 0} />
            ))}
          </div>
          {(data.materiality?.length ?? 0) > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Most material moves this cycle
              </Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {data.materiality.map((m, i) => (
                  <Tooltip
                    key={i}
                    title={
                      m.materialityScore != null
                        ? `Materiality ${m.materialityScore.toFixed(2)}`
                        : undefined
                    }
                  >
                    <Tag color="geekblue">{m.deltaType ?? 'change'}</Tag>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const VEHICLE_COLOR: Record<string, string> = {
  request: 'default',
  authorization: 'purple',
  appropriation: 'green',
};

function NarrativeStepRow({ step, first }: { step: FundingNarrativeStep; first: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <Tag
        color={VEHICLE_COLOR[step.vehicle] ?? 'default'}
        style={{ minWidth: 78, textAlign: 'center' }}
      >
        {step.label}
      </Tag>
      <Text strong>{fmtM(step.valueM)}</Text>
      {!first && step.deltaVsPriorStageM != null && step.deltaVsPriorStageM !== 0 && (
        <Text type={step.deltaVsPriorStageM > 0 ? 'success' : 'danger'} style={{ fontSize: 12 }}>
          {signed(step.deltaVsPriorStageM)} vs prior
        </Text>
      )}
      {step.deltaVsRequestM != null && step.deltaVsRequestM !== 0 && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          ({signed(step.deltaVsRequestM)} vs request)
        </Text>
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>
        · {step.vehicle}
      </Text>
    </div>
  );
}

function fmtM(m: number): string {
  return `$${m.toFixed(1)}M`;
}
function signed(m: number): string {
  return `${m > 0 ? '+' : ''}${m.toFixed(1)}M`;
}
