import type { ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
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
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovPill } from './fov-ui.js';

/**
 * The governed Meri assessment (P38) — vNext port of the canonical panel.
 *
 * The four rules are unchanged: the recommendation is Capiro's (the model's
 * disagreement renders as analysis, never as an alternative to click); held is
 * shown, not hidden; incomplete is the headline; nothing here sends anything.
 * Still a mutation, never a query — the user asks, a drawer open does not.
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
    <li data-testid={`assessment-claim-${claim.verdict}`}>
      <div className="fov-stack fov-stack--2">
        <span className="fov-row">
          <FovPill tone={held ? 'orange' : 'green'}>{held ? 'Held' : 'Supported'}</FovPill>
          <span>{claim.text}</span>
        </span>
        {held && claim.holdReason ? <span className="fov-micro">{claim.holdReason}</span> : null}
        {claim.refs.length > 0 ? (
          <span className="fov-row">
            {claim.refs.map((ref) => (
              <FovPill key={ref} testId="assessment-claim-ref">
                {ref}
              </FovPill>
            ))}
          </span>
        ) : null}
        {claim.unresolvedRefs.length > 0 ? (
          // Shown, not swallowed. A reader needs to be able to see that the
          // model cited something Capiro cannot resolve.
          <span className="fov-micro" data-testid="assessment-unresolved-refs">
            Cited but not in the packet: {claim.unresolvedRefs.join(', ')}
          </span>
        ) : null}
      </div>
    </li>
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
    <div className="fov-stack fov-stack--10">
      {a.incomplete ? (
        <FovAlert
          tone="warning"
          testId="assessment-incomplete"
          message="This assessment is incomplete"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {a.incompleteReasons.map((reason) => (
                <li key={reason}>
                  <span style={{ fontSize: 12 }}>{reason}</span>
                </li>
              ))}
            </ul>
          }
        />
      ) : null}

      {a.modelState !== 'applied' ? (
        <FovAlert tone="info" testId="assessment-model-state" message={a.modelStateExplanation} />
      ) : null}

      {ASSESSMENT_SECTIONS.map((key) => {
        const lines = a.sections[key] ?? [];
        if (lines.length === 0) return null;
        return (
          <div key={key} data-testid={`assessment-section-${key}`}>
            <span className="fov-fact__label">{ASSESSMENT_SECTION_LABELS[key]}</span>
            {lines.map((line, i) => (
              <p key={`${key}-${i}`} style={{ margin: '0 0 4px' }}>
                {line}
              </p>
            ))}
          </div>
        );
      })}

      {a.disagreement ? (
        <FovAlert
          tone="warning"
          testId="assessment-disagreement"
          message="Model analysis, held for review"
          description={
            <div className="fov-stack fov-stack--2">
              <span style={{ fontSize: 12 }}>
                The model argued for <strong>{a.disagreement.proposed}</strong>. Capiro’s
                recommendation is unchanged and remains{' '}
                <strong>{a.recommendation ?? 'not computed'}</strong>. This is analysis for a human
                to weigh, not a decision.
              </span>
              <span className="fov-muted">{a.disagreement.rationale}</span>
            </div>
          }
        />
      ) : null}

      {a.claims.length > 0 ? (
        <div>
          <span className="fov-fact__label">Statements and evidence</span>
          <ul className="fov-stack fov-stack--6" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
            {a.claims.map((claim, index) => (
              <ClaimItem key={`${claim.section}-${index}`} claim={claim} />
            ))}
          </ul>
        </div>
      ) : null}

      {a.proposedDrafts.length > 0 ? (
        <div data-testid="assessment-drafts">
          <span className="fov-fact__label">Proposed drafts</span>
          <ul className="fov-stack fov-stack--6" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
            {a.proposedDrafts.map((draft) => (
              <li key={draft.title}>
                <div className="fov-stack">
                  <span>{draft.title}</span>
                  <span className="fov-micro">{draft.rationale}</span>
                </div>
              </li>
            ))}
          </ul>
          {/* No button. Listing a draft is not offering to produce one, and a
              one-click "generate" here would be exactly the un-reviewed
              artifact the phase forbids. */}
          <span className="fov-micro">Proposals only. Nothing has been drafted, sent, or saved.</span>
        </div>
      ) : null}

      <span className="fov-micro" data-testid="assessment-provenance">
        Version {provenance.artifactVersion} · prompt {provenance.promptVersion}
        {provenance.model ? ` · ${provenance.model}` : ''} · fingerprint {a.fingerprint.slice(0, 12)}
      </span>
    </div>
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

  let body: ReactNode;
  if (clientId == null) {
    body = (
      <span className="fov-muted">
        Not available without a client. An assessment is a judgement about a client-opportunity
        pair, not about the notice.
      </span>
    );
  } else if (conversationId == null) {
    body = (
      <span className="fov-muted">
        Open this opportunity from a Meri conversation to generate an assessment. The assessment and
        its version history are kept with that conversation.
      </span>
    );
  } else if (run.isPending) {
    body = <span className="fov-muted">Assessing…</span>;
  } else if (run.isError) {
    body = (
      <FovAlert
        tone="error"
        testId="assessment-error"
        message="The assessment could not be produced"
        description={serverMessage(run.error) ?? 'Try again.'}
      />
    );
  } else if (run.data && run.data.state !== 'available') {
    // A refusal is the server's sentence, rendered as-is. Rewording it here
    // would be a second wording of an ethical-wall message.
    body = <FovAlert tone="info" testId="assessment-refused" message={run.data.explanation} />;
  } else if (run.data) {
    body = <Assessment assessment={run.data.assessment} provenance={run.data.provenance} />;
  } else {
    body = (
      <div className="fov-stack fov-stack--6">
        <span className="fov-muted">
          Meri can compose an executive assessment from the same evidence shown on this page. It
          restates Capiro’s recommendation and cannot change it.
        </span>
        <span title="Calls a model and records an audit artifact.">
          <CapiroButton size="compact" onClick={() => run.mutate()} data-testid="assessment-run">
            Generate assessment
          </CapiroButton>
        </span>
      </div>
    );
  }

  return (
    <FovCard title="Meri assessment" testId="fo-detail-meri-assessment">
      {body}
    </FovCard>
  );
}
