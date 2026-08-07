import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  List,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  ACTION_CATEGORY_LABELS,
  FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE,
  LANDSCAPE_SOURCE_LABELS,
  PLAN_STAGE_LABELS,
  actionPlanApiPath,
  isActionRecorded,
  opportunityActionApiPath,
  type ActionPlanResultView,
  type ProposedActionView,
} from './funding-opportunities-api.js';

const { Paragraph, Text } = Typography;

/** The API's own refusal sentence, when the error carries one. */
function serverMessage(error: unknown): string | null {
  const body = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (Array.isArray(body) && typeof body[0] === 'string') return body.join(' ');
  return null;
}

/**
 * The deterministic action plan (P34).
 *
 * ── Proposed and recorded look different, because they are different ─────────
 *
 * Every action arrives as a PROPOSAL. Nothing on this panel has happened until
 * somebody presses Accept, and pressing Accept posts to P08's existing
 * idempotent server action — the one path that creates a task and records the
 * decision in a single transaction. This panel has no write path of its own.
 *
 * An action is labelled RECORDED rather than "committed" when the workflow
 * already carries that decision. The distinction is deliberate: a `saved` row
 * may have been saved by hand, and telling a user "you committed this from the
 * plan" when they did not is a claim they cannot check.
 *
 * ── Accepting twice does not create two tasks, and the panel says so ─────────
 *
 * P08 keys its task on `<source>:<id>:<intent>`, so two `review` actions accepted
 * from this plan land on ONE task. That is P08's idempotency working, not a bug,
 * and the panel states it up front rather than letting a user discover it by
 * finding one task where they expected three.
 *
 * ── A proposal with an unmet prerequisite says so before it is accepted ──────
 *
 * "Build the compliance matrix" with no requirements extracted is a task
 * somebody will pick up and stall on. The prerequisite is shown on the proposal,
 * not discovered afterwards.
 *
 * ── Where there is no target, nothing is invented ────────────────────────────
 *
 * A target appears only when the server derived it from a source-backed
 * landscape item. Most actions have none, and the panel shows none — there is no
 * "reach out to your contact" placeholder, because Capiro has no reviewed
 * relationship data joined to an opportunity and a suggested introduction it
 * cannot support is worse than no suggestion.
 */
