import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroButton } from '../../components/actions/index.js';
import { FundingOpportunityV2Icon } from './funding-opportunities-v2-icons.js';
import {
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES_NEEDING_REASON,
  pipelineBoardApiPath,
  pipelineStageApiPath,
  type PipelineBoardView,
  type PipelineCardView,
  type PipelineStageView,
} from './funding-opportunities-domain.js';
import { refreshOpportunityQueries } from './opportunity-query-cache.js';
import {
  boardSummary,
  deadlineForCard,
  displayCount,
  displayDate,
  lastStageChangeText,
  listBasis,
  sourceLabel,
  sourceTone,
  stageCards,
  PURSUIT_REASONS,
  TERMINAL_SENTENCES,
} from './funding-opportunities-v2-pursuit.js';
import './funding-opportunities-v2-pursuit.css';

export { PURSUIT_REASONS } from './funding-opportunities-v2-pursuit.js';

export interface PipelineTitleOpenEvent {
  rowId: string;
  title: string;
  source: string;
  sourceRecordId: string | null;
  sourceReference?: string | null;
  clientId: string;
}

export interface PipelineClientPickerEvent {
  clientId: string | null;
  clientName: string | null;
}

export interface PipelineCountChangeEvent {
  clientId: string | null;
  count: number | null;
  summary: ReturnType<typeof boardSummary> | null;
}

export interface FundingOpportunityPipelineProps {
  clientId: string | null;
  clientName?: string | null;
  /** The parent opens the inline detail without changing this component's view state. */
  onOpenTitle?: (event: PipelineTitleOpenEvent) => void;
  onChooseClient?: (event: PipelineClientPickerEvent) => void;
  onCountChange?: (event: PipelineCountChangeEvent) => void;
  /** Controlled when supplied; otherwise the pipeline owns its board/list state. */
  view?: 'board' | 'list';
  onViewChange?: (view: 'board' | 'list') => void;
}

const QUERY_KEY = 'funding-opportunity-pipeline';

