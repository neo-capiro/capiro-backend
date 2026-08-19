/**
 * vNext re-skin of components/ai-usage/UsageSummaryPanels.tsx — identical
 * summary shape (usage-summary-shared.ts), identical copy and the same
 * recharts by-day trend; presentation on the vNext primitives. Shared by the
 * tenant AI Usage tab and the capiro-admin per-tenant drill-down, exactly like
 * canonical.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  fmtTokens,
  fmtUsd,
  type TenantUsageSummary,
  type UsageBucket,
} from '../../../components/ai-usage/usage-summary-shared.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { SvCard, SvStat } from './settings-ui.js';

function BreakdownTable<K extends 'workflow' | 'model'>({
  keyLabel,
  keyField,
  rows,
}: {
  keyLabel: string;
  keyField: K;
  rows: Array<UsageBucket & Record<K, string>>;
}) {
  return (
    <CapiroTableWrap>
      <CapiroTable>
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>{keyLabel}</CapiroTableHeaderCell>
            <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Est. cost</CapiroTableHeaderCell>
            <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Tokens</CapiroTableHeaderCell>
            <CapiroTableHeaderCell style={{ textAlign: 'right' }}>Runs</CapiroTableHeaderCell>
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {rows.length === 0 ? (
            <tr>
              <CapiroTableCell colSpan={4}>
                <span className="stv-muted">No usage yet</span>
              </CapiroTableCell>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row[keyField]}>
                <CapiroTableCell>{row[keyField]}</CapiroTableCell>
                <CapiroTableCell style={{ textAlign: 'right' }}>{fmtUsd(row.costUsd)}</CapiroTableCell>
                <CapiroTableCell style={{ textAlign: 'right' }}>
                  {fmtTokens(row.inputTokens + row.outputTokens)}
                </CapiroTableCell>
                <CapiroTableCell style={{ textAlign: 'right' }}>{row.count}</CapiroTableCell>
              </tr>
            ))
          )}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}

export function VNextUsageSummaryPanels({
  summary,
  loading,
}: {
  summary?: TenantUsageSummary;
  loading?: boolean;
}) {
  if (loading || !summary) {
    return (
      <div className="stv-stack" aria-label="Loading AI usage">
        <CapiroSkeleton height={20} width="35%" />
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="80%" />
        <CapiroSkeleton height={16} width="60%" />
      </div>
    );
  }

  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;

  return (
    <div className="stv-stack">
      <div className="stv-grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <SvCard>
          <SvStat label="Estimated spend" value={fmtUsd(summary.totalCostUsd)} />
        </SvCard>
        <SvCard>
          <SvStat label="Tokens" value={fmtTokens(totalTokens)} />
        </SvCard>
        <SvCard>
          <SvStat
            label="Generations"
            value={summary.eventCount}
            hint={
              summary.tenantKeyEventCount > 0
                ? `${summary.tenantKeyEventCount} billed to your own key`
                : undefined
            }
          />
        </SvCard>
      </div>

      <SvCard title="Estimated cost by day">
        {summary.byDay.length ? (
          <div style={{ width: '100%', height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={summary.byDay} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v: number) => fmtUsd(v)} tick={{ fontSize: 11 }} width={70} />
                <Tooltip formatter={(v) => fmtUsd(Number(v))} />
                <Line type="monotone" dataKey="costUsd" name="Est. cost" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <CapiroEmptyState title="No AI usage in this period" />
        )}
      </SvCard>

      <div className="stv-grid-2">
        <SvCard title="By workflow">
          <BreakdownTable keyLabel="Workflow" keyField="workflow" rows={summary.byWorkflow} />
        </SvCard>
        <SvCard title="By model">
          <BreakdownTable keyLabel="Model" keyField="model" rows={summary.byModel} />
        </SvCard>
      </div>
    </div>
  );
}
