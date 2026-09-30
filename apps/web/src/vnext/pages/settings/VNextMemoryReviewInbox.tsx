/**
 * vNext re-skin of components/MemoryReviewInbox.tsx — identical endpoints,
 * query keys (including the ?review= deep link), infinite pagination,
 * capability-gated actions, revision flow and copy, via
 * memory-review-inbox-shared.ts.
 */
import { useMemo, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import {
  memoryReviewBlockedReasonLabel,
  memoryReviewEmptyDescription,
  memoryReviewErrorMessage,
  memoryReviewNextActionLabel,
  memoryReviewStatusLabel,
  type MemoryReviewDetail,
  type MemoryReviewInboxPage,
  type MemoryReviewInboxSummary,
  type MemoryReviewInboxView,
  type MemoryReviewNotificationPage,
  type MemoryReviewSectionBody,
  type MemoryReviewStatus,
} from '../../../components/memory-review-inbox-shared.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import { SvCallout, SvCard, SvDescriptions, SvStat, SvTextArea } from './settings-ui.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReasonAction = 'reject' | 'request_changes' | 'reassign' | null;

function statusTone(status: MemoryReviewStatus): CapiroBadgeTone {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'changes_requested') return 'warning';
  if (status === 'pending') return 'info';
  return 'neutral';
}

function reasonModalTitle(action: ReasonAction): string {
  if (action === 'request_changes') return 'Request changes';
  if (action === 'reassign') return 'Assign an eligible reviewer';
  return 'Reject memory proposal';
}

