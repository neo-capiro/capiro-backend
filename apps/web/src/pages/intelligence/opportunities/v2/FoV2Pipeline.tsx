/**
 * Funding Opportunities v2 — the pursuit Pipeline (board + list).
 *
 * The mockup's five columns (REVIEWING · QUALIFIED · PURSUING · SUBMITTED ·
 * CLOSED), one card per pursuit, over the real P35 pipeline board API. The API's
 * vocabulary splits CLOSED into won/lost/passed; the board groups them into the
 * mockup's CLOSED column, and LIST view falls back to the triage queue's pursuing
 * filter.
 *
 * Stage changes are human actions: the board offers only the server's
 * `allowedTransitions`, posting back the optimistic-concurrency `version`. A
 * machine recommendation never moves a card.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Skeleton } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import {
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES_NEEDING_REASON,
  pipelineStageApiPath,
  type OpportunityRef,
  type PipelineBoardView,
  type PipelineCardView,
  type PipelineStageView,
} from '../funding-opportunities-api.js';
import { clientInitials } from './fo-v2-model.js';

/* The mockup's five columns, mapped onto the API's seven-stage vocabulary. */
const COLUMNS: Array<{ key: string; label: string; stages: PipelineStageView[]; note: string }> = [
  {
    key: 'reviewing',
    label: 'REVIEWING',
    stages: ['reviewing'],
    note: 'New recommendations land here until a person qualifies or passes them.',
  },
  {
    key: 'qualified',
    label: 'QUALIFIED',
    stages: ['qualified'],
    note: 'Nothing has cleared review yet.',
  },
  { key: 'pursuing', label: 'PURSUING', stages: ['pursuing'], note: 'No active pursuits.' },
  {
    key: 'submitted',
    label: 'SUBMITTED',
    stages: ['submitted'],
    note: 'Submission is an explicit human action.',
  },
  {
    key: 'closed',
    label: 'CLOSED',
    stages: ['won', 'lost', 'passed'],
    note: 'Won, lost and passed pursuits collect here with their outcome.',
  },
];