export function FundingOpportunityPipeline({
  clientId,
  clientName,
  onOpenTitle,
  onChooseClient,
  onCountChange,
  view: controlledView,
  onViewChange,
}: FundingOpportunityPipelineProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useCapiroToast();
  const feature = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const [internalView, setInternalView] = useState<'board' | 'list'>('board');
  const view = controlledView ?? internalView;
  const [reasonTarget, setReasonTarget] = useState<{
    card: PipelineCardView;
    to: PipelineStageView;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const reasonTriggerRef = useRef<HTMLElement | null>(null);

  const enabled = feature.ready && feature.enabled && clientId != null;
  const query = useQuery<PipelineBoardView>({
    queryKey: [QUERY_KEY, clientId],
    enabled,
    retry: false,
    queryFn: async () => (await api.get<PipelineBoardView>(pipelineBoardApiPath(clientId!))).data,
  });

  const summary = useMemo(() => (query.data ? boardSummary(query.data) : null), [query.data]);

  useEffect(() => {
    if (!onCountChange) return;
    if (!enabled || query.isPending || query.isFetching || query.isError || !query.data) {
      onCountChange({ clientId, count: null, summary: null });
      return;
    }
    onCountChange({ clientId, count: summary?.inPipeline ?? null, summary });
  }, [
    clientId,
    enabled,
    onCountChange,
    query.data,
    query.isError,
    query.isFetching,
    query.isPending,
    summary,
  ]);

  const mutation = useMutation({
    mutationFn: async ({
      card,
      to,
      reasonText,
    }: {
      card: PipelineCardView;
      to: PipelineStageView;
      reasonText: string | null;
    }) => {
      const response = await api.post(pipelineStageApiPath(clientId!, card.rowId), {
        toStage: to,
        expectedVersion: card.version,
        reason: reasonText,
      });
      return response.data;
    },
    onSuccess: (_result, input) => {
      void refreshOpportunityQueries(queryClient);
      toast.success(`Moved to ${PIPELINE_STAGE_LABELS[input.to]}. The stage change was recorded.`);
      setReasonTarget(null);
      setReason('');
      setNote('');
    },
    onError: async (error: unknown) => {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        await queryClient.invalidateQueries({ queryKey: [QUERY_KEY, clientId] });
        toast.error(
          'This opportunity changed while you were viewing it. The board was refreshed; review it before moving it again.',
        );
        return;
      }
      toast.error(
        apiErrorMessage(error) ?? 'The stage change was not recorded. No board state was changed.',
      );
    },
  });

  const setPipelineView = (next: 'board' | 'list') => {
    if (controlledView == null) setInternalView(next);
    onViewChange?.(next);
  };

  const closeReasonDialog = () => {
    const trigger = reasonTriggerRef.current;
    setReasonTarget(null);
    setReason('');
    setNote('');
    requestAnimationFrame(() => trigger?.focus());
  };

  const requestMove = (card: PipelineCardView, to: PipelineStageView) => {
    if (PIPELINE_STAGES_NEEDING_REASON.includes(to)) {
      reasonTriggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setReasonTarget({ card, to });
      setReason('');
      setNote('');
      return;
    }
    mutation.mutate({ card, to, reasonText: null });
  };

  if (!feature.ready) {
    return (
      <PursuitShell>
        <div className="fo-v2-pursuit__loading" aria-busy="true">
          Checking whether the pursuit pipeline is available…
        </div>
      </PursuitShell>
    );
  }
  if (!feature.enabled) {
    return (
      <PursuitShell>
        <div className="fo-v2-pursuit__unavailable">
          <strong>Pursuit is not available for this workspace.</strong>
          <span>The pipeline feature is disabled, so no records were requested or inferred.</span>
        </div>
      </PursuitShell>
    );
  }
  if (clientId == null) {
    return (
      <section
        className="fo-v2-pursuit fo-v2-pursuit--no-client"
        data-testid="fo-pursuit-no-client"
      >
        <div className="fo-v2-pursuit__no-client-icon">
          <FundingOpportunityV2Icon name="Target04" size={22} />
        </div>
        <h2>A pursuit pipeline belongs to one client</h2>
        <p>
          Choose a client to see the grants and contracts your team is pursuing. The pipeline keeps
          its records even when a search result falls below the suggestion floor.
        </p>
        <CapiroButton
          variant="primary"
          size="standard"
          disabled={!onChooseClient}
          onClick={() => onChooseClient?.({ clientId: null, clientName: null })}
        >
          Choose a client
        </CapiroButton>
      </section>
    );
  }
  if (query.isPending)
    return (
      <PursuitShell>
        <div className="fo-v2-pursuit__loading" aria-busy="true">
          Loading the pursuit pipeline…
        </div>
      </PursuitShell>
    );
  if (query.isError || !query.data) {
    return (
      <PursuitShell>
        <div className="fo-v2-pursuit__error" role="alert">
          <strong>The pursuit pipeline could not be loaded.</strong>
          <span>No rows are shown because the request failed.</span>
          <CapiroButton variant="primary" size="standard" onClick={() => void query.refetch()}>
            Retry
          </CapiroButton>
        </div>
      </PursuitShell>
    );
  }

  const board = query.data;
  return (
    <PursuitShell>
      <header className="fo-v2-pursuit__header">
        <h2>Pursuit pipeline</h2>
        <span className="fo-v2-pursuit__scope">{clientName ?? 'Selected client'}</span>
        <span className="fo-v2-pursuit__header-spacer" />
        <div className="fo-v2-pursuit__view-toggle" role="group" aria-label="Pursuit view">
          <button
            type="button"
            className={view === 'board' ? 'is-active' : ''}
            aria-pressed={view === 'board'}
            onClick={() => setPipelineView('board')}
          >
            Board
          </button>
          <button
            type="button"
            className={view === 'list' ? 'is-active' : ''}
            aria-pressed={view === 'list'}
            onClick={() => setPipelineView('list')}
          >
            List
          </button>
        </div>
      </header>
      <SummaryStrip summary={summary} />
      {view === 'board' ? (
        <Board
          board={board}
          clientId={clientId}
          onOpenTitle={onOpenTitle}
          onMove={requestMove}
          pending={mutation.isPending}
        />
      ) : (
        <List board={board} clientId={clientId} onOpenTitle={onOpenTitle} />
      )}
      <footer className="fo-v2-pursuit__footnotes">
        <p>
          A stage move records actor, timestamp, client, opportunity, old state and new state. Lost
          and Passed require a reason before the move commits.
        </p>
        <p>
          Terminal stages show a sentence instead of disabled controls — an absent handler removes
          the control rather than greying it out.
        </p>
        <p>
          Records stay in the pipeline even when their current relevance falls below the suggestion
          floor.
        </p>
        {board.cardsTruncated || board.hasMore ? (
          <p>
            Some cards are not shown in this window. Stage counts and summaries are complete only
            where the server supplied them; this view does not infer missing rows.
          </p>
        ) : null}
      </footer>
      <ReasonDialog
        target={reasonTarget}
        reason={reason}
        note={note}
        pending={mutation.isPending}
        triggerRef={reasonTriggerRef}
        onReason={setReason}
        onNote={setNote}
        onCancel={closeReasonDialog}
        onConfirm={() => {
          if (!reasonTarget || !reason.trim()) return;
          const combined = note.trim() ? `${reason.trim()} — ${note.trim()}` : reason.trim();
          mutation.mutate({ card: reasonTarget.card, to: reasonTarget.to, reasonText: combined });
        }}
      />
    </PursuitShell>
  );
}

