/**
 * vNext re-skin of components/PendingMemoryReviewPanel.tsx — identical copy
 * and semantics via the shared pending-memory-review-shared.ts helpers.
 */
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import {
  activeMemoryReviewExplanation,
  activeMemoryVersionPresentation,
  pendingReviewHeadline,
  pendingReviewSourceLabel,
  pendingReviewTone,
  type MemoryReviewSection,
  type PendingMemoryReviewState,
} from '../../../components/pending-memory-review-shared.js';
import { SvCallout, SvCard, SvDescriptions } from './settings-ui.js';

const TAG_TONE: Record<'green' | 'gold' | 'default', CapiroBadgeTone> = {
  green: 'success',
  gold: 'warning',
  default: 'neutral',
};

export function VNextPendingMemoryReviewPanel({
  activeExists,
  activeSections,
  pending,
}: {
  activeExists: boolean;
  activeSections: MemoryReviewSection[];
  pending: PendingMemoryReviewState;
}) {
  const reviewers = pending.eligibleReviewers ?? [];
  const proposalSections = pending.proposal?.sections ?? [];
  const activePresentation = activeMemoryVersionPresentation(activeExists);
  const showAuditDetails = Boolean(
    pending.submittedBy || pending.viewerCanReview || pending.canWithdraw,
  );

  return (
    <SvCard aria-label="Pending memory review">
      <div className="stv-stack">
        <SvCallout
          kind={pendingReviewTone(pending)}
          title={pendingReviewHeadline(pending)}
          description={
            <span className="stv-stack stv-stack--tight" style={{ display: 'grid' }}>
              <span>
                {pending.nextAction ?? 'The active version remains unchanged until approval.'}
              </span>
              {pending.submittedBy && (
                <span className="stv-muted">
                  Submitted by {pending.submittedBy.name} on {formatDate(pending.submittedAt)}.
                </span>
              )}
            </span>
          }
        />

        <SvDescriptions
          items={[
            {
              label: 'Status',
              value: (
                <CapiroBadge tone={pending.blocked ? 'danger' : 'info'}>
                  {pendingReviewHeadline(pending)}
                </CapiroBadge>
              ),
            },
            { label: 'Applies to', value: pending.scope === 'client' ? 'This client' : 'The firm' },
            {
              label: 'Approver needed',
              value: pending.reviewerRequirement ?? 'An authorized administrator or reviewer',
            },
            { label: 'Source', value: pendingReviewSourceLabel(pending.sourceKind) },
            {
              label: 'Version',
              value: `Current ${pending.activeVersion ?? 'not reported'} · Proposed ${pending.proposalVersion ?? 'pending'}`,
            },
            ...(pending.conflict
              ? [
                  {
                    label: 'Conflict',
                    value: <span className="stv-danger-text">{pending.conflict}</span>,
                  },
                ]
              : []),
            {
              label: 'Eligible approvers',
              value:
                reviewers.length > 0 ? (
                  <span className="stv-row" style={{ gap: 4 }}>
                    {reviewers.map((reviewer) => (
                      <CapiroBadge key={reviewer.userId}>{reviewer.name}</CapiroBadge>
                    ))}
                  </span>
                ) : pending.blocked ? (
                  <span className="stv-danger-text">None currently available</span>
                ) : (
                  <span className="stv-muted">
                    Available to authorized administrators and reviewers
                  </span>
                ),
            },
          ]}
        />

        <div>
          <h3 className="stv-card__title" style={{ marginBottom: 8 }}>
            Current and proposed memory
          </h3>
          <span className="stv-muted">{activeMemoryReviewExplanation(activeExists)}</span>
        </div>

        <div className="stv-grid-2">
          <MemoryVersionCard
            title={activePresentation.title}
            tag={activePresentation.tag}
            tagTone={TAG_TONE[activePresentation.tagColor]}
            sections={activeExists ? activeSections : []}
          />
          <MemoryVersionCard
            title={
              pending.proposal?.title ? `Proposed: ${pending.proposal.title}` : 'Proposed version'
            }
            tag="Not active yet"
            tagTone={TAG_TONE.gold}
            sections={proposalSections}
          />
        </div>

        {showAuditDetails && (
          <details>
            <summary style={{ cursor: 'pointer' }}>Audit details</summary>
            <p className="stv-muted" style={{ marginTop: 8, marginBottom: 0 }}>
              Review reference:{' '}
              <code className="stv-code">{pending.auditReference ?? pending.candidateId}</code>
            </p>
          </details>
        )}
      </div>
    </SvCard>
  );
}

function MemoryVersionCard({
  title,
  tag,
  tagTone,
  sections,
}: {
  title: string;
  tag: string;
  tagTone: CapiroBadgeTone;
  sections: MemoryReviewSection[];
}) {
  return (
    <SvCard>
      <div className="stv-stack stv-stack--tight">
        <div className="stv-row">
          <span className="stv-strong">{title}</span>
          <CapiroBadge tone={tagTone}>{tag}</CapiroBadge>
        </div>
        {sections.length === 0 ? (
          <CapiroEmptyState title="No content in this version" />
        ) : (
          sections.map((section) => (
            <section key={section.key}>
              <span className="stv-strong">{section.heading}</span>
              <p className="stv-prewrap">{section.body || '—'}</p>
            </section>
          ))
        )}
      </div>
    </SvCard>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
