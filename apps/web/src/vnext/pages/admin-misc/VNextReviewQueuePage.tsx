/**
 * vNext re-skin of pages/reviews/ReviewQueuePage.tsx — the §3.3 reviewer queue
 * over the G4 reviews backend. Identical hooks (reviews-api.js reused
 * verbatim), status filter, the revived /reviews?id= deep link (defaults the
 * filter to 'all' so a decided review still lands), the scroll-into-view
 * highlight, and the honest empty state. Visible to every real user; the
 * server scopes the list by role and user_admin gets the Assign control.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isTenantAdmin } from '@capiro/shared';
import { useMe } from '../../../lib/me.js';
import { useReviewsList, useTeamMembers } from '../../../pages/reviews/reviews-api.js';
import type { ReviewStatus } from '../../../pages/reviews/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { SvSegmented } from '../settings/settings-ui.js';
import { VNextReviewCard } from './VNextReviewCard.js';

type StatusFilter = ReviewStatus | 'all';

export function VNextReviewQueuePage() {
  const me = useMe();
  // MP-13 / Gate H phase b: the /reviews?id= deep link (StepGenerate.tsx). The
  // target's status is unknown from the link alone, so default to the 'all'
  // filter rather than 'pending' — otherwise a link to an already-decided
  // review would land on an empty list. (Parsed from window.location, not
  // useParams — VNextRouter mounts above the canonical param routes.)
  const targetId = useMemo(() => new URLSearchParams(window.location.search).get('id'), []);
  const [status, setStatus] = useState<StatusFilter>(() => (targetId ? 'all' : 'pending'));

  const role = me.data?.role;
  const isAdmin = role ? isTenantAdmin(role) : false;
  const list = useReviewsList(status);
  // Only admins can assign, so only they need the roster.
  const team = useTeamMembers();

  const reviews = useMemo(() => (Array.isArray(list.data) ? list.data : []), [list.data]);
  const members = useMemo(
    () => (isAdmin && Array.isArray(team.data) ? team.data : []),
    [isAdmin, team.data],
  );

  const isLoading = list.isLoading;
  const isEmpty = !isLoading && reviews.length === 0;

  const highlightRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (targetId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [targetId, reviews]);

  return (
    <div className="settings-vnext amx">
      <header className="stv-header">
        <div>
          <h1>Review Queue</h1>
          <p>
            Held deliverables (grounding-flagged in enforce mode) awaiting an approve / reject
            decision.
          </p>
        </div>
        <div className="amx-header-actions">
          <span className="stv-muted stv-small">{reviews.length ? `${reviews.length}` : ''}</span>
          <CapiroButton
            onClick={() => void list.refetch()}
            loading={list.isFetching && !list.isLoading}
          >
            Refresh
          </CapiroButton>
        </div>
      </header>

      <div className="stv-body amx-body--narrow">
        <SvSegmented<StatusFilter>
          aria-label="Review status filter"
          value={status}
          onChange={setStatus}
          options={[
            { label: 'Pending', value: 'pending' },
            { label: 'Approved', value: 'approved' },
            { label: 'Rejected', value: 'rejected' },
            { label: 'All', value: 'all' },
          ]}
        />

        {isLoading ? (
          <div className="stv-stack" aria-label="Loading reviews">
            <CapiroSkeleton height={64} />
            <CapiroSkeleton height={64} />
          </div>
        ) : isEmpty ? (
          <CapiroEmptyState
            title="Nothing to review"
            description="Held deliverables (grounding-flagged in enforce mode) show up here for approval."
          />
        ) : (
          <div className="stv-stack">
            {reviews.map((review) => {
              const highlighted = !!targetId && review.id === targetId;
              return (
                <div
                  key={review.id}
                  ref={highlighted ? highlightRef : undefined}
                  className={highlighted ? 'amx-review-highlight' : undefined}
                >
                  <VNextReviewCard review={review} isAdmin={isAdmin} teamMembers={members} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
