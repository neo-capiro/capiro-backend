import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, List, Space, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  ASSESSMENT_SECTIONS,
  ASSESSMENT_SECTION_LABELS,
  FUNDING_OPPORTUNITIES_MERI_FEATURE,
  assessmentApiPath,
  type AssessedClaimView,
  type AssessmentResultView,
  type MeriAssessmentView,
} from './funding-opportunities-api.js';

const { Paragraph, Text } = Typography;

/**
 * The governed Meri assessment (P38).
 *
 * ── Four rules every line of copy here follows ──────────────────────────────
 *
 * 1. THE RECOMMENDATION IS CAPIRO'S. The restatement section renders the
 *    deterministic decision the server wrote, and this panel offers no control
 *    that could change it. When the model argued for something else, the
 *    argument is rendered as ANALYSIS in its own visually distinct block —
 *    never next to the recommendation, never as an alternative to click.
 *
 * 2. HELD IS SHOWN, NOT HIDDEN. A statement the server could not tie to packet
 *    evidence renders with its reason attached. Dropping it would let a reader
 *    take a shorter assessment for a cleaner one; styling it the same as a
 *    supported statement would be worse.
 *
 * 3. INCOMPLETE IS THE HEADLINE, NOT A FOOTNOTE. When the packet was thin or
 *    the model did not contribute, that is the first thing on the card. An
 *    assessment that looks confident and is not is the failure mode this whole
 *    phase exists to avoid.
 *
 * 4. NOTHING HERE SENDS ANYTHING. Proposed drafts are listed with their
 *    rationale and no action button. Turning one into a document is a separate,
 *    explicit step somewhere else — there is deliberately no path from this
 *    card to a write.
 *
 * ── Generated on request, never on render ────────────────────────────────────
 *
 * A mutation, not a query. `useQuery` would fire on mount, and mounting is what
 * opening a detail drawer does — every drawer open would cost a model call and
 * an artifact row. The user asks.
 */

/** The API's own refusal sentence, when the error carries one. */
function serverMessage(error: unknown): string | null {
  const body = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (Array.isArray(body) && typeof body[0] === 'string') return body.join(' ');
  return null;
}

function ClaimItem({ claim }: { claim: AssessedClaimView }) {
  const held = claim.verdict === 'held';
  return (
    <List.Item data-testid={`assessment-claim-${claim.verdict}`}>
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Space size={6} align="start" wrap>
          <Tag color={held ? 'orange' : 'green'}>{held ? 'Held' : 'Supported'}</Tag>
          <Text>{claim.text}</Text>
        </Space>
        {held && claim.holdReason ? (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {claim.holdReason}
          </Text>
        ) : null}
        {claim.refs.length > 0 ? (
          <Space size={4} wrap>
            {claim.refs.map((ref) => (
              <Tag key={ref} data-testid="assessment-claim-ref">
                {ref}
              </Tag>
            ))}
          </Space>
        ) : null}
        {claim.unresolvedRefs.length > 0 ? (
          // Shown, not swallowed. A reader needs to be able to see that the
          // model cited something Capiro cannot resolve.
          <Text type="secondary" style={{ fontSize: 11 }} data-testid="assessment-unresolved-refs">
            Cited but not in the packet: {claim.unresolvedRefs.join(', ')}
          </Text>
        ) : null}
      </Space>
    </List.Item>
  );
}

