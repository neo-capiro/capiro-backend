/**
 * Funding Opportunities v2 — the Triage / Matched queue (list of decision rows).
 *
 * One row per CLIENT-OPPORTUNITY decision context from the inbox API. Each row
 * shows client mark, source id, title, strongest reason, primary risk, fit,
 * evidence, eligibility and agency on the left; the recommendation chip, due line,
 * next action and the OPEN · MONITOR · PASS actions on the right — the mockup's
 * queue row contract.
 *
 * MONITOR and PASS write the human DECISION (P-endpoint), which is separate from
 * workflow status; OPEN opens the detail drawer. A machine recommendation never
 * moves anything — only these human decisions do.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Skeleton } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import {
  asCatalogRef,
  isForecastRow,
  type InboxResponse,
  type InboxRow,
  type OpportunityRef,
} from '../funding-opportunities-api.js';
import { clientInitials, evidenceMark, fitFromScore, recChip } from './fo-v2-model.js';

export function FoV2Queue({
  dest,
  queue,
  inbox,
  loading,
  inboxAvailable,
  onOpen,
  compact,
  clientId,
  notify,
  onChanged,
}: {
  dest: 'triage' | 'matched';
  queue: string;
  inbox: InboxResponse | undefined;
  loading: boolean;
  inboxAvailable: boolean;
  onOpen: (ref: OpportunityRef) => void;
  compact: boolean;
  clientId: string | undefined;
  notify: ReturnType<typeof AntApp.useApp>['notification'];
  onChanged: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();

  const decide = useMutation({
    mutationFn: async (input: { row: InboxRow; decision: 'monitor' | 'pass' }) => {
      const { row, decision } = input;
      await api.post(
        `/api/intelligence/clients/${encodeURIComponent(row.client.id)}/opportunities/${encodeURIComponent(row.source)}/${encodeURIComponent(row.sourceRecordId)}/decision`,
        { decision },
      );
    },
    onSuccess: (_r, input) => {
      notify.success({
        message: input.decision === 'monitor' ? 'Monitoring' : 'Passed',
        description: input.row.title,
      });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
      onChanged();
    },
    onError: () => notify.error({ message: 'Decision failed' }),
  });

  if (!inboxAvailable) {
    return (
      <div className="fo-v2-empty-wrap">
        <div className="fo-v2-empty" data-testid="fo-v2-inbox-off">
          <div className="fo-v2-empty-tag">⊘ NOT ENABLED</div>
          <div className="fo-v2-empty-title">The triage inbox is not enabled</div>
          <div className="fo-v2-empty-body">
            The client-first triage queue rides on the{' '}
            <span className="fo-v2-mono">funding_opportunities_client_inbox</span> capability, which
            is off for this tenant. The full catalog is under Explore.
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  const rows = inbox?.rows ?? [];

  if (!rows.length) {
    return (
      <div className="fo-v2-empty-wrap">
        <div className="fo-v2-empty" data-testid="fo-v2-queue-empty">
          <div className="fo-v2-empty-tag">⊘ {emptyTag(queue)}</div>
          <div className="fo-v2-empty-title">{emptyTitle(queue)}</div>
          <div className="fo-v2-empty-body">{emptyBody(queue)}</div>
          <div className="fo-v2-empty-foot">
            FILTERS APPLIED · {clientId ? 'ONE CLIENT' : 'ALL CLIENTS'} · ALL SOURCES
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fo-v2-queue" data-testid="fo-v2-queue">
      {rows.map((r) => (
        <QueueRow
          key={r.id}
          row={r}
          compact={compact}
          onOpen={onOpen}
          onDecide={(decision) => decide.mutate({ row: r, decision })}
          deciding={decide.isPending}
        />
      ))}
    </div>
  );
}

function QueueRow({
  row,
  compact,
  onOpen,
  onDecide,
  deciding,
}: {
  row: InboxRow;
  compact: boolean;
  onOpen: (ref: OpportunityRef) => void;
  onDecide: (decision: 'monitor' | 'pass') => void;
  deciding: boolean;
}) {
  const forecast = isForecastRow(row);
  const catalog = asCatalogRef({
    source: row.source,
    sourceRecordId: row.sourceRecordId,
    clientId: row.client.id,
  });
  const chip = recChip(row.humanDecision ?? row.workflowStatus);
  const ev = evidenceMark({ eligibility: { state: row.eligibility.state ?? 'unknown' } });
  const fit = fitFromScore(row.relevanceScore);
  const days = row.daysUntilDeadline;
  const urgent = days != null && days <= 14;

  return (
    <div
      className={`fo-v2-row${compact ? ' compact' : ''}`}
      data-testid={`fo-v2-row-${row.id}`}
      onClick={() =>
        onOpen({ source: row.source, sourceRecordId: row.sourceRecordId, clientId: row.client.id })
      }
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter')
          onOpen({
            source: row.source,
            sourceRecordId: row.sourceRecordId,
            clientId: row.client.id,
          });
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div className={`fo-v2-mark ${compact ? 'fo-v2-mark-18' : 'fo-v2-mark-22'}`} aria-hidden>
          {clientInitials(row.client.name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span className="fo-v2-mono-sm">{row.client.name.toUpperCase()}</span>
            <span className="fo-v2-mono-sm" style={{ color: 'var(--fov2-border-strong)' }}>
              /
            </span>
            <span className="fo-v2-mono-sm">{row.sourceRecordId}</span>
            {forecast ? <span className="fo-v2-chip fo-v2-chip-forecast">◈ FORECAST</span> : null}
          </div>
          <div className="fo-v2-row-title">{row.title}</div>
          <div className="fo-v2-row-meta">
            <span
              className={`fo-v2-fit ${fit === 'Strong fit' ? 'fo-v2-fit-strong' : fit === 'Weak fit' ? 'fo-v2-fit-weak' : 'fo-v2-fit-mod'}`}
            >
              {fit.toUpperCase()}
            </span>
            <span className="fo-v2-mono-sm">{ev.text}</span>
            <span className="fo-v2-mono-sm">
              ELIG {(row.eligibility.state ?? 'unknown').toUpperCase()}
            </span>
            {row.agency ? <span className="fo-v2-mono-sm">{row.agency.toUpperCase()}</span> : null}
          </div>
        </div>
        <div
          style={{
            flex: 'none',
            width: 196,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 7,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className={`fo-v2-chip ${chip.cls}`}>{chip.text}</span>
          <span
            className={`fo-v2-due ${urgent ? 'fo-v2-due-urgent' : 'fo-v2-due-normal'}`}
            style={{ fontSize: 11.5 }}
          >
            {row.responseDeadline
              ? `CLOSES ${row.responseDeadline.slice(0, 10).toUpperCase()}`
              : 'NO DEADLINE STATED'}
            {days != null ? ` · ${days} D` : ''}
          </span>
          {row.nextAction ? (
            <span
              style={{
                fontSize: 12,
                color: 'var(--fov2-body)',
                textAlign: 'right',
                lineHeight: 1.45,
              }}
            >
              {row.nextAction}
            </span>
          ) : null}
          <div className="fo-v2-row-actions">
            <button
              type="button"
              className="fo-v2-btn-mono primary"
              onClick={() =>
                onOpen({
                  source: row.source,
                  sourceRecordId: row.sourceRecordId,
                  clientId: row.client.id,
                })
              }
            >
              OPEN
            </button>
            {!forecast ? (
              <>
                <button
                  type="button"
                  className="fo-v2-btn-mono"
                  disabled={deciding}
                  onClick={() => onDecide('monitor')}
                >
                  MONITOR
                </button>
                <button
                  type="button"
                  className="fo-v2-btn-mono"
                  disabled={deciding}
                  onClick={() => onDecide('pass')}
                >
                  PASS
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Empty copy per queue (mockup empties{}) ───────────────────────────────── */
function emptyTag(queue: string): string {
  return queue === 'passed' ? '⊘ NOTHING PASSED' : '⊘ NOTHING IN THIS QUEUE';
}
function emptyTitle(queue: string): string {
  if (queue === 'passed') return 'No opportunity has been passed';
  if (queue === 'monitoring') return 'Nothing is being monitored';
  if (queue === 'deadlines') return 'No deadlines in the next 30 days';
  if (queue === 'recently_changed') return 'No recent material changes';
  return 'Nothing needs review';
}
function emptyBody(queue: string): string {
  if (queue === 'passed')
    return 'Passing is a durable decision, kept separate from a closed or cancelled source notice. Nothing has been passed in the current period, so this queue is genuinely empty rather than filtered.';
  if (queue === 'monitoring')
    return 'Monitoring is a human decision to watch an opportunity without acting on it this week. Nothing has been marked for monitoring.';
  if (queue === 'deadlines')
    return 'A dated, still-open opportunity nobody has passed on would appear here. None closes within 30 days.';
  if (queue === 'recently_changed')
    return 'A material change to a tracked notice — a deadline move, a NAICS change, a cancellation — would appear here. Nothing has changed recently.';
  return 'Machine suggestions nobody has decided on yet land here. Every current suggestion has a human decision recorded.';
}