export function VNextMemoryReviewInbox({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useCapiroToast();
  const [view, setView] = useState<MemoryReviewInboxView>('needs_my_review');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedReviewRequestId, setSelectedReviewRequestId] = useState<string | null>(() => {
    const review = searchParams.get('review');
    return review && UUID_PATTERN.test(review) ? review : null;
  });
  const [reasonAction, setReasonAction] = useState<ReasonAction>(null);
  const [reason, setReason] = useState('');
  const [reviewerUserId, setReviewerUserId] = useState<string | undefined>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionSections, setRevisionSections] = useState<MemoryReviewSectionBody[]>([]);
  const [revisionValue, setRevisionValue] = useState('');

  const summary = useQuery<MemoryReviewInboxSummary>({
    queryKey: ['memory-review-inbox-summary'],
    queryFn: async () =>
      (await api.get<MemoryReviewInboxSummary>('/api/memory/review/inbox/summary')).data,
    staleTime: 10_000,
    retry: 1,
  });

  const inbox = useInfiniteQuery<MemoryReviewInboxPage>({
    queryKey: ['memory-review-inbox', view],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<MemoryReviewInboxPage>('/api/memory/review/inbox', {
          params: {
            view,
            limit: 25,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        })
      ).data,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: summary.data?.enabled === true,
    staleTime: 10_000,
    retry: 1,
  });

  const detail = useQuery<MemoryReviewDetail>({
    queryKey: ['memory-review-detail', selectedCandidateId, selectedReviewRequestId],
    queryFn: async () => {
      const path = selectedReviewRequestId
        ? `/api/memory/review/inbox/requests/${selectedReviewRequestId}`
        : `/api/memory/review/inbox/candidates/${selectedCandidateId}`;
      return (await api.get<MemoryReviewDetail>(path)).data;
    },
    enabled: Boolean(selectedCandidateId || selectedReviewRequestId),
    retry: 1,
  });

  const items = useMemo(
    () => inbox.data?.pages.flatMap((page) => page.items) ?? [],
    [inbox.data],
  );

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['memory-review-inbox'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-inbox-summary'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-detail'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-notifications'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-notification-count'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] }),
      qc.invalidateQueries({ queryKey: ['memory-own-proposals'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-summary'] }),
    ]);
  };

  const action = useMutation({
    mutationFn: async (input: { path: string; body?: Record<string, unknown> }) =>
      (await api.post(input.path, input.body ?? {})).data,
    onSuccess: async () => {
      toast.success('Memory review updated');
      setReasonAction(null);
      setReason('');
      setReviewerUserId(undefined);
      setRevisionOpen(false);
      await refresh();
    },
    onError: (error: unknown) => toast.error(memoryReviewErrorMessage(error)),
  });

  const openCandidate = (candidateId: string) => {
    setSelectedReviewRequestId(null);
    setSelectedCandidateId(candidateId);
    const next = new URLSearchParams(searchParams);
    next.delete('review');
    setSearchParams(next, { replace: true });
  };

  const closeDetail = () => {
    setSelectedCandidateId(null);
    setSelectedReviewRequestId(null);
    const next = new URLSearchParams(searchParams);
    next.delete('review');
    setSearchParams(next, { replace: true });
  };

  const openRevision = () => {
    const current = detail.data;
    if (!current) return;
    setRevisionSections(
      current.proposal.canonicalItem?.sections.map((section) => ({ ...section })) ?? [],
    );
    setRevisionValue(current.proposal.value ?? '');
    setRevisionOpen(true);
  };

  if (summary.isLoading) {
    return (
      <SvCard aria-label="Loading memory review inbox">
        <div className="stv-stack">
          <CapiroSkeleton height={20} width="35%" />
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      </SvCard>
    );
  }
  if (summary.isError) {
    return (
      <SvCallout
        kind="warning"
        title="Memory Review Inbox could not be loaded"
        description="Active memory is unchanged. Refresh before taking review action."
      />
    );
  }
  if (!summary.data?.enabled) {
    return (
      <SvCallout
        kind="warning"
        title="Shared memory review is unavailable"
        description="Firm and client proposals remain inactive until Memory Review is enabled."
      />
    );
  }

  const tabItems = [
    {
      id: 'needs_my_review',
      label: 'Needs my review',
      badge: { count: summary.data.counts.needsMyReview },
    },
    {
      id: 'submitted_by_me',
      label: 'Submitted by me',
      badge: { count: summary.data.counts.submittedByMe },
    },
    ...(isAdmin
      ? [
          {
            id: 'all_pending',
            label: 'All pending',
            badge: { count: summary.data.counts.allPending },
          },
          { id: 'blocked', label: 'Blocked', badge: { count: summary.data.counts.blocked } },
        ]
      : []),
    { id: 'history', label: 'History', badge: { count: summary.data.counts.history } },
  ];

  return (
    <div className="stv-stack">
      <SvCard
        aria-label="Memory Review Inbox"
        title="Memory Review Inbox"
        description="Review shared memory, follow requested changes, and see who owns the next step."
        extra={
          <CapiroButton loading={inbox.isFetching} onClick={() => void refresh()}>
            Refresh
          </CapiroButton>
        }
      >
        <div className="stv-stack">
          <div className="stv-row" style={{ gap: 32 }}>
            <SvStat label="Needs my review" value={summary.data.counts.needsMyReview} />
            <SvStat label="Submitted by me" value={summary.data.counts.submittedByMe} />
            {isAdmin && (
              <SvStat
                label="Blocked"
                value={summary.data.counts.blocked}
                danger={summary.data.counts.blocked > 0}
              />
            )}
          </div>

          {summary.data.truncated && (
            <SvCallout kind="info" title="Counts cover the most recent 1,000 review records" />
          )}

          <CapiroTabs
            label="Memory review views"
            items={tabItems}
            activeId={view}
            onChange={(id) => setView(id as MemoryReviewInboxView)}
          />

          {inbox.isLoading ? (
            <div className="stv-stack" aria-label="Loading review items">
              <CapiroSkeleton height={16} />
              <CapiroSkeleton height={16} width="70%" />
            </div>
          ) : inbox.isError ? (
            <SvCallout kind="error" title="This review view could not be loaded" />
          ) : items.length === 0 ? (
            <CapiroEmptyState title={memoryReviewEmptyDescription(view)} />
          ) : (
            <div className="stv-stack stv-stack--tight">
              {items.map((item) => (
                <div
                  key={item.reviewRequestId}
                  className="stv-row stv-row--between stv-row--start"
                  style={{ padding: '10px 0', borderBottom: '1px solid var(--stv-border)' }}
                >
                  <div className="stv-stack stv-stack--tight" style={{ gap: 4 }}>
                    <div className="stv-row">
                      <span className="stv-strong">{item.title}</span>
                      <CapiroBadge tone={statusTone(item.status)}>
                        {memoryReviewStatusLabel(item.status)}
                      </CapiroBadge>
                      <CapiroBadge>
                        {item.scope === 'client' ? 'Client memory' : 'Firm memory'}
                      </CapiroBadge>
                      {item.revisionNumber > 1 && (
                        <CapiroBadge>Revision {item.revisionNumber}</CapiroBadge>
                      )}
                    </div>
                    <span className="stv-muted stv-small">
                      {item.client ? `${item.client.name} · ` : ''}
                      Submitted by {item.submittedBy.name} ·{' '}
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                    <span>{memoryReviewNextActionLabel(item)}</span>
                    {memoryReviewBlockedReasonLabel(item.blockedReason) && (
                      <span className="stv-danger-text">
                        {memoryReviewBlockedReasonLabel(item.blockedReason)}
                      </span>
                    )}
                  </div>
                  <CapiroButton size="compact" onClick={() => openCandidate(item.candidateId)}>
                    Open
                  </CapiroButton>
                </div>
              ))}
            </div>
          )}

          {inbox.hasNextPage && (
            <CapiroButton
              loading={inbox.isFetchingNextPage}
              onClick={() => void inbox.fetchNextPage()}
            >
              Load more
            </CapiroButton>
          )}
        </div>
      </SvCard>

      <VNextMemoryReviewNotifications onOpenCandidate={openCandidate} />

      <CapiroDrawer
        open={Boolean(selectedCandidateId || selectedReviewRequestId)}
        title={detail.data?.title ?? 'Memory review'}
        onClose={closeDetail}
      >
        <div className="stv-drawer-wide" />
        {detail.isLoading ? (
          <div className="stv-stack" aria-label="Loading review detail">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : detail.isError || !detail.data ? (
          <SvCallout
            kind="warning"
            title="This review is no longer available to you"
            description="Assignment, membership, client access, or the ethical wall may have changed."
          />
        ) : (
          <div className="stv-stack">
            <SvDescriptions
              items={[
                { label: 'Status', value: memoryReviewStatusLabel(detail.data.status) },
                { label: 'Submitted by', value: detail.data.submittedBy.name },
                {
                  label: 'Assigned reviewer',
                  value: detail.data.assignedReviewer?.name ?? 'Not assigned',
                },
                { label: 'Next step', value: memoryReviewNextActionLabel(detail.data) },
                ...(detail.data.client
                  ? [{ label: 'Client', value: detail.data.client.name }]
                  : []),
              ]}
            />

            {detail.data.activeMemoryUnchanged && (
              <SvCallout
                kind="info"
                title="Active memory is unchanged"
                description="This proposal remains separate until an authorized administrator or reviewer approves it."
              />
            )}

            {detail.data.feedbackReason && (
              <SvCallout
                kind="warning"
                title={
                  detail.data.status === 'changes_requested'
                    ? 'Reviewer requested changes'
                    : 'Reviewer feedback'
                }
                description={detail.data.feedbackReason}
              />
            )}

            {!['pending', 'changes_requested'].includes(detail.data.status) && (
              <SvCard title="Decision receipt" aria-label="Memory decision receipt">
                <SvDescriptions
                  items={[
                    { label: 'Review reference', value: <code>{detail.data.candidateId}</code> },
                    { label: 'Decision', value: memoryReviewStatusLabel(detail.data.status) },
                    {
                      label: 'Decided by',
                      value: detail.data.decidedBy?.name ?? 'Canonical review service',
                    },
                    {
                      label: 'Decided at',
                      value: detail.data.decidedAt
                        ? new Date(detail.data.decidedAt).toLocaleString()
                        : 'Timestamp unavailable',
                    },
                    {
                      label: 'Controlling version',
                      value: detail.data.controllingMemory
                        ? `${detail.data.controllingMemory.itemId} · version ${detail.data.controllingMemory.version ?? 'unreported'}`
                        : 'No controlling memory version reported',
                    },
                  ]}
                />
              </SvCard>
            )}

            <SvCard title="Proposed memory">
              {detail.data.proposal.canonicalItem?.sections.map((section) => (
                <div key={section.key} style={{ marginBottom: 16 }}>
                  <span className="stv-strong">{section.heading}</span>
                  <p className="stv-prewrap">{section.body || '—'}</p>
                </div>
              ))}
              {!detail.data.proposal.canonicalItem && (
                <p className="stv-prewrap">{detail.data.proposal.value || '—'}</p>
              )}
            </SvCard>

            <div className="stv-row">
              {detail.data.capabilities.approve && (
                <CapiroButton
                  variant="primary"
                  loading={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/memory/review/candidates/${detail.data.candidateId}/approve`,
                    })
                  }
                >
                  Approve
                </CapiroButton>
              )}
              {detail.data.capabilities.requestChanges && (
                <CapiroButton
                  onClick={() => {
                    setReason('');
                    setReasonAction('request_changes');
                  }}
                >
                  Request changes
                </CapiroButton>
              )}
              {detail.data.capabilities.reject && (
                <CapiroButton
                  className="stv-btn-danger"
                  onClick={() => {
                    setReason('');
                    setReasonAction('reject');
                  }}
                >
                  Reject
                </CapiroButton>
              )}
              {detail.data.capabilities.revise && (
                <CapiroButton variant="primary" onClick={openRevision}>
                  Revise and resubmit
                </CapiroButton>
              )}
              {detail.data.capabilities.reassign && (
                <CapiroButton
                  onClick={() => {
                    setReason('');
                    setReviewerUserId(detail.data?.assignedReviewer?.userId);
                    setReasonAction('reassign');
                  }}
                >
                  Assign reviewer
                </CapiroButton>
              )}
              {detail.data.capabilities.withdraw && (
                <CapiroButton
                  className="stv-btn-danger"
                  loading={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/memory/proposals/${detail.data.candidateId}/withdraw`,
                    })
                  }
                >
                  Withdraw
                </CapiroButton>
              )}
            </div>

            <SvCard title="Revision history">
              <div className="stv-stack stv-stack--tight">
                {detail.data.timeline.map((entry) => (
                  <div
                    key={entry.candidateId}
                    style={{
                      borderLeft: `3px solid ${
                        entry.candidateId === detail.data?.candidateId
                          ? 'var(--capiro-color-info)'
                          : 'var(--stv-border-strong)'
                      }`,
                      paddingLeft: 12,
                    }}
                  >
                    <span className="stv-strong">
                      Revision {entry.revisionNumber} · {memoryReviewStatusLabel(entry.status)}
                    </span>
                    <div className="stv-muted stv-small">
                      Submitted by {entry.submittedBy.name} ·{' '}
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                    {entry.assignedReviewer && (
                      <div className="stv-muted stv-small">
                        Reviewer: {entry.assignedReviewer.name}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </SvCard>
          </div>
        )}
      </CapiroDrawer>

      {reasonAction !== null ? (
        <CapiroModal
          open
          title={reasonModalTitle(reasonAction)}
          onClose={() => {
            setReasonAction(null);
            setReason('');
            setReviewerUserId(undefined);
          }}
        >
          <div className="stv-stack">
            {reasonAction === 'reassign' && (
              <CapiroSelect
                label="Eligible reviewer"
                value={reviewerUserId ?? ''}
                onChange={(event) => setReviewerUserId(event.target.value || undefined)}
                options={[
                  { value: '', label: 'Choose an eligible reviewer' },
                  ...(detail.data?.eligibleReviewers ?? []).map((reviewer) => ({
                    value: reviewer.userId,
                    label: reviewer.name,
                  })),
                ]}
              />
            )}
            <SvTextArea
              aria-label="Review reason"
              rows={4}
              maxLength={500}
              showCount
              value={reason}
              placeholder="Explain what needs to happen next"
              onChange={setReason}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setReasonAction(null);
                  setReason('');
                  setReviewerUserId(undefined);
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton
                variant="primary"
                className={reasonAction === 'reject' ? 'stv-btn-danger' : undefined}
                disabled={!reason.trim() || (reasonAction === 'reassign' && !reviewerUserId)}
                loading={action.isPending}
                onClick={() => {
                  const current = detail.data;
                  if (!current || !reasonAction || !reason.trim()) return;
                  if (reasonAction === 'reassign') {
                    if (!reviewerUserId) return;
                    action.mutate({
                      path: `/api/memory/review/candidates/${current.candidateId}/assign`,
                      body: { reviewerUserId, reason: reason.trim() },
                    });
                    return;
                  }
                  action.mutate({
                    path: `/api/memory/review/candidates/${current.candidateId}/${
                      reasonAction === 'request_changes' ? 'request-changes' : 'reject'
                    }`,
                    body: { reason: reason.trim() },
                  });
                }}
              >
                {reasonAction === 'reassign' ? 'Assign reviewer' : 'Confirm'}
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      {revisionOpen ? (
        <CapiroModal open title="Revise memory proposal" onClose={() => setRevisionOpen(false)}>
          <div className="stv-stack stv-modal-mid">
            <SvCallout
              kind="info"
              title="A revision creates a new immutable proposal"
              description="The prior proposal remains in history and active memory stays unchanged."
            />
            {revisionSections.length > 0 ? (
              revisionSections.map((section, index) => (
                <div key={section.key}>
                  <SvTextArea
                    label={section.heading}
                    rows={5}
                    value={section.body}
                    maxLength={50_000}
                    onChange={(body) =>
                      setRevisionSections((current) =>
                        current.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, body } : candidate,
                        ),
                      )
                    }
                  />
                </div>
              ))
            ) : (
              <SvTextArea
                aria-label="Revision content"
                rows={10}
                value={revisionValue}
                maxLength={200_000}
                onChange={setRevisionValue}
              />
            )}
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setRevisionOpen(false)}>Cancel</CapiroButton>
              <CapiroButton
                variant="primary"
                disabled={
                  revisionSections.length > 0
                    ? revisionSections.every((section) => !section.body.trim())
                    : !revisionValue.trim()
                }
                loading={action.isPending}
                onClick={() => {
                  const current = detail.data;
                  if (!current) return;
                  action.mutate({
                    path: `/api/memory/review/candidates/${current.candidateId}/revise`,
                    body:
                      revisionSections.length > 0
                        ? { sections: revisionSections }
                        : { value: revisionValue },
                  });
                }}
              >
                Submit revision
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}
    </div>
  );
}

function VNextMemoryReviewNotifications({
  onOpenCandidate,
}: {
  onOpenCandidate: (candidateId: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const notifications = useQuery<MemoryReviewNotificationPage>({
    queryKey: ['memory-review-notifications'],
    queryFn: async () =>
      (
        await api.get<MemoryReviewNotificationPage>('/api/memory/review/notifications', {
          params: { limit: 10 },
        })
      ).data,
    staleTime: 10_000,
    retry: 1,
  });
  const unread = useQuery<{ enabled: boolean; count: number }>({
    queryKey: ['memory-review-notification-count'],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; count: number }>(
          '/api/memory/review/notifications/unread-count',
        )
      ).data,
    staleTime: 10_000,
    retry: 1,
  });
  const markRead = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/memory/review/notifications/${id}/read`, {})).data,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['memory-review-notifications'] }),
        qc.invalidateQueries({ queryKey: ['memory-review-notification-count'] }),
      ]);
    },
    onError: (error: unknown) => toast.error(memoryReviewErrorMessage(error)),
  });
  const markAll = useMutation({
    mutationFn: async () =>
      (await api.post('/api/memory/review/notifications/read-all', {})).data,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['memory-review-notifications'] }),
        qc.invalidateQueries({ queryKey: ['memory-review-notification-count'] }),
      ]);
    },
    onError: (error: unknown) => toast.error(memoryReviewErrorMessage(error)),
  });

  if (notifications.data?.enabled === false) return null;

  return (
    <SvCard
      title={
        <span className="stv-row" style={{ gap: 8 }}>
          Review notifications
          <CapiroBadge tone={(unread.data?.count ?? 0) > 0 ? 'info' : 'neutral'}>
            {unread.data?.count ?? 0}
          </CapiroBadge>
        </span>
      }
      extra={
        (unread.data?.count ?? 0) > 0 ? (
          <CapiroButton
            variant="quiet"
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </CapiroButton>
        ) : undefined
      }
    >
      {notifications.isLoading ? (
        <div className="stv-stack" aria-label="Loading notifications">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : notifications.data?.items.length ? (
        <div className="stv-stack stv-stack--tight">
          {notifications.data.items.map((notification) => (
            <button
              key={notification.id}
              type="button"
              className="stv-row stv-row--between"
              style={{
                opacity: notification.readAt ? 0.72 : 1,
                cursor: 'pointer',
                background: 'transparent',
                border: 0,
                borderBottom: '1px solid var(--stv-border)',
                padding: '8px 0',
                font: 'inherit',
                textAlign: 'left',
                width: '100%',
              }}
              onClick={() => {
                if (!notification.readAt) markRead.mutate(notification.id);
                onOpenCandidate(notification.candidateId);
              }}
            >
              <span className="stv-stack stv-stack--tight" style={{ gap: 2 }}>
                <span className="stv-strong">{notification.title}</span>
                <span className="stv-muted stv-small">
                  {new Date(notification.createdAt).toLocaleString()}
                </span>
              </span>
              {!notification.readAt && <CapiroBadge tone="info" dot>New</CapiroBadge>}
            </button>
          ))}
        </div>
      ) : (
        <CapiroEmptyState title="No memory review notifications" />
      )}
    </SvCard>
  );
}
