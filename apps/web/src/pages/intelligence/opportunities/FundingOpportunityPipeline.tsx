import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Input,
  Modal,
  Segmented,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
  PIPELINE_STAGES,
  PIPELINE_STAGES_NEEDING_REASON,
  PIPELINE_STAGE_LABELS,
  pipelineBoardApiPath,
  pipelineStageApiPath,
  type PipelineBoardView,
  type PipelineCardView,
  type PipelineStageView,
} from './funding-opportunities-api.js';

const { Paragraph, Text } = Typography;

/**
 * The pursuit pipeline board (P35).
 *
 * ── The flag being off changes NOTHING ───────────────────────────────────────
 *
 * This component renders null when the flag is off and issues no request. The
 * existing Saved/Pursuing tabs are untouched, because `workflow_status` is still
 * the column both code paths write — the pipeline adds a view, it does not
 * replace the data.
 *
 * ── No drag commits without the server ───────────────────────────────────────
 *
 * A drag or a keypress is a REQUEST. The card shows a pending state and the
 * board only re-renders in the new column once the POST returns; a rejected move
 * leaves the card exactly where it was and says why. There is no optimistic
 * local reorder, deliberately: an optimistic Kanban that reverts is how a user
 * comes to believe a stage moved when the server refused it.
 *
 * `allowedTransitions` comes from the server per card, so the board never offers
 * a move the server would refuse. That is a courtesy, not the gate — the gate is
 * the POST.
 *
 * ── Keyboard first, drag second ──────────────────────────────────────────────
 *
 * Every move is an ordinary focusable BUTTON, one per allowed target, so tab and
 * enter are the primary route rather than a fallback. Drag-and-drop is layered on
 * top of controls that already work without a pointer — the other way round is
 * how a board ends up unusable with a keyboard.
 *
 * ── The counts are not the cards ─────────────────────────────────────────────
 *
 * Column counts come from a server-side aggregate over EVERY workflow row this
 * client has. The cards are a bounded window. When the window is smaller than the
 * count, the column says so rather than silently showing four cards under a
 * heading that reads 900.
 *
 * ── Unstaged rows are shown as unstaged ──────────────────────────────────────
 *
 * A machine suggestion nobody has opened is not "reviewing", and a row that
 * expired before this feature existed has no recorded stage. Both are reported
 * outside the columns, with their own sentences.
 */
