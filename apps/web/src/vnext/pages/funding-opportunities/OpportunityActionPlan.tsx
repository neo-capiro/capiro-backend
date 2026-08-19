import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
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
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill, FovSkeletonRows } from './fov-ui.js';

/** The API's own refusal sentence, when the error carries one. */
function serverMessage(error: unknown): string | null {
  const body = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (Array.isArray(body) && typeof body[0] === 'string') return body.join(' ');
  return null;
}

/**
 * The deterministic action plan (P34) — vNext port of the canonical panel.
 *
 * Unchanged rules: proposed and recorded look different; Accept posts to
 * P08's idempotent server action (this panel has no write path of its own);
 * accepting twice does not create two tasks and the panel says so; an unmet
 * prerequisite is shown on the proposal; where there is no target, nothing is
 * invented.
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
  const toast = useCapiroToast();
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
      toast.success(
        'Recorded — the matching task was created or reused, and the decision was saved with it.',
      );
    },
    onError: (error: unknown) => {
      // The server's own refusal, when it gave one — the pursuit guard explains
      // exactly why a closed notice cannot be pursued, and that sentence
      // belongs here.
      toast.error(`Not recorded — ${serverMessage(error) ?? 'The request failed.'} Nothing was created.`);
    },
  });

  const body = (): ReactNode => {
    if (!supported) {
      return (
        <span className="fov-muted" data-testid="fo-plan-unsupported">
          An action plan is composed for SAM.gov contract opportunities and agency forecasts.
        </span>
      );
    }
    if (clientId == null) {
      return (
        <span className="fov-muted" data-testid="fo-plan-unscored">
          Not composed without a client. What to do next depends on the client, not on the notice.
        </span>
      );
    }
    if (!flag.ready) return <FovSkeletonRows rows={3} />;
    if (!flag.enabled) {
      return (
        <span className="fov-muted" data-testid="fo-plan-not-enabled">
          Action plans are not enabled for this workspace. This says nothing about what should be
          done on this opportunity.
        </span>
      );
    }
    if (query.isPending) return <FovSkeletonRows rows={4} />;
    if (query.isError) {
      return (
        <FovAlert
          tone="error"
          testId="fo-plan-error"
          message="The action plan failed to load"
          description="This is a request failure, not an absence of work to do. Nothing follows from it about this opportunity."
        />
      );
    }

    const result = query.data;
    if (result.plan == null) {
      return (
        <span className="fov-muted" data-testid="fo-plan-no-plan">
          {result.explanation}
        </span>
      );
    }

    const plan = result.plan;
    return (
      <div className="fov-stack fov-stack--8">
        <span className="fov-row">
          <FovPill tone="blue">{PLAN_STAGE_LABELS[plan.stage] ?? plan.stage}</FovPill>
          <span className="fov-micro" data-testid="fo-plan-proposal-note">
            Proposals only. Nothing here is recorded until you accept it.
          </span>
        </span>

        <ul className="fov-stack fov-stack--10" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {plan.actions.map((action) => {
            const recorded = isActionRecorded(action.intent, workflowStatus);
            return (
              <li key={action.id} data-testid={`fo-plan-action-${action.id}`}>
                <div className="fov-stack fov-stack--2">
                  <span className="fov-row">
                    <FovPill>{ACTION_CATEGORY_LABELS[action.category] ?? action.category}</FovPill>
                    {recorded ? (
                      <FovPill
                        tone="green"
                        testId={`fo-plan-recorded-${action.id}`}
                        title="This workspace’s workflow already carries this decision. It may have been recorded here or elsewhere."
                      >
                        Recorded
                      </FovPill>
                    ) : (
                      <FovPill testId={`fo-plan-proposed-${action.id}`}>Proposed</FovPill>
                    )}
                    <strong style={{ fontSize: 13 }}>{action.title}</strong>
                  </span>

                  <span className="fov-muted">{action.rationale}</span>

                  {action.suggestedTarget ? (
                    <span style={{ fontSize: 12 }} data-testid={`fo-plan-target-${action.id}`}>
                      Target: {action.suggestedTarget}
                    </span>
                  ) : null}

                  {action.dueDateBasis ? (
                    <span className="fov-micro">
                      {/* The basis, never a bare date: a date with no stated
                          derivation is one somebody moves without knowing what
                          it was protecting. */}
                      Suggested by {new Date(action.dueDate!).toLocaleDateString()} —{' '}
                      {action.dueDateBasis}.
                    </span>
                  ) : null}

                  {action.evidence.length > 0 ? (
                    <span className="fov-micro">
                      Evidence:{' '}
                      {action.evidence
                        .map((e) => `${LANDSCAPE_SOURCE_LABELS[e.source] ?? e.source} — ${e.matchedOn}`)
                        .join('; ')}
                      .
                    </span>
                  ) : null}

                  {action.unresolvedPrerequisites.length > 0 ? (
                    <span
                      className="fov-micro fov-warning-text"
                      data-testid={`fo-plan-blocked-${action.id}`}
                    >
                      Needs first: {action.unresolvedPrerequisites.join(' ')}
                    </span>
                  ) : null}

                  {action.intent === 'none' ? (
                    <span className="fov-micro">Nothing to create — this is a note, not a task.</span>
                  ) : result.acceptance.wired ? (
                    <span>
                      <CapiroButton
                        size="compact"
                        variant={recorded ? 'secondary' : 'primary'}
                        disabled={recorded}
                        loading={accept.isPending && accept.variables?.id === action.id}
                        onClick={() => accept.mutate(action)}
                        data-testid={`fo-plan-accept-${action.id}`}
                      >
                        {recorded ? 'Already recorded' : 'Accept'}
                      </CapiroButton>
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {!result.acceptance.wired ? (
          <p className="fov-micro" style={{ margin: 0 }} data-testid="fo-plan-acceptance-unwired">
            {result.acceptance.explanation}
          </p>
        ) : (
          <span className="fov-micro" data-testid="fo-plan-idempotency-note">
            Accepting a second action of the same kind updates the existing task rather than opening
            another one.
          </span>
        )}
      </div>
    );
  };

  return (
    <FovCard title="Action plan" testId="fo-detail-action-plan">
      {body()}
    </FovCard>
  );
}