function PursuitShell({ children }: { children: ReactNode }) {
  return (
    <section className="fo-v2-pursuit" data-testid="fo-pursuit">
      {children}
    </section>
  );
}

function SummaryStrip({ summary }: { summary: ReturnType<typeof boardSummary> | null }) {
  const facts = [
    ['In pipeline', summary?.inPipeline == null ? '?' : `${summary.inPipeline} records`, false],
    [
      'Deadlines inside 30 days',
      displayCount(summary?.deadlinesInside30Days),
      summary?.deadlinesInside30Days != null && summary.deadlinesInside30Days > 0,
    ],
    [
      'Unassigned',
      displayCount(summary?.unassigned),
      summary?.unassigned != null && summary.unassigned > 0,
    ],
    ['Awaiting award', displayCount(summary?.awaitingAward), false],
    ['Last stage change', summary ? lastStageChangeText(summary.lastStageChange) : '?', false],
  ] as const;
  return (
    <div className="fo-v2-pursuit__summary">
      {facts.map(([label, value, warning]) => (
        <div
          key={label}
          className={`fo-v2-pursuit__fact${warning ? ' fo-v2-pursuit__fact--warning' : ''}`}
        >
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function Board({
  board,
  clientId,
  onOpenTitle,
  onMove,
  pending,
}: {
  board: PipelineBoardView;
  clientId: string;
  onOpenTitle?: FundingOpportunityPipelineProps['onOpenTitle'];
  onMove: (card: PipelineCardView, to: PipelineStageView) => void;
  pending: boolean;
}) {
  return (
    <div className="fo-v2-pursuit__board" data-testid="fo-pursuit-board">
      {Object.keys(PIPELINE_STAGE_LABELS).map((stage) => {
        const typedStage = stage as PipelineStageView;
        const cards = stageCards(board, typedStage);
        const count = board.counts.stages.find((item) => item.stage === typedStage)?.count ?? 0;
        return (
          <section
            className="fo-v2-pursuit__column"
            key={typedStage}
            aria-label={`${PIPELINE_STAGE_LABELS[typedStage]}, ${count}`}
          >
            <header>
              <span
                className={`fo-v2-pursuit__stage-dot fo-v2-pursuit__stage-dot--${typedStage}`}
              />
              <h3>{PIPELINE_STAGE_LABELS[typedStage]}</h3>
              <span className="fo-v2-pursuit__column-count">{count}</span>
            </header>
            {cards.length === 0 ? (
              <p className="fo-v2-pursuit__empty-column">
                {count > 0 ? 'Cards are outside the returned window.' : 'Nothing at this stage.'}
              </p>
            ) : (
              cards.map((card) => (
                <PipelineCard
                  key={card.rowId}
                  card={card}
                  clientId={clientId}
                  onOpenTitle={onOpenTitle}
                  onMove={onMove}
                  pending={pending}
                />
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}

function PipelineCard({
  card,
  clientId,
  onOpenTitle,
  onMove,
  pending,
}: {
  card: PipelineCardView;
  clientId: string;
  onOpenTitle?: FundingOpportunityPipelineProps['onOpenTitle'];
  onMove: (card: PipelineCardView, to: PipelineStageView) => void;
  pending: boolean;
}) {
  const deadline = deadlineForCard(card);
  const title = card.title ?? 'Source record no longer in the catalog';
  const terminalSentence = card.stage ? TERMINAL_SENTENCES[card.stage] : '';
  return (
    <article className="fo-v2-pursuit__card" data-testid={`fo-pursuit-card-${card.rowId}`}>
      <div className="fo-v2-pursuit__pills">
        <span className={`fo-v2-pursuit__source fo-v2-pursuit__source--${sourceTone(card.source)}`}>
          {sourceLabel(card.source)}
        </span>
        {card.flag ? (
          <span className={`fo-v2-pursuit__flag fo-v2-pursuit__flag--${card.flag.tone}`}>
            {card.flag.label}
          </span>
        ) : null}
        {card.lifecycle === 'active' &&
        !['won', 'lost', 'passed'].includes(card.stage ?? '') &&
        card.capability?.canPursue === false &&
        !card.flag ? (
          <span className="fo-v2-pursuit__flag fo-v2-pursuit__flag--error">Eligibility gap</span>
        ) : null}
      </div>
      <button
        type="button"
        className="fo-v2-pursuit__title"
        disabled={!onOpenTitle}
        onClick={() =>
          onOpenTitle?.({
            rowId: card.rowId,
            title,
            source: card.source,
            sourceRecordId: card.sourceRecordId,
            sourceReference: card.sourceReference,
            clientId,
          })
        }
      >
        {title}
      </button>
      <span className="fo-v2-pursuit__ref">
        {card.sourceReference ?? 'Source reference not provided'}
      </span>
      <div className={`fo-v2-pursuit__deadline fo-v2-pursuit__deadline--${deadline.tone}`}>
        <span>{deadline.label}</span>
        <b>{deadline.value.replace(/, \d{4}$/, '')}</b>
        {deadline.daysRemaining != null ? (
          <em>{deadline.daysRemaining < 0 ? 'past' : `${deadline.daysRemaining}d`}</em>
        ) : null}
      </div>
      <div className={`fo-v2-pursuit__owner${card.owner ? '' : ' is-unassigned'}`}>
        {card.owner?.name ?? 'Unassigned'}
      </div>
      {terminalSentence ? (
        <p className="fo-v2-pursuit__terminal">{terminalSentence}</p>
      ) : card.nextAction ? (
        <div className="fo-v2-pursuit__next">
          {`${card.nextAction}${card.nextActionDueAt ? ` · due ${displayDate(card.nextActionDueAt)}` : ''}`}
        </div>
      ) : null}
      {!terminalSentence ? (
        <div className="fo-v2-pursuit__moves">
          {card.allowedTransitions.map((to) => (
            <button key={to} type="button" disabled={pending} onClick={() => onMove(card, to)}>
              → {PIPELINE_STAGE_LABELS[to]}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function List({
  board,
  clientId,
  onOpenTitle,
}: {
  board: PipelineBoardView;
  clientId: string;
  onOpenTitle?: FundingOpportunityPipelineProps['onOpenTitle'];
}) {
  return (
    <div className="fo-v2-pursuit__list-wrap">
      <div className="fo-v2-pursuit__list" role="table" aria-label="Pursuit list">
        <div className="fo-v2-pursuit__list-row fo-v2-pursuit__list-head" role="row">
          <span>Opportunity</span>
          <span>Stage</span>
          <span>Key date</span>
          <span>Owner and basis</span>
        </div>
        {board.cards
          .filter((card) => card.stage != null)
          .map((card) => (
            <div className="fo-v2-pursuit__list-row" role="row" key={card.rowId}>
              <span>
                <button
                  type="button"
                  className="fo-v2-pursuit__list-title"
                  disabled={!onOpenTitle}
                  onClick={() =>
                    onOpenTitle?.({
                      rowId: card.rowId,
                      title: card.title ?? 'Source record no longer in the catalog',
                      source: card.source,
                      sourceRecordId: card.sourceRecordId,
                      sourceReference: card.sourceReference,
                      clientId,
                    })
                  }
                >
                  {card.title ?? 'Source record no longer in the catalog'}
                </button>
                <small className="fo-v2-pursuit__list-reference">
                  {card.sourceReference ?? 'Source reference not provided'}
                </small>
              </span>
              <span>
                <b
                  className={`fo-v2-pursuit__stage-pill fo-v2-pursuit__stage-pill--${card.stage ?? 'reviewing'}`}
                >
                  {card.stage ? PIPELINE_STAGE_LABELS[card.stage] : 'Not staged'}
                </b>
              </span>
              <span
                className={`fo-v2-pursuit__list-date fo-v2-pursuit__list-date--${deadlineForCard(card).tone}`}
              >
                {deadlineForCard(card).label} {deadlineForCard(card).value.replace(/, \d{4}$/, '')}
              </span>
              <span>
                <b className={card.owner ? '' : 'is-unassigned'}>
                  {card.owner?.name ?? 'Unassigned'}
                </b>
                <small className="fo-v2-pursuit__list-basis">{listBasis(card)}</small>
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

function ReasonDialog({
  target,
  reason,
  note,
  pending,
  triggerRef,
  onReason,
  onNote,
  onCancel,
  onConfirm,
}: {
  target: { card: PipelineCardView; to: PipelineStageView } | null;
  reason: string;
  note: string;
  pending: boolean;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  onReason: (value: string) => void;
  onNote: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target) return;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        dialog?.querySelector<HTMLElement>('input, textarea, button')?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocus);
      triggerRef.current?.focus();
      triggerRef.current = null;
    };
  }, [onCancel, target, triggerRef]);
  if (!target) return null;
  const title = target.card.title ?? 'this record';
  return (
    <div className="fo-v2-pursuit__dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="fo-v2-pursuit__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fo-pursuit-reason-title"
      >
        <header>
          <div>
            <span>WORKFLOW</span>
            <h2 id="fo-pursuit-reason-title">Not a fit — record a reason</h2>
            <p>A reason is required. {title}</p>
          </div>
          <button type="button" aria-label="Close reason dialog" onClick={onCancel}>
            <FundingOpportunityV2Icon name="XClose" size={20} />
          </button>
        </header>
        <div className="fo-v2-pursuit__dialog-body">
          <fieldset>
            <legend>Reason — required</legend>
            {PURSUIT_REASONS.map((option) => (
              <label key={option.label}>
                <input
                  type="radio"
                  name="pursuit-reason"
                  checked={reason === option.label}
                  onChange={() => onReason(option.label)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="fo-v2-pursuit__note">
            Note — optional
            <textarea
              value={note}
              onChange={(event) => onNote(event.target.value)}
              placeholder="Anything the next operator needs to know."
            />
          </label>
        </div>
        <footer>
          <span>
            Actor, timestamp, client, old state and new state are recorded with the reason.
          </span>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <CapiroButton
            variant="primary"
            size="standard"
            disabled={!reason.trim() || pending}
            loading={pending}
            onClick={onConfirm}
          >
            Record the decision
          </CapiroButton>
        </footer>
      </div>
    </div>
  );
}

function apiErrorMessage(error: unknown): string | null {
  const message = (error as { response?: { data?: { message?: unknown } } }).response?.data
    ?.message;
  if (typeof message === 'string' && message.trim()) return message;
  return Array.isArray(message) && typeof message[0] === 'string' ? message.join(' ') : null;
}