export function FundingOpportunityPipeline({ clientId }: { clientId: string | null }) {
  const api = useApi();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [pending, setPending] = useState<{ card: PipelineCardView; to: PipelineStageView } | null>(
    null,
  );
  const [reason, setReason] = useState('');

  const enabled = flag.ready && flag.enabled && clientId != null;

  const query = useQuery<PipelineBoardView>({
    queryKey: ['funding-opportunity-pipeline', clientId],
    queryFn: async () =>
      (await api.get<PipelineBoardView>(pipelineBoardApiPath(clientId!))).data,
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
        // The token the board was rendered with. If somebody else moved this row
        // in the meantime the server rejects rather than overwriting them.
        expectedVersion: input.card.version,
        reason: input.reason,
      });
    },
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-pipeline'] });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
      notification.success({
        message: `Moved to ${PIPELINE_STAGE_LABELS[input.to]}`,
        description: 'Recorded with your name and the time.',
      });
    },
    onError: (error: unknown, input) => {
      const conflict = (error as { response?: { status?: number } })?.response?.status === 409;
      notification.error({
        message: conflict ? 'Somebody else moved this first' : 'Not moved',
        description: `${serverMessage(error) ?? 'The request failed.'} It is still at ${
          input.card.stage ? PIPELINE_STAGE_LABELS[input.card.stage] : 'no stage'
        }.`,
      });
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

  if (query.isPending) return <Skeleton active paragraph={{ rows: 5 }} />;
  if (query.isError) {
    return (
      <Alert
        type="error"
        showIcon
        data-testid="fo-pipeline-error"
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
      className="fo-pipeline__card"
      data-testid={`fo-pipeline-card-${card.rowId}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', card.rowId)}
    >
      <Text style={{ fontSize: 12 }}>{card.title ?? card.sourceRecordId ?? card.rowId}</Text>
      {card.stageBasis !== 'recorded' ? (
        <Tooltip title={card.stageExplanation}>
          <Tag data-testid={`fo-pipeline-derived-${card.rowId}`}>Derived</Tag>
        </Tooltip>
      ) : null}
      <Space size={4} wrap style={{ marginTop: 4 }}>
        {card.allowedTransitions.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 11 }}>
            Nothing moves out of {card.stage ? PIPELINE_STAGE_LABELS[card.stage] : 'here'}.
          </Text>
        ) : (
          card.allowedTransitions.map((to) => (
            <Button
              key={to}
              size="small"
              // An ordinary button: tab-reachable and enter-activated with no
              // pointer, which is what makes the board usable from a keyboard.
              onClick={() => requestMove(card, to)}
              loading={move.isPending && move.variables?.card.rowId === card.rowId}
              data-testid={`fo-pipeline-move-${card.rowId}-${to}`}
              aria-label={`Move to ${PIPELINE_STAGE_LABELS[to]}`}
            >
              → {PIPELINE_STAGE_LABELS[to]}
            </Button>
          ))
        )}
      </Space>
    </div>
  );

  return (
    <Card
      size="small"
      title="Pursuit pipeline"
      className="fo-detail__section"
      data-testid="fo-pipeline"
      extra={
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as 'board' | 'list')}
          options={[
            { label: 'Board', value: 'board' },
            { label: 'List', value: 'list' },
          ]}
        />
      }
    >
      {view === 'board' ? (
        <div className="fo-pipeline__columns" data-testid="fo-pipeline-board">
          {PIPELINE_STAGES.map((stage) => {
            const cards = byStage(stage);
            const count = countFor(stage);
            return (
              <section
                key={stage}
                className="fo-pipeline__column"
                data-testid={`fo-pipeline-column-${stage}`}
                aria-label={`${PIPELINE_STAGE_LABELS[stage]}, ${count} opportunities`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const rowId = e.dataTransfer.getData('text/plain');
                  const card = board.cards.find((c) => c.rowId === rowId);
                  // Refused locally when the SERVER did not list this move. The
                  // POST is still the gate; this only avoids a request that is
                  // certain to fail.
                  if (card && card.allowedTransitions.includes(stage)) requestMove(card, stage);
                }}
              >
                <header>
                  <Text strong style={{ fontSize: 12 }}>
                    {PIPELINE_STAGE_LABELS[stage]}
                  </Text>{' '}
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    ({count})
                  </Text>
                </header>
                {cards.map(cardBody)}
                {cards.length < count ? (
                  <Text
                    type="secondary"
                    style={{ fontSize: 11 }}
                    data-testid={`fo-pipeline-more-${stage}`}
                  >
                    {count - cards.length} more not shown.
                  </Text>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <Table
          size="small"
          rowKey="rowId"
          data-testid="fo-pipeline-list"
          pagination={false}
          dataSource={board.cards}
          columns={[
            {
              title: 'Opportunity',
              dataIndex: 'title',
              render: (_v, card: PipelineCardView) =>
                card.title ?? card.sourceRecordId ?? card.rowId,
            },
            {
              title: 'Stage',
              dataIndex: 'stage',
              render: (_v, card: PipelineCardView) =>
                card.stage ? (
                  <Tooltip title={card.stageExplanation}>
                    <Tag>{PIPELINE_STAGE_LABELS[card.stage]}</Tag>
                  </Tooltip>
                ) : (
                  <Tooltip title={card.stageExplanation}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Not in the pipeline
                    </Text>
                  </Tooltip>
                ),
            },
            {
              title: 'Move',
              render: (_v, card: PipelineCardView) => (
                <Space size={4} wrap>
                  {card.allowedTransitions.map((to) => (
                    <Button
                      key={to}
                      size="small"
                      onClick={() => requestMove(card, to)}
                      data-testid={`fo-pipeline-list-move-${card.rowId}-${to}`}
                    >
                      {PIPELINE_STAGE_LABELS[to]}
                    </Button>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      )}

      <div style={{ marginTop: 8 }} data-testid="fo-pipeline-footnotes">
        {board.counts.unstaged.suggested > 0 ? (
          <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 2 }}>
            {board.counts.unstaged.suggested} suggested opportunit
            {board.counts.unstaged.suggested === 1 ? 'y is' : 'ies are'} not in the pipeline. A
            machine suggestion nobody has opened is not a stage somebody is working.
          </Paragraph>
        ) : null}
        {board.counts.unstaged.expired > 0 ? (
          <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 2 }}>
            {board.counts.unstaged.expired} closed before this pipeline existed. Which stage they
            were in is not recorded, and it is not guessed.
          </Paragraph>
        ) : null}
        {board.counts.derivedFromWorkflowStatus > 0 ? (
          <Paragraph
            type="secondary"
            style={{ fontSize: 11, marginBottom: 0 }}
            data-testid="fo-pipeline-derived-note"
          >
            {board.counts.derivedFromWorkflowStatus} of {board.counts.total} placed from the older
            Saved/Pursuing status rather than a recorded stage. Moving one records it properly.
          </Paragraph>
        ) : null}
      </div>

      <Modal
        open={pending != null}
        title={pending ? `Move to ${PIPELINE_STAGE_LABELS[pending.to]}` : ''}
        okText="Record the move"
        okButtonProps={{ disabled: reason.trim() === '' }}
        onCancel={() => setPending(null)}
        onOk={() => {
          if (pending == null) return;
          move.mutate({ card: pending.card, to: pending.to, reason: reason.trim() });
          setPending(null);
        }}
        data-testid="fo-pipeline-reason-modal"
      >
        <Paragraph style={{ fontSize: 12 }}>
          {/* The server requires this and so does a CHECK on the audit row. A
              recorded outcome nobody explained is one nobody can learn from. */}
          Say why. This is recorded against your name and cannot be left blank for{' '}
          {PIPELINE_STAGES_NEEDING_REASON.map((s) => PIPELINE_STAGE_LABELS[s]).join(', ')}.
        </Paragraph>
        <Input.TextArea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Reason for this stage move"
          data-testid="fo-pipeline-reason-input"
        />
      </Modal>
    </Card>
  );
}

/** The API's own refusal sentence, when the error carries one. */
function serverMessage(error: unknown): string | null {
  const body = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (Array.isArray(body) && typeof body[0] === 'string') return body.join(' ');
  return null;
}
