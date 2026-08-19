/**
 * vNext re-skin of pages/reviews/ReviewCard.tsx — one held-deliverable review
 * (§3.3). Identical endpoints (reviews-api.js is reused verbatim — it is
 * UI-free), copy, and decision semantics: approve releases, reject leaves it
 * unfiled, admin-only Assign. The server's assertMayDecide remains the authz
 * boundary; the buttons are an affordance and a non-permitted decide surfaces
 * the 403 via toast.error rather than being hidden.
 */
import { useState } from 'react';
import {
  useApproveReview,
  useAssignReview,
  useRejectReview,
  type TeamMemberOption,
} from '../../../pages/reviews/reviews-api.js';
import {
  RISK_TIER_COLORS,
  RISK_TIER_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  SURFACE_LABELS,
  type ReviewRequestDto,
} from '../../../pages/reviews/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { SvCard, svBadgeTone, useSvConfirm } from '../settings/settings-ui.js';

function memberName(m: TeamMemberOption): string {
  const full = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return full || m.email || m.userId;
}

export function VNextReviewCard({
  review,
  isAdmin,
  teamMembers,
}: {
  review: ReviewRequestDto;
  isAdmin: boolean;
  teamMembers: TeamMemberOption[];
}) {
  const toast = useCapiroToast();
  const approve = useApproveReview();
  const reject = useRejectReview();
  const assign = useAssignReview();
  const { confirm, dialog } = useSvConfirm();
  const [assigning, setAssigning] = useState(false);

  const members = Array.isArray(teamMembers) ? teamMembers : [];
  const isPending = review.status === 'pending';
  const busy = approve.isPending || reject.isPending || assign.isPending;

  const assignedName = review.assignedTo
    ? (members.find((m) => m.userId === review.assignedTo)
        ? memberName(members.find((m) => m.userId === review.assignedTo)!)
        : 'Assigned')
    : null;

  function handleApprove() {
    approve.mutate(
      { id: review.id },
      {
        onSuccess: (res) => {
          const file = res?.released?.fileName;
          toast.success(file ? `Approved & filed "${file}"` : 'Approved & released');
        },
        onError: (err) => toast.error(err.message || 'Could not approve'),
      },
    );
  }

  function handleReject() {
    reject.mutate(
      { id: review.id },
      {
        onSuccess: () => toast.success('Rejected — the deliverable stays unfiled'),
        onError: (err) => toast.error(err.message || 'Could not reject'),
      },
    );
  }

  function handleAssign(userId: string) {
    if (!userId) return;
    setAssigning(true);
    assign.mutate(
      { id: review.id, userId },
      {
        onSuccess: () => toast.success('Reviewer assigned'),
        onError: (err) => toast.error(err.message || 'Could not assign'),
        onSettled: () => setAssigning(false),
      },
    );
  }

  return (
    <SvCard aria-label={review.title}>
      <div className="stv-stack stv-stack--tight">
        <div className="stv-row" style={{ gap: 6 }}>
          <CapiroBadge tone={svBadgeTone(RISK_TIER_COLORS[review.riskTier])}>
            {RISK_TIER_LABELS[review.riskTier]}
          </CapiroBadge>
          <CapiroBadge>{SURFACE_LABELS[review.surface] ?? review.surface}</CapiroBadge>
          <CapiroBadge tone={svBadgeTone(STATUS_COLORS[review.status])}>
            {STATUS_LABELS[review.status]}
          </CapiroBadge>
        </div>

        <span className="stv-strong" style={{ fontSize: 15 }}>
          {review.title}
        </span>

        <p className="stv-muted" style={{ margin: 0 }}>
          {review.reason}
        </p>

        <div className="stv-row" style={{ gap: 16 }}>
          <span className="stv-muted stv-small">
            Held {new Date(review.createdAt).toLocaleDateString()}
          </span>
          {assignedName ? <span className="stv-muted stv-small">{assignedName}</span> : null}
        </div>

        {isPending ? (
          <div className="stv-row" style={{ marginTop: 4 }}>
            <CapiroButton
              variant="primary"
              loading={approve.isPending}
              disabled={busy && !approve.isPending}
              onClick={() =>
                confirm({
                  title: 'Approve & release this deliverable?',
                  body: 'Approving files the held deliverable into the client record.',
                  okText: 'Approve',
                  onOk: () => handleApprove(),
                })
              }
            >
              Approve
            </CapiroButton>
            <CapiroButton
              className="stv-btn-danger"
              loading={reject.isPending}
              disabled={busy && !reject.isPending}
              onClick={() =>
                confirm({
                  title: 'Reject this deliverable?',
                  body: 'Rejecting leaves it unfiled; nothing is sent to the client.',
                  okText: 'Reject',
                  danger: true,
                  onOk: () => handleReject(),
                })
              }
            >
              Reject
            </CapiroButton>
            {isAdmin ? (
              <span style={{ minWidth: 200 }}>
                <CapiroSelect
                  label="Assign reviewer"
                  aria-busy={assigning || undefined}
                  disabled={busy && !assign.isPending}
                  value={review.assignedTo ?? ''}
                  onChange={(e) => handleAssign(e.target.value)}
                  options={[
                    { value: '', label: members.length === 0 ? 'No team members' : 'Assign reviewer…', disabled: true },
                    ...members.map((m) => ({ value: m.userId, label: memberName(m) })),
                  ]}
                />
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {dialog}
    </SvCard>
  );
}
