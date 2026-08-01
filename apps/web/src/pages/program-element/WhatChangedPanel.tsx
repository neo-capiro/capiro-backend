import { Card, Empty, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import type { ProgramElementDelta } from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text } = Typography;

export interface WhatChangedPanelProps {
  deltas: ProgramElementDelta[] | null | undefined;
  loading?: boolean;
  max?: number;

  errored?: boolean;
  onRetry?: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  pb_vs_prior_pb: 'PB vs prior PB',
  mark_vs_request: 'Mark vs request',
  mark_vs_mark: 'Mark divergence',
  conference_vs_marks: 'Conference',
  enacted_vs_request: 'Enacted vs request',
  new_start: 'New start',
  termination: 'Termination',
  zeroed: 'Zeroed',
  transfer_candidate: 'Transfer (candidate)',
  quantity_change: 'Quantity',
  unit_cost_change: 'Unit cost',
  outyear_shift: 'Outyear shift',
  project_level_change: 'Project change',
};

function num(v: string | number | null): number | null {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function m(v: string | number | null): string {
  const n = num(v);
  return n === null ? '—' : `$${n.toFixed(0)}M`;
}
/** Materiality band → tag color (≥0.7 critical, ≥0.4 notable). */
export function materialityColor(score: number): string {
  if (score >= 0.7) return 'red';
  if (score >= 0.4) return 'orange';
  return 'default';
}

/**
 * Step 1.4 — "What changed": the top materiality-scored budget deltas for this PE
 * (type badge, from→to in $M + %, materiality score). Honest empty state.
 */
export function WhatChangedPanel({ deltas, loading = false, max = 5,
  errored = false,
  onRetry,
}: WhatChangedPanelProps) {
  if (loading) {
    return (
      <Card title="What changed">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="what changed deltas" testId="pe-secondary-failed-deltas" onRetry={onRetry} />
    );
  }


  const rows = Array.isArray(deltas) ? deltas.slice(0, max) : [];
  if (rows.length === 0) {
    return (
      <Card className="pe-whatchanged-card" title="What changed">
        <Empty description="No scored budget changes for this PE yet — populated once the delta engine runs." />
      </Card>
    );
  }

  return (
    <Card className="pe-whatchanged-card" title="What changed">
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {rows.map((d) => {
          const pct = d.deltaPct !== null ? ` (${d.deltaPct >= 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(0)}%)` : '';
          return (
            <div key={d.id} style={{ borderBottom: '1px solid #f0f0f0', paddingBottom: 6 }}>
              <Space wrap size={[6, 4]}>
                <Tag color="blue">{TYPE_LABEL[d.deltaType] ?? d.deltaType}</Tag>
                <Tag>FY{d.assertedFy}</Tag>
                <Text>
                  {m(d.amountFrom)} → <b>{m(d.amountTo)}</b>
                  {pct}
                </Text>
                <Tooltip title={`Materiality ${d.materialityScore.toFixed(2)}`}>
                  <Tag color={materialityColor(d.materialityScore)}>{(d.materialityScore * 100).toFixed(0)}</Tag>
                </Tooltip>
              </Space>
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

export default WhatChangedPanel;