export function OpportunityActionPlan({
  clientId,
  source,
  sourceRecordId,
  workflowStatus,
}: {
  clientId: string | null;
  source: string;
  sourceRecordId: string;
  /** The opportunity's current workflow status, or null when unscored. */
  workflowStatus?: string | null;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE);
  const supported = source === 'sam_gov' || source === 'agency_forecast';
  const enabled = flag.ready && flag.enabled && clientId != null && supported;

  const query = useQuery<ActionPlanResultView>({
    queryKey: ['funding-opportunity-action-plan', source, sourceRecordId, clientId],
    queryFn: async () =>
      (await api.get<ActionPlanResultView>(actionPlanApiPath(source, sourceRecordId, clientId!)))
        .data,
    retry: false,
    enabled,
  });

  const accept = useMutation({
    mutationFn: async (action: ProposedActionView) => {
      if (action.intent === 'none') throw new Error('This action creates nothing.');
      await api.post(opportunityActionApiPath(clientId!, source, sourceRecordId), {
        intent: action.intent,
        // The proposal's own words travel with the task, so the task says what
        // it is for rather than only which opportunity it came from.
        nextAction: action.title,
        notes: action.rationale,
      });
    },
    onSuccess: () => {
      // Both the plan and the opportunity row: accepting changes the workflow
      // status, which is what flips a proposal to "recorded".
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-action-plan'] });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity'] });
      void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
      notification.success({
        message: 'Recorded',
        description: 'The matching task was created or reused, and the decision was saved with it.',
      });
    },
    onError: (error: unknown) => {
      // The server's own refusal, when it gave one. A generic "something went
      // wrong" would hide the useful half — the pursuit guard explains exactly
      // why a closed notice cannot be pursued, and that sentence belongs here.
      notification.error({
        message: 'Not recorded',
        description: `${serverMessage(error) ?? 'The request failed.'} Nothing was created.`,
      });
    },
  });

  const body = () => {
    if (!supported) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-plan-unsupported">
          An action plan is composed for SAM.gov contract opportunities and agency forecasts.
        </Text>
      );
    }
    if (clientId == null) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-plan-unscored">
          Not composed without a client. What to do next depends on the client, not on the notice.
        </Text>
      );
    }
    if (!flag.ready) return <Skeleton active paragraph={{ rows: 3 }} />;
    if (!flag.enabled) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-plan-not-enabled">
          Action plans are not enabled for this workspace. This says nothing about what should be
          done on this opportunity.
        </Text>
      );
    }
    if (query.isPending) return <Skeleton active paragraph={{ rows: 4 }} />;
    if (query.isError) {
      return (
        <Alert
          type="error"
          showIcon
          data-testid="fo-plan-error"
          message="The action plan failed to load"
          description="This is a request failure, not an absence of work to do. Nothing follows from it about this opportunity."
        />
      );
    }

    const result = query.data;
    if (result.plan == null) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="fo-plan-no-plan">
          {result.explanation}
        </Text>
      );
    }

    const plan = result.plan;
    return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={6} wrap>
          <Tag color="blue">{PLAN_STAGE_LABELS[plan.stage] ?? plan.stage}</Tag>
          <Text type="secondary" style={{ fontSize: 11 }} data-testid="fo-plan-proposal-note">
            Proposals only. Nothing here is recorded until you accept it.
          </Text>
        </Space>

        <List
          size="small"
          dataSource={plan.actions}
          rowKey={(action) => action.id}
          renderItem={(action) => {
            const recorded = isActionRecorded(action.intent, workflowStatus);
            return (
              <List.Item data-testid={`fo-plan-action-${action.id}`} style={{ paddingLeft: 0 }}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={6} wrap>
                    <Tag>{ACTION_CATEGORY_LABELS[action.category] ?? action.category}</Tag>
                    {recorded ? (
                      <Tooltip title="This workspace’s workflow already carries this decision. It may have been recorded here or elsewhere.">
                        <Tag color="green" data-testid={`fo-plan-recorded-${action.id}`}>
                          Recorded
                        </Tag>
                      </Tooltip>
                    ) : (
                      <Tag data-testid={`fo-plan-proposed-${action.id}`}>Proposed</Tag>
                    )}
                    <Text strong style={{ fontSize: 13 }}>
                      {action.title}
                    </Text>
                  </Space>

                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {action.rationale}
                  </Text>

                  {action.suggestedTarget ? (
                    <Text style={{ fontSize: 12 }} data-testid={`fo-plan-target-${action.id}`}>
                      Target: {action.suggestedTarget}
                    </Text>
                  ) : null}

                  {action.dueDateBasis ? (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {/* The basis, never a bare date: a date with no stated
                          derivation is one somebody moves without knowing what
                          it was protecting. */}
                      Suggested by {new Date(action.dueDate!).toLocaleDateString()} —{' '}
                      {action.dueDateBasis}.
                    </Text>
                  ) : null}

                  {action.evidence.length > 0 ? (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Evidence:{' '}
                      {action.evidence
                        .map(
                          (e) =>
                            `${LANDSCAPE_SOURCE_LABELS[e.source] ?? e.source} — ${e.matchedOn}`,
                        )
                        .join('; ')}
                      .
                    </Text>
                  ) : null}

                  {action.unresolvedPrerequisites.length > 0 ? (
                    <Text
                      type="warning"
                      style={{ fontSize: 11 }}
                      data-testid={`fo-plan-blocked-${action.id}`}
                    >
                      Needs first: {action.unresolvedPrerequisites.join(' ')}
                    </Text>
                  ) : null}

                  {action.intent === 'none' ? (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      Nothing to create — this is a note, not a task.
                    </Text>
                  ) : result.acceptance.wired ? (
                    <Button
                      size="small"
                      type={recorded ? 'default' : 'primary'}
                      disabled={recorded}
                      loading={accept.isPending && accept.variables?.id === action.id}
                      onClick={() => accept.mutate(action)}
                      data-testid={`fo-plan-accept-${action.id}`}
                    >
                      {recorded ? 'Already recorded' : 'Accept'}
                    </Button>
                  ) : null}
                </Space>
              </List.Item>
            );
          }}
        />

        {!result.acceptance.wired ? (
          <Paragraph
            type="secondary"
            style={{ fontSize: 11, marginBottom: 0 }}
            data-testid="fo-plan-acceptance-unwired"
          >
            {result.acceptance.explanation}
          </Paragraph>
        ) : (
          <Text type="secondary" style={{ fontSize: 11 }} data-testid="fo-plan-idempotency-note">
            Accepting a second action of the same kind updates the existing task rather than
            opening another one.
          </Text>
        )}
      </Space>
    );
  };

  return (
    <Card
      size="small"
      title="Action plan"
      className="fo-detail__section"
      data-testid="fo-detail-action-plan"
    >
      {body()}
    </Card>
  );
}