export function FoV2Pipeline({
  clientId,
  clientName,
  view,
  board,
  loading,
  flagEnabled,
  onOpen,
  compact,
  notify,
  onChanged,
}: {
  clientId: string | null;
  clientName: string | undefined;
  view: 'board' | 'list';
  board: PipelineBoardView | undefined;
  loading: boolean;
  flagEnabled: boolean;
  onOpen: (ref: OpportunityRef) => void;
  compact: boolean;
  notify: ReturnType<typeof AntApp.useApp>['notification'];
  onChanged: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();

  const move = useMutation({
    mutationFn: async (input: {
      card: PipelineCardView;
      to: PipelineStageView;
      reason?: string;
    }) => {
      if (!clientId) throw new Error('Select a client first.');
      await api.post(pipelineStageApiPath(clientId, input.card.rowId), {
        stage: input.to,
        version: input.card.version,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    },
    onSuccess: (_r, input) => {
      notify.success({
        message: `Moved to ${PIPELINE_STAGE_LABELS[input.to]}`,
        description: input.card.title ?? undefined,
      });
      void qc.invalidateQueries({ queryKey: ['fo-v2-pipeline', clientId] });
      onChanged();
    },
    onError: () => notify.error({ message: 'Stage move failed' }),
  });

  if (!flagEnabled) {
    return (
      <div className="fo-v2-empty-wrap">
        <div className="fo-v2-empty" data-testid="fo-v2-pipeline-off">
          <div className="fo-v2-empty-tag">⊘ NOT ENABLED</div>
          <div className="fo-v2-empty-title">The pursuit pipeline is not enabled</div>
          <div className="fo-v2-empty-body">
            The board rides on the{' '}
            <span className="fo-v2-mono">funding_opportunities_pipeline_v2</span> capability, which
            is off for this tenant.
          </div>
        </div>
      </div>
    );
  }

  if (!clientId) {
    return (
      <div className="fo-v2-empty-wrap">
        <div className="fo-v2-empty" data-testid="fo-v2-pipeline-noclient">
          <div className="fo-v2-empty-tag">⊘ NO CLIENT SELECTED</div>
          <div className="fo-v2-empty-title">The pipeline is per-client</div>
          <div className="fo-v2-empty-body">
            A pursuit is a fact about one client and one opportunity. Choose a client above to see
            its board; the funnel count covers every client.
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

  const cards = board?.cards ?? [];

  if (view === 'list') {
    // List view: one row per card, stage-labelled, no columns.
    return (
      <div className="fo-v2-queue" data-testid="fo-v2-pipeline-list">
        {cards.length === 0 ? (
          <div className="fo-v2-empty-wrap">
            <div className="fo-v2-empty">
              <div className="fo-v2-empty-tag">⊘ NOTHING IN THE PIPELINE</div>
              <div className="fo-v2-empty-title">No pursuits for {clientName ?? 'this client'}</div>
              <div className="fo-v2-empty-body">
                Accepting a recommendation from the triage queue starts a pursuit. None has been
                started for this client.
              </div>
            </div>
          </div>
        ) : (
          cards.map((c) => (
            <div
              key={c.rowId}
              className={`fo-v2-row${compact ? ' compact' : ''}`}
              onClick={() =>
                c.source && c.sourceRecordId
                  ? onOpen({
                      source: c.source as OpportunityRef['source'],
                      sourceRecordId: c.sourceRecordId,
                      clientId,
                    })
                  : undefined
              }
              role="button"
              tabIndex={0}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div className="fo-v2-row-title" style={{ flex: 1, minWidth: 0, marginTop: 0 }}>
                  {c.title ?? 'Untitled pursuit'}
                </div>
                <span className="fo-v2-chip fo-v2-chip-monitor">
                  {c.stage ? PIPELINE_STAGE_LABELS[c.stage].toUpperCase() : 'UNSTAGED'}
                </span>
                <span className="fo-v2-mono-sm">
                  {c.responseDeadline
                    ? `CLOSES ${c.responseDeadline.slice(0, 10).toUpperCase()}`
                    : 'NO DEADLINE'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    );
  }

  return (
    <div className="fo-v2-board" data-testid="fo-v2-pipeline-board">
      <div className="fo-v2-board-grid">
        {COLUMNS.map((col) => {
          const colCards = cards.filter((c) => c.stage != null && col.stages.includes(c.stage));
          return (
            <div key={col.key} style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div className={`fo-v2-col-head${col.key === 'pursuing' ? ' hot' : ''}`}>
                <span className="fo-v2-col-label">{col.label}</span>
                <span className="fo-v2-col-count">{colCards.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 9 }}>
                {colCards.map((c) => (
                  <PipelineCard
                    key={c.rowId}
                    card={c}
                    compact={compact}
                    onOpen={onOpen}
                    clientId={clientId}
                    onMove={(to, reason) => move.mutate({ card: c, to, reason })}
                    moving={move.isPending}
                  />
                ))}
                {colCards.length === 0 ? (
                  <div className="fo-v2-col-empty">
                    <div className="fo-v2-empty-tag">NOTHING IN THIS STAGE</div>
                    <div
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        color: 'var(--fov2-body)',
                        marginTop: 5,
                      }}
                    >
                      {col.note}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="fo-v2-board-note">
        A machine recommendation never moves a stage. Producers refresh evidence, relevance and
        risk; stage, decision and owner are human actions recorded on the pursuit.
      </div>
    </div>
  );
}

function PipelineCard({
  card,
  compact,
  onOpen,
  clientId,
  onMove,
  moving,
}: {
  card: PipelineCardView;
  compact: boolean;
  onOpen: (ref: OpportunityRef) => void;
  clientId: string;
  onMove: (to: PipelineStageView, reason?: string) => void;
  moving: boolean;
}) {
  const nextStage = card.allowedTransitions[0];
  return (
    <div
      className={`fo-v2-card${compact ? ' compact' : ''}`}
      data-testid={`fo-v2-card-${card.rowId}`}
      onClick={() =>
        card.source && card.sourceRecordId
          ? onOpen({
              source: card.source as OpportunityRef['source'],
              sourceRecordId: card.sourceRecordId,
              clientId,
            })
          : undefined
      }
      role="button"
      tabIndex={0}
    >
      <div className="fo-v2-card-title">{card.title ?? 'Untitled pursuit'}</div>
      <div className="fo-v2-mono-sm">{card.sourceRecordId ?? ''}</div>
      <div className="fo-v2-card-rule" />
      <div className="fo-v2-card-next">{card.stageExplanation}</div>
      {nextStage ? (
        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="fo-v2-btn-mono"
            disabled={moving}
            onClick={() => {
              const needsReason = (PIPELINE_STAGES_NEEDING_REASON as readonly string[]).includes(
                nextStage,
              );
              const reason = needsReason
                ? (window.prompt(`Reason for moving to ${PIPELINE_STAGE_LABELS[nextStage]}?`) ??
                  undefined)
                : undefined;
              if (needsReason && reason == null) return;
              onMove(nextStage, reason);
            }}
          >
            → {PIPELINE_STAGE_LABELS[nextStage].toUpperCase()}
          </button>
        </div>
      ) : null}
    </div>
  );
}
