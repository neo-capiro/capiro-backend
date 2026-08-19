import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
  PIPELINE_STAGES,
  PIPELINE_STAGES_NEEDING_REASON,
  PIPELINE_STAGE_LABELS,
  PURSUIT_OUTCOME_KINDS,
  pipelineBoardApiPath,
  pipelineStageApiPath,
  type PipelineBoardView,
  type PipelineCardView,
  type PipelineStageView,
  type PursuitOutcomeKindView,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { OpportunityOutcomeModal } from './OpportunityOutcomeModal.js';
import { FovAlert, FovCard, FovModal, FovPill, FovSegmented, FovSkeletonRows } from './fov-ui.js';

function isPursuitOutcomeKind(value: PipelineStageView): value is PursuitOutcomeKindView {
  return (PURSUIT_OUTCOME_KINDS as readonly string[]).includes(value);
}

/**
 * The pursuit pipeline board (P35) — vNext port of the canonical
 * FundingOpportunityPipeline.
 *
 * Unchanged rules: the flag being off changes NOTHING (renders null, issues no
 * request); no drag commits without the server (no optimistic reorder, a 409
 * refetches); keyboard first, drag second (every move is an ordinary focusable
 * button); the counts are not the cards; unstaged rows are shown as unstaged.
 */
export function FundingOpportunityPipeline({ clientId }: { clientId: string | null }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [pending, setPending] = useState<{ card: PipelineCardView; to: PipelineStageView } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  // Opened automatically once a move to won/lost/passed COMMITS — P36 is what
  // happens after that transition, never a gate on it.
  const [outcomeFor, setOutcomeFor] = useState<{
    clientId: string;
    source: string;
    sourceRecordId: string;
    kind: PursuitOutcomeKindView;
  } | null>(null);

  const enabled = flag.ready && flag.enabled && clientId != null;

  const query = useQuery<PipelineBoardView>({
    queryKey: ['funding-opportunity-pipeline', clientId],
    queryFn: async () => (await api.get<PipelineBoardView>(pipelineBoardApiPath(clientId!))).data,
    retry: false,
    enabled,
  });

  const move = useMutation({
    mutationFn: async (input: {
      card: PipelineCardView;
      to: PipelineStageView;
      reason: string | null;
    }) => {
      await api.post(pipelineStageApiPath(clientId!, input.card.rowId), {
        toStage: input.to,
        // The token the board was rendered with. If somebody else moved this
        // row in the meantime the server rejects rather than overwriting them.
        expectedVersion: input.card.version,
        reason: input.reason,
      });
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-pipeline'] });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
      toast.success(
        `Moved to ${PIPELINE_STAGE_LABELS[input.to]} — recorded with your name and the time.`,
      );
      // Offer outcome capture right after the move commits — never before,
      // and never as a condition of the move succeeding.
      if (isPursuitOutcomeKind(input.to) && input.card.sourceRecordId) {
        setOutcomeFor({
          clientId: clientId!,
          source: input.card.source,
          sourceRecordId: input.card.sourceRecordId,
          kind: input.to,
        });
      }
    },
    onError: (error: unknown, input) => {
      const conflict = (error as { response?: { status?: number } })?.response?.status === 409;
      toast.error(
        `${conflict ? 'Somebody else moved this first' : 'Not moved'} — ${
          serverMessage(error) ?? 'The request failed.'
        } It is still at ${input.card.stage ? PIPELINE_STAGE_LABELS[input.card.stage] : 'no stage'}.`,
      );
      // A conflict means the board is out of date, so refetch even on failure —
      // otherwise the next attempt sends the same stale version and fails again.
      if (conflict) void qc.invalidateQueries({ queryKey: ['funding-opportunity-pipeline'] });
    },
  });

  /** A move either needs a reason first, or goes straight to the server. */
  const requestMove = (card: PipelineCardView, to: PipelineStageView) => {
    if (PIPELINE_STAGES_NEEDING_REASON.includes(to)) {
      setReason('');
      setPending({ card, to });
      return;
    }
    move.mutate({ card, to, reason: null });
  };

  if (!flag.ready || !flag.enabled || clientId == null) {
    // Renders NOTHING. The existing tabs keep working, unchanged.
    return null;
  }

  if (query.isPending) return <FovSkeletonRows rows={5} />;
  if (query.isError) {
    return (
      <FovAlert
        tone="error"
        testId="fo-pipeline-error"
        message="The pipeline failed to load"
        description="This is a request failure, not an empty pipeline. Nothing follows from it about what this client is pursuing."
      />
    );
  }

  const board = query.data;
  const byStage = (stage: PipelineStageView) => board.cards.filter((c) => c.stage === stage);
  const countFor = (stage: PipelineStageView) =>
    board.counts.stages.find((s) => s.stage === stage)?.count ?? 0;

  const cardBody = (card: PipelineCardView) => (
    <div
      key={card.rowId}
      className="fov-pipeline__card"
      data-testid={`fo-pipeline-card-${card.rowId}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', card.rowId)}
    >
      <span style={{ fontSize: 12 }}>{card.title ?? card.sourceRecordId ?? card.rowId}</span>{' '}
      {card.stageBasis !== 'recorded' ? (
        <FovPill title={card.stageExplanation} testId={`fo-pipeline-derived-${card.rowId}`}>
          Derived
        </FovPill>
      ) : null}
      <div className="fov-row" style={{ marginTop: 4, gap: 4 }}>
        {card.allowedTransitions.length === 0 ? (
          <span className="fov-micro">
            Nothing moves out of {card.stage ? PIPELINE_STAGE_LABELS[card.stage] : 'here'}.
          </span>
        ) : (
          card.allowedTransitions.map((to) => (
            <CapiroButton
              key={to}
              size="compact"
              // An ordinary button: tab-reachable and enter-activated with no
              // pointer, which is what makes the board usable from a keyboard.
              onClick={() => requestMove(card, to)}
              loading={move.isPending && move.variables?.card.rowId === card.rowId}
              data-testid={`fo-pipeline-move-${card.rowId}-${to}`}
              aria-label={`Move to ${PIPELINE_STAGE_LABELS[to]}`}
            >
              → {PIPELINE_STAGE_LABELS[to]}
            </CapiroButton>
          ))
        )}
      </div>
    </div>
  );

  return (
    <FovCard
      title="Pursuit pipeline"
      testId="fo-pipeline"
      extra={
        <FovSegmented<'board' | 'list'>
          value={view}
          onChange={setView}
          ariaLabel="Pipeline view"
          options={[
            { value: 'board', label: 'Board' },
            { value: 'list', label: 'List' },
          ]}
        />
      }
    >
      {view === 'board' ? (
        <div className="fov-pipeline__columns" data-testid="fo-pipeline-board">
          {PIPELINE_STAGES.map((stage) => {
            const cards = byStage(stage);
            const count = countFor(stage);
            return (
              <section
                key={stage}
                className="fov-pipeline__column"
                data-testid={`fo-pipeline-column-${stage}`}
                aria-label={`${PIPELINE_STAGE_LABELS[stage]}, ${count} opportunities`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const rowId = e.dataTransfer.getData('text/plain');
                  const card = board.cards.find((c) => c.rowId === rowId);
                  // Refused locally when the SERVER did not list this move.
                  // The POST is still the gate; this only avoids a request
                  // that is certain to fail.
                  if (card && card.allowedTransitions.includes(stage)) requestMove(card, stage);
                }}
              >
                <header>
                  <span>{PIPELINE_STAGE_LABELS[stage]}</span>{' '}
                  <span className="fov-micro">({count})</span>
                </header>
                {cards.map(cardBody)}
                {cards.length < count ? (
                  <span className="fov-micro" data-testid={`fo-pipeline-more-${stage}`}>
                    {count - cards.length} more not shown.
                  </span>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <CapiroTableWrap data-testid="fo-pipeline-list">
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell>Opportunity</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Stage</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Move</CapiroTableHeaderCell>
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {board.cards.map((card) => (
                <tr key={card.rowId}>
                  <CapiroTableCell>
                    {card.title ?? card.sourceRecordId ?? card.rowId}
                  </CapiroTableCell>
                  <CapiroTableCell>
                    {card.stage ? (
                      <FovPill title={card.stageExplanation}>
                        {PIPELINE_STAGE_LABELS[card.stage]}
                      </FovPill>
                    ) : (
                      <span className="fov-muted" title={card.stageExplanation}>
                        Not in the pipeline
                      </span>
                    )}
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <span className="fov-row" style={{ gap: 4 }}>
                      {card.allowedTransitions.map((to) => (
                        <CapiroButton
                          key={to}
                          size="compact"
                          onClick={() => requestMove(card, to)}
                          data-testid={`fo-pipeline-list-move-${card.rowId}-${to}`}
                        >
                          {PIPELINE_STAGE_LABELS[to]}
                        </CapiroButton>
                      ))}
                    </span>
                  </CapiroTableCell>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      )}

      <div style={{ marginTop: 8 }} data-testid="fo-pipeline-footnotes">
        {board.counts.unstaged.suggested > 0 ? (
          <p className="fov-micro" style={{ margin: '0 0 2px' }}>
            {board.counts.unstaged.suggested} suggested opportunit
            {board.counts.unstaged.suggested === 1 ? 'y is' : 'ies are'} not in the pipeline. A
            machine suggestion nobody has opened is not a stage somebody is working.
          </p>
        ) : null}
        {board.counts.unstaged.expired > 0 ? (
          <p className="fov-micro" style={{ margin: '0 0 2px' }}>
            {board.counts.unstaged.expired} closed before this pipeline existed. Which stage they
            were in is not recorded, and it is not guessed.
          </p>
        ) : null}
        {board.counts.derivedFromWorkflowStatus > 0 ? (
          <p className="fov-micro" style={{ margin: 0 }} data-testid="fo-pipeline-derived-note">
            {board.counts.derivedFromWorkflowStatus} of {board.counts.total} placed from the older
            Saved/Pursuing status rather than a recorded stage. Moving one records it properly.
          </p>
        ) : null}
      </div>

      <FovModal
        open={pending != null}
        title={pending ? `Move to ${PIPELINE_STAGE_LABELS[pending.to]}` : ''}
        okText="Record the move"
        okDisabled={reason.trim() === ''}
        onCancel={() => setPending(null)}
        onOk={() => {
          if (pending == null) return;
          move.mutate({ card: pending.card, to: pending.to, reason: reason.trim() });
          setPending(null);
        }}
        testId="fo-pipeline-reason-modal"
      >
        <p style={{ fontSize: 12, marginTop: 0 }}>
          {/* The server requires this and so does a CHECK on the audit row. A
              recorded outcome nobody explained is one nobody can learn from. */}
          Say why. This is recorded against your name and cannot be left blank for{' '}
          {PIPELINE_STAGES_NEEDING_REASON.map((s) => PIPELINE_STAGE_LABELS[s]).join(', ')}.
        </p>
        <textarea
          className="capiro-input"
          rows={3}
          style={{ width: '100%', resize: 'vertical' }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason for this stage move"
          data-testid="fo-pipeline-reason-input"
        />
      </FovModal>

      {outcomeFor ? (
        <OpportunityOutcomeModal
          open={outcomeFor != null}
          onClose={() => setOutcomeFor(null)}
          clientId={outcomeFor.clientId}
          source={outcomeFor.source}
          sourceRecordId={outcomeFor.sourceRecordId}
          kind={outcomeFor.kind}
        />
      ) : null}
    </FovCard>
  );
}

/** The API's own refusal sentence, when the error carries one. */
function serverMessage(error: unknown): string | null {
  const body = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (Array.isArray(body) && typeof body[0] === 'string') return body.join(' ');
  return null;
}