function Assessment({
  assessment: a,
  provenance,
}: {
  assessment: MeriAssessmentView;
  provenance: { model: string | null; promptVersion: string; artifactVersion: number };
}) {
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {a.incomplete ? (
        <Alert
          type="warning"
          showIcon
          data-testid="assessment-incomplete"
          message="This assessment is incomplete"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {a.incompleteReasons.map((reason) => (
                <li key={reason}>
                  <Text style={{ fontSize: 12 }}>{reason}</Text>
                </li>
              ))}
            </ul>
          }
        />
      ) : null}

      {a.modelState !== 'applied' ? (
        <Alert
          type="info"
          showIcon
          data-testid="assessment-model-state"
          message={a.modelStateExplanation}
        />
      ) : null}

      {ASSESSMENT_SECTIONS.map((key) => {
        const lines = a.sections[key] ?? [];
        if (lines.length === 0) return null;
        return (
          <div key={key} data-testid={`assessment-section-${key}`}>
            <Text type="secondary" className="fo-fact__label">
              {ASSESSMENT_SECTION_LABELS[key]}
            </Text>
            {lines.map((line, i) => (
              <Paragraph key={`${key}-${i}`} style={{ marginBottom: 4 }}>
                {line}
              </Paragraph>
            ))}
          </div>
        );
      })}

      {a.disagreement ? (
        <Alert
          type="warning"
          data-testid="assessment-disagreement"
          message="Model analysis, held for review"
          description={
            <Space direction="vertical" size={2}>
              <Text style={{ fontSize: 12 }}>
                The model argued for <strong>{a.disagreement.proposed}</strong>. Capiro’s
                recommendation is unchanged and remains{' '}
                <strong>{a.recommendation ?? 'not computed'}</strong>. This is analysis for a human
                to weigh, not a decision.
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {a.disagreement.rationale}
              </Text>
            </Space>
          }
        />
      ) : null}

      {a.claims.length > 0 ? (
        <div>
          <Text type="secondary" className="fo-fact__label">
            Statements and evidence
          </Text>
          <List
            size="small"
            dataSource={a.claims}
            renderItem={(claim) => <ClaimItem claim={claim} />}
          />
        </div>
      ) : null}

      {a.proposedDrafts.length > 0 ? (
        <div data-testid="assessment-drafts">
          <Text type="secondary" className="fo-fact__label">
            Proposed drafts
          </Text>
          <List
            size="small"
            dataSource={a.proposedDrafts}
            renderItem={(draft) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <Text>{draft.title}</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {draft.rationale}
                  </Text>
                </Space>
              </List.Item>
            )}
          />
          {/* No button. Listing a draft is not offering to produce one, and a
              one-click "generate" here would be exactly the un-reviewed
              artifact the phase forbids. */}
          <Text type="secondary" style={{ fontSize: 11 }}>
            Proposals only. Nothing has been drafted, sent, or saved.
          </Text>
        </div>
      ) : null}

      <Text type="secondary" style={{ fontSize: 11 }} data-testid="assessment-provenance">
        Version {provenance.artifactVersion} · prompt {provenance.promptVersion}
        {provenance.model ? ` · ${provenance.model}` : ''} · fingerprint{' '}
        {a.fingerprint.slice(0, 12)}
      </Text>
    </Space>
  );
}

export function MeriOpportunityAssessment({
  clientId,
  conversationId,
  source,
  sourceRecordId,
}: {
  clientId: string | null;
  /** The Meri conversation this assessment is scoped to; null hides the panel. */
  conversationId: string | null;
  source: string;
  sourceRecordId: string;
}) {
  const api = useApi();
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_MERI_FEATURE);

  const run = useMutation<AssessmentResultView>({
    mutationFn: async () =>
      (
        await api.post<AssessmentResultView>(assessmentApiPath(source, sourceRecordId), {
          clientId,
          conversationId,
        })
      ).data,
  });

  if (!flag.ready || !flag.enabled) return null;

  let body: React.ReactNode;
  if (clientId == null) {
    body = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Not available without a client. An assessment is a judgement about a client-opportunity
        pair, not about the notice.
      </Text>
    );
  } else if (conversationId == null) {
    body = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        Open this opportunity from a Meri conversation to generate an assessment. The assessment and
        its version history are kept with that conversation.
      </Text>
    );
  } else if (run.isPending) {
    body = <Text type="secondary">Assessing…</Text>;
  } else if (run.isError) {
    body = (
      <Alert
        type="error"
        showIcon
        data-testid="assessment-error"
        message="The assessment could not be produced"
        description={serverMessage(run.error) ?? 'Try again.'}
      />
    );
  } else if (run.data && run.data.state !== 'available') {
    // A refusal is the server's sentence, rendered as-is. Rewording it here
    // would be a second wording of an ethical-wall message.
    body = (
      <Alert
        type="info"
        showIcon
        data-testid="assessment-refused"
        message={run.data.explanation}
      />
    );
  } else if (run.data) {
    body = <Assessment assessment={run.data.assessment} provenance={run.data.provenance} />;
  } else {
    body = (
      <Space direction="vertical" size={6}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Meri can compose an executive assessment from the same evidence shown on this page. It
          restates Capiro’s recommendation and cannot change it.
        </Text>
        <Tooltip title="Calls a model and records an audit artifact.">
          <Button size="small" onClick={() => run.mutate()} data-testid="assessment-run">
            Generate assessment
          </Button>
        </Tooltip>
      </Space>
    );
  }

  return (
    <Card
      size="small"
      title="Meri assessment"
      className="fo-detail__section"
      data-testid="fo-detail-meri-assessment"
    >
      {body}
    </Card>
  );
}
