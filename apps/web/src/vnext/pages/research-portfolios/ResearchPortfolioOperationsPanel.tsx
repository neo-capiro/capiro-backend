import { ResearchPortfolioOperationRecoveryPanel } from './ResearchPortfolioOperationRecoveryPanel.js';
import { ResearchPortfolioAuthorityBoundary } from './research-portfolio-authority.js';
import {
  emptyImportDraft,
  readImportDraft,
  retainImportFile,
  verifyRetainedImportFile,
  inferredImportMapping,
  IMPORT_FIELDS,
  type RetainedImportDraft,
} from './research-portfolio-import-draft.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useImpersonation } from '../../../state/impersonation.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ResearchPortfolioDecisionType,
  ResearchPortfolioDetailDto,
  ResearchPortfolioImportWorksheetKind,
  ResearchPortfolioReviewDto,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import {
  newIdempotencyKey,
  actOnResearchPortfolioImport,
  assignResearchPortfolioReview,
  createResearchPortfolioImport,
  decideResearchPortfolioReview,
  getResearchPortfolioAnnualReview,
  getResearchPortfolioImport,
  listResearchPortfolioReviews,
  reopenResearchPortfolioAnnualReview,
  researchPortfolioKeys,
} from './research-portfolios-api.js';

type ReviewLane = 'mine' | 'team' | 'deferred' | 'resolved';

export function ResearchPortfolioOperationsPanel(props: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <ResearchPortfolioOperationsPanelContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function ResearchPortfolioOperationsPanelContent({
  portfolio,
  canEdit,
}: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  return (
    <section className="rp-operations" aria-label="Reviews, continuity, and imports">
      <ResearchReviewsPanel portfolio={portfolio} canEdit={canEdit} />
      <AnnualContinuityPanel portfolio={portfolio} canEdit={canEdit} />
      <ResearchImportsPanel portfolio={portfolio} canEdit={canEdit} />
    </section>
  );
}

export function ResearchReviewsPanel(props: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <ResearchReviewsPanelContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function ResearchReviewsPanelContent({
  portfolio,
  canEdit,
}: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [lane, setLane] = useState<ReviewLane>('mine');
  const laneButtons = useRef<Partial<Record<ReviewLane, HTMLButtonElement | null>>>({});
  const [locatorById, setLocatorById] = useState<Record<string, string>>({});
  const assignees = useQuery({
    queryKey: ['research-portfolios', portfolio.id, 'review-assignees'],
    queryFn: async () =>
      (
        await api.get<
          { id: string; name?: string; email?: string; firstName?: string; lastName?: string }[]
        >('/api/users/tenant-members')
      ).data,
    enabled: canEdit,
  });
  function locatorObject(id: string): Record<string, unknown> {
    try {
      const value = JSON.parse(locatorById[id] || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function changeCoordinate(id: string, field: string, value: string) {
    const next = locatorObject(id);
    value.trim()
      ? (next[field] = field === 'page' ? Number(value) : value.trim())
      : delete next[field];
    setLocatorById((current) => ({ ...current, [id]: JSON.stringify(next) }));
  }
  function parseLocator(reviewId: string): Record<string, unknown> {
    const value = JSON.parse(locatorById[reviewId] || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object' || !Object.keys(value).length)
      throw new Error('An exact nonempty locator is required');
    return value;
  }
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [assigneeById, setAssigneeById] = useState<Record<string, string>>({});
  const [sourceById, setSourceById] = useState<Record<string, string>>({});
  const [quoteById, setQuoteById] = useState<Record<string, string>>({});
  const reviews = useQuery({
    queryKey: researchPortfolioKeys.reviews(portfolio.id, lane),
    queryFn: () => listResearchPortfolioReviews(api, portfolio.id, lane),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['research-portfolios', portfolio.id, 'reviews'] }),
      queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.detail(portfolio.id) }),
    ]);
  };
  const assign = useMutation({
    mutationFn: ({
      review,
      assigneeUserId,
    }: {
      review: ResearchPortfolioReviewDto;
      assigneeUserId: string | null;
    }) =>
      assignResearchPortfolioReview(api, portfolio.id, review.id, {
        expectedRevision: review.revision,
        expectedPortfolioRevision: portfolio.revision,
        assigneeUserId,
        reason: reasonById[review.id]?.trim() || 'Review assignment updated',
      }),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: ({
      review,
      decisionType,
    }: {
      review: ResearchPortfolioReviewDto;
      decisionType: ResearchPortfolioDecisionType;
    }) => {
      const sourceRevisionId = sourceById[review.id]?.trim();
      const evidence =
        sourceRevisionId && ['include', 'exclude', 'dispute'].includes(decisionType)
          ? [
              {
                sourceRevisionId,
                locator: parseLocator(review.id),
                quote: quoteById[review.id]?.trim() || null,
                stance: decisionType === 'dispute' ? ('against' as const) : ('for' as const),
              },
            ]
          : [];
      return decideResearchPortfolioReview(api, portfolio.id, review.id, {
        expectedRevision: review.revision,
        expectedPortfolioRevision: portfolio.revision,
        decisionType,
        reason: reasonById[review.id]?.trim() || `${decisionType} decision recorded`,
        evidenceFor: decisionType === 'dispute' ? [] : evidence,
        evidenceAgainst: decisionType === 'dispute' ? evidence : [],
      });
    },
    onSuccess: refresh,
  });
  const evidenceRequired = (review: ResearchPortfolioReviewDto) => {
    if (!sourceById[review.id]?.trim()) return true;
    try {
      parseLocator(review.id);
      return false;
    } catch {
      return true;
    }
  };

  return (
    <section className="rp-card">
      <div className="rp-row rp-row--spread">
        <h2>Review queue</h2>
        <span className="rp-count">{reviews.data?.length ?? 0}</span>
      </div>
      <div className="rp-tabs" role="tablist" aria-label="Review lanes">
        {(['mine', 'team', 'deferred', 'resolved'] as const).map((value) => (
          <button
            key={value}
            ref={(node) => {
              laneButtons.current[value] = node;
            }}
            id={`rp-review-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={lane === value}
            aria-controls="rp-review-panel"
            tabIndex={lane === value ? 0 : -1}
            className="rp-button"
            onClick={() => setLane(value)}
            onKeyDown={(event) => {
              const lanes: ReviewLane[] = ['mine', 'team', 'deferred', 'resolved'];
              const index = lanes.indexOf(value);
              const next =
                event.key === 'ArrowRight'
                  ? lanes[(index + 1) % 4]
                  : event.key === 'ArrowLeft'
                    ? lanes[(index + 3) % 4]
                    : event.key === 'Home'
                      ? 'mine'
                      : event.key === 'End'
                        ? 'resolved'
                        : null;
              if (next) {
                event.preventDefault();
                setLane(next);
                laneButtons.current[next]?.focus();
              }
            }}
          >
            {value}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="rp-review-panel"
        aria-labelledby={`rp-review-tab-${lane}`}
        tabIndex={0}
      >
        {reviews.isLoading ? <p className="rp-state">Loading reviews…</p> : null}
        {reviews.error ? (
          <p className="rp-error" role="alert">
            Reviews could not be loaded.
          </p>
        ) : null}
        {!reviews.isLoading && !reviews.data?.length ? (
          <p className="rp-empty">No reviews in this lane.</p>
        ) : null}
        <ul className="rp-list">
          {reviews.data?.map((review) => (
            <li className="rp-review" key={review.id}>
              <div className="rp-row rp-row--spread">
                <div>
                  <strong>
                    {review.targetKind.replaceAll('_', ' ')} · {review.targetId}
                  </strong>
                  <p className="rp-meta">
                    {review.trigger.replaceAll('_', ' ')} · revision {review.revision}
                  </p>
                </div>
                <span className={`rp-badge rp-badge--${review.status}`}>{review.status}</span>
              </div>
              <p>{review.reason}</p>
              <p className="rp-meta">
                Supporting evidence {review.evidenceFor.length} · conflicting evidence{' '}
                {review.evidenceAgainst.length} · assigned {review.assigneeUserId ?? 'team'}
              </p>
              {canEdit && review.status !== 'cancelled' ? (
                <div className="rp-review-controls">
                  <label>
                    Reason
                    <input
                      value={reasonById[review.id] ?? ''}
                      onChange={(event) =>
                        setReasonById((state) => ({ ...state, [review.id]: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Evidence revision ID
                    <input
                      value={sourceById[review.id] ?? ''}
                      onChange={(event) =>
                        setSourceById((state) => ({ ...state, [review.id]: event.target.value }))
                      }
                    />
                  </label>
                  <fieldset>
                    <legend>Exact evidence location</legend>
                    {['page', 'table', 'row', 'cell', 'section', 'span'].map((field) => (
                      <label key={field}>
                        Evidence {field}
                        <input
                          type={field === 'page' ? 'number' : 'text'}
                          min={field === 'page' ? 1 : undefined}
                          value={String(locatorObject(review.id)[field] ?? '')}
                          onChange={(event) =>
                            changeCoordinate(review.id, field, event.target.value)
                          }
                        />
                      </label>
                    ))}
                  </fieldset>
                  <details>
                    <summary>Advanced evidence locator</summary>
                    <label>
                      Evidence locator JSON
                      <textarea
                        value={locatorById[review.id] ?? ''}
                        onChange={(event) =>
                          setLocatorById((state) => ({ ...state, [review.id]: event.target.value }))
                        }
                      />
                    </label>
                  </details>
                  <label>
                    Evidence quote
                    <input
                      value={quoteById[review.id] ?? ''}
                      onChange={(event) =>
                        setQuoteById((state) => ({ ...state, [review.id]: event.target.value }))
                      }
                    />
                  </label>
                  {review.status !== 'resolved' ? (
                    <label>
                      Assignee
                      <select
                        value={assigneeById[review.id] ?? ''}
                        onChange={(event) =>
                          setAssigneeById((state) => ({
                            ...state,
                            [review.id]: event.target.value,
                          }))
                        }
                        disabled={assignees.isLoading || Boolean(assignees.error)}
                      >
                        <option value="">Team / unassigned</option>
                        {assignees.data?.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name ||
                              [user.firstName, user.lastName].filter(Boolean).join(' ') ||
                              user.email ||
                              user.id}
                          </option>
                        ))}
                      </select>
                      {assignees.error ? (
                        <span role="alert">Authorized assignees could not be loaded.</span>
                      ) : null}
                    </label>
                  ) : null}
                  <div className="rp-action-group">
                    {review.status !== 'resolved' ? (
                      <button
                        className="rp-button"
                        disabled={assign.isPending || decide.isPending}
                        onClick={() =>
                          assign.mutate({
                            review,
                            assigneeUserId: assigneeById[review.id]?.trim() || null,
                          })
                        }
                      >
                        Assign
                      </button>
                    ) : null}
                    {review.status !== 'resolved'
                      ? (['include', 'exclude', 'dispute'] as const).map((decisionType) => (
                          <button
                            key={decisionType}
                            className="rp-button"
                            disabled={
                              evidenceRequired(review) || decide.isPending || assign.isPending
                            }
                            onClick={() => decide.mutate({ review, decisionType })}
                          >
                            {decisionType}
                          </button>
                        ))
                      : null}
                    {review.status !== 'resolved' ? (
                      <button
                        className="rp-button"
                        disabled={decide.isPending || assign.isPending}
                        onClick={() => decide.mutate({ review, decisionType: 'defer' })}
                      >
                        defer
                      </button>
                    ) : null}
                    {review.status === 'resolved' || review.status === 'deferred' ? (
                      <button
                        className="rp-button"
                        disabled={decide.isPending || assign.isPending}
                        onClick={() => decide.mutate({ review, decisionType: 'reopen' })}
                      >
                        reopen
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {assign.error || decide.error ? (
        <p className="rp-error" role="alert">
          The review update failed. Refresh to resolve revision conflicts.
        </p>
      ) : null}
    </section>
  );
}

export function AnnualContinuityPanel(props: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <AnnualContinuityPanelContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function AnnualContinuityPanelContent({
  portfolio,
  canEdit,
}: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const annual = useQuery({
    queryKey: researchPortfolioKeys.annualReview(portfolio.id),
    queryFn: () => getResearchPortfolioAnnualReview(api, portfolio.id),
  });
  const reopen = useMutation({
    mutationFn: () =>
      reopenResearchPortfolioAnnualReview(api, portfolio.id, {
        expectedRevision: portfolio.revision,
        continuityIds: [...selected],
        reason: reason.trim() || undefined,
      }),
    onSuccess: async () => {
      setSelected(new Set());
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: researchPortfolioKeys.annualReview(portfolio.id),
        }),
        queryClient.invalidateQueries({
          queryKey: ['research-portfolios', portfolio.id, 'reviews'],
        }),
        queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.detail(portfolio.id) }),
      ]);
    },
  });
  const material = useMemo(
    () =>
      annual.data?.items.filter((item) => item.status !== 'unchanged' && item.status !== 'new') ??
      [],
    [annual.data],
  );

  return (
    <section className="rp-card">
      <h2>Annual continuity</h2>
      {annual.isLoading ? <p className="rp-state">Loading decision continuity…</p> : null}
      {annual.error ? (
        <p className="rp-error" role="alert">
          Annual continuity could not be loaded.
        </p>
      ) : null}
      {annual.data ? (
        <div className="rp-continuity-counts">
          {Object.entries(annual.data.counts).map(([status, count]) => (
            <span key={status}>
              <strong>{count}</strong> {status}
            </span>
          ))}
        </div>
      ) : null}
      {!annual.isLoading && !annual.data?.items.length ? (
        <p className="rp-empty">No prior decision history is available.</p>
      ) : null}
      <ul className="rp-list">
        {material.map((item) => (
          <li className="rp-list__item" key={item.id}>
            <label>
              <input
                type="checkbox"
                disabled={!canEdit || Boolean(item.reopeningReviewId)}
                checked={selected.has(item.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    event.target.checked ? next.add(item.id) : next.delete(item.id);
                    return next;
                  })
                }
              />{' '}
              {item.status} · {item.continuityKey.slice(0, 12)}
            </label>
            <span className="rp-meta">
              {item.reopeningReviewId
                ? 'Review already opened'
                : (item.reopeningReason ?? 'Material dependency change')}
            </span>
          </li>
        ))}
      </ul>
      {canEdit && material.length ? (
        <div className="rp-row">
          <input
            className="rp-grow-input"
            aria-label="Annual reopen reason"
            placeholder="Why these dependencies need review"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            className="rp-button"
            disabled={!selected.size || reopen.isPending}
            onClick={() => reopen.mutate()}
          >
            Reopen selected
          </button>
        </div>
      ) : null}
      {reopen.error ? (
        <p className="rp-error" role="alert">
          Continuity reviews could not be reopened.
        </p>
      ) : null}
    </section>
  );
}

export function ResearchImportsPanel(props: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <ResearchImportsPanelContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function ResearchImportsPanelContent(props: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
}) {
  const { userId, orgId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  if (!userId) return <p className="rp-state">Loading import access…</p>;
  const scope = JSON.stringify([userId, orgId, actAsTenantSlug ?? null, props.portfolio.id]);
  return <ResearchImportsContent key={scope} {...props} scope={scope} />;
}

function ResearchImportsContent({
  portfolio,
  canEdit,
  scope,
}: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
  scope: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const storageKey = `capiro:research-portfolio-import-handles:v1:${scope}`;
  const [handles, setHandles] = useState<string[]>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(value) ? value.filter((id) => typeof id === 'string').slice(0, 20) : [];
    } catch {
      return [];
    }
  });
  const [jobId, setJobId] = useState<string | null>(() => handles[0] ?? null);
  const [loadId, setLoadId] = useState('');
  const draftKey = `capiro:research-portfolio-import-draft:v1:${scope}`;
  const [loadedDraft] = useState(() => {
    try {
      return { draft: readImportDraft(draftKey), error: null as string | null };
    } catch (error) {
      return {
        draft: emptyImportDraft(),
        error: error instanceof Error ? error.message : 'The retained import could not be read',
      };
    }
  });
  const [draft, setDraft] = useState(loadedDraft.draft);
  const [admissionError, setAdmissionError] = useState<string | null>(loadedDraft.error);
  const [storageFailed, setStorageFailed] = useState(Boolean(loadedDraft.error));
  const [readingFile, setReadingFile] = useState(false);
  const fileSequence = useRef(0);
  function retainDraft(next: RetainedImportDraft): boolean {
    setDraft(next);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
      setStorageFailed(false);
      setAdmissionError(null);
      return true;
    } catch {
      setStorageFailed(true);
      setAdmissionError(
        'The original import could not be retained in this browser. No request was sent. Choose a smaller file or enable session storage before creating.',
      );
      return false;
    }
  }
  async function chooseFile(file: File | null) {
    if (draft.attempt || loadedDraft.error) return;
    const sequence = ++fileSequence.current;
    if (!file) {
      retainDraft({ ...draft, original: null, mapping: {} });
      return;
    }
    retainDraft({ ...draft, original: null, mapping: {} });
    setReadingFile(true);
    try {
      const original = await retainImportFile(file);
      if (mounted.current && sequence === fileSequence.current)
        retainDraft({
          ...draft,
          original,
          mapping: inferredImportMapping(draft.kind, original.headers),
        });
    } catch (error) {
      if (mounted.current && sequence === fileSequence.current)
        setAdmissionError(error instanceof Error ? error.message : 'The CSV could not be read');
    } finally {
      if (mounted.current && sequence === fileSequence.current) setReadingFile(false);
    }
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [repairs, setRepairs] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function remember(id: string) {
    const next = [id, ...handles.filter((value) => value !== id)].slice(0, 20);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      if (mounted.current)
        setNotice(
          'The import handle could not be retained. Copy the job ID before leaving this page.',
        );
    }
    if (mounted.current) {
      setHandles(next);
      setJobId(id);
      setDirty(false);
    }
  }
  const detail = useQuery({
    queryKey: [...researchPortfolioKeys.import(portfolio.id, jobId ?? 'none'), scope],
    queryFn: () => getResearchPortfolioImport(api, portfolio.id, jobId!),
    enabled: Boolean(jobId),
  });
  useEffect(() => {
    if (!detail.data || dirty) return;
    setSelected(new Set(detail.data.rows.filter((row) => row.selected).map((row) => row.id)));
    setRepairs(
      Object.fromEntries(
        detail.data.rows.map((row) => [row.id, JSON.stringify(row.repairs ?? {})]),
      ),
    );
    setDirty(false);
  }, [detail.data, dirty]);
  const create = useMutation({
    mutationFn: async () => {
      if (!draft.original || storageFailed || loadedDraft.error)
        throw new Error('Retain an original CSV before creating');
      await verifyRetainedImportFile(draft.original);
      if (!mounted.current) throw new Error('The import authority changed before submission');
      const payload = draft.attempt?.payload ?? {
        expectedRevision: portfolio.revision,
        worksheetKind: draft.kind,
        fileName: draft.original.name,
        mediaType: draft.original.mediaType,
        contentBase64: draft.original.contentBase64,
        schemaVersion: `${draft.kind}-v1`,
        mapping: draft.mapping,
      };
      if (IMPORT_FIELDS[draft.kind].required.some((field) => !payload.mapping[field]))
        throw new Error('Map every required field before creating');
      const attempt = draft.attempt ?? {
        operationKey: newIdempotencyKey('import-create'),
        payload,
        uncertain: false,
      };
      // Persist immutable intent and its identity before the first possible write.
      if (!retainDraft({ ...draft, attempt }))
        throw new Error(
          'The request was not sent because its recovery identity could not be retained',
        );
      return createResearchPortfolioImport(
        api,
        portfolio.id,
        attempt.payload,
        attempt.operationKey,
      );
    },
    onSuccess: (job) => {
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      if (!mounted.current) return;
      setDraft(emptyImportDraft());
      setStorageFailed(false);
      setAdmissionError(null);
      remember(job.id);
    },
    onError: (error: unknown) => {
      if (!mounted.current) return;
      const status = (error as { response?: { status?: number } }).response?.status;
      setDraft((current) => {
        if (!current.attempt) return current;
        // A later rejection never disproves an earlier uncertain commit.
        const rejected = !current.attempt.uncertain && status && [400, 413, 422].includes(status);
        const next = rejected
          ? { ...current, attempt: null }
          : { ...current, attempt: { ...current.attempt, uncertain: true } };
        try {
          sessionStorage.setItem(draftKey, JSON.stringify(next));
        } catch {
          setStorageFailed(true);
        }
        return next;
      });
    },
  });
  const act = useMutation({
    mutationFn: ({
      action,
      previewHash,
    }: {
      action:
        'preview' | 'apply' | 'pause' | 'resume' | 'cancel' | 'retry' | 'reconcile' | 'compensate';
      previewHash?: string;
    }) => {
      if (!jobId || (action === 'apply' && dirty))
        throw new Error('Preview selected/repaired rows before applying');
      const previewInput =
        action === 'preview' && detail.data?.rows.length
          ? {
              selectedRowIds: [...selected],
              repairs: Object.fromEntries(
                Object.entries(repairs).map(([rowId, text]) => {
                  const value = JSON.parse(text || '{}');
                  if (!value || Array.isArray(value) || typeof value !== 'object')
                    throw new Error(`Row ${rowId} repair must be a JSON object`);
                  return [rowId, value];
                }),
              ),
            }
          : {};
      return actOnResearchPortfolioImport(api, portfolio.id, jobId, action, {
        expectedRevision: ['apply', 'compensate'].includes(action) ? portfolio.revision : undefined,
        compensationPreviewHash: previewHash,
        ...previewInput,
      });
    },
    onSuccess: (result) => {
      if (!mounted.current) return;
      queryClient.setQueryData(
        [...researchPortfolioKeys.import(portfolio.id, result.id), scope],
        result,
      );
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.detail(portfolio.id) });
    },
  });
  const jobDetail = detail.data;
  const compensationPreview = [...(jobDetail?.compensationReceipts ?? [])]
    .reverse()
    .find((receipt) => receipt.status === 'previewed');
  const editablePreview = Boolean(
    canEdit &&
    jobDetail &&
    ['mapped', 'previewed', 'failed', 'partial'].includes(jobDetail.status) &&
    !act.isPending,
  );
  function exportReceipt() {
    if (!jobDetail) return;
    const blob = new Blob([JSON.stringify(jobDetail, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `research-portfolio-import-${jobDetail.id}-receipt.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="rp-card" aria-label="Research Portfolio imports">
      <ResearchPortfolioOperationRecoveryPanel portfolioId={portfolio.id} canEdit={canEdit} />
      <h2>Recoverable CSV import</h2>
      <form
        className="rp-form rp-form--inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (loadId.trim()) remember(loadId.trim());
        }}
      >
        <label>
          Import job ID
          <input value={loadId} onChange={(event) => setLoadId(event.target.value)} />
        </label>
        <button className="rp-button" disabled={!loadId.trim()}>
          Load import
        </button>
      </form>
      {handles.length ? (
        <label>
          Remembered imports
          <select value={jobId ?? ''} onChange={(event) => remember(event.target.value)}>
            {handles.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <p className="rp-meta">
        Membership columns: target_kind,target_id; rules: readable_expression,expression_json;
        reviews: target_kind,target_id,reason. Custom headers can be mapped with JSON.
      </p>
      {canEdit ? (
        <form
          className="rp-import-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!create.isPending && !readingFile) create.mutate();
          }}
        >
          <fieldset
            disabled={
              Boolean(draft.attempt) ||
              create.isPending ||
              readingFile ||
              Boolean(loadedDraft.error)
            }
          >
            <legend>Original import and mapping</legend>
            <label>
              Worksheet
              <select
                value={draft.kind}
                onChange={(event) => {
                  const kind = event.target.value as ResearchPortfolioImportWorksheetKind;
                  retainDraft({
                    ...draft,
                    kind,
                    mapping: inferredImportMapping(kind, draft.original?.headers ?? []),
                  });
                }}
              >
                <option value="membership">Membership</option>
                <option value="rules">Rules</option>
                <option value="reviews">Reviews</option>
              </select>
            </label>
            <label>
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  void chooseFile(event.target.files?.[0] ?? null);
                }}
              />
            </label>
            {draft.original ? (
              <>
                <p>
                  Retained original: {draft.original.name} · {draft.original.size} bytes
                </p>
                <p className="rp-meta">SHA-256 {draft.original.sha256}</p>
                <div className="rp-form">
                  {[
                    ...IMPORT_FIELDS[draft.kind].required,
                    ...IMPORT_FIELDS[draft.kind].optional,
                  ].map((field) => (
                    <label key={field}>
                      Map {field}
                      {IMPORT_FIELDS[draft.kind].required.includes(field) ? ' (required)' : ''}
                      <select
                        value={draft.mapping[field] ?? ''}
                        onChange={(event) => {
                          const mapping = { ...draft.mapping };
                          event.target.value
                            ? (mapping[field] = event.target.value)
                            : delete mapping[field];
                          retainDraft({ ...draft, mapping });
                        }}
                      >
                        <option value="">Not mapped</option>
                        {draft.original!.headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </>
            ) : null}
          </fieldset>
          {readingFile ? <p role="status">Reading and retaining the original CSV…</p> : null}
          {draft.attempt ? (
            <p role="status">
              The original import request is pending or uncertain. Retry its retained bytes and
              mapping before editing.
            </p>
          ) : null}
          {admissionError ? (
            <p className="rp-error" role="alert">
              {admissionError}
            </p>
          ) : null}
          <button
            className="rp-button rp-button--primary"
            disabled={
              !draft.original ||
              create.isPending ||
              readingFile ||
              storageFailed ||
              Boolean(loadedDraft.error) ||
              IMPORT_FIELDS[draft.kind].required.some((field) => !draft.mapping[field])
            }
          >
            {create.isPending
              ? 'Creating import…'
              : draft.attempt
                ? 'Retry original import request'
                : 'Create import job'}
          </button>
        </form>
      ) : (
        <p>Import history is read-only.</p>
      )}
      {create.error ? (
        <p className="rp-error" role="alert">
          The import could not be admitted. Check the CSV, schema, mapping, and portfolio revision.
        </p>
      ) : null}
      {jobId && detail.isLoading ? <p className="rp-state">Loading durable import job…</p> : null}
      {detail.error ? (
        <div>
          <p className="rp-error" role="alert">
            The import job could not be loaded or access was revoked.
          </p>
          <button className="rp-button" onClick={() => detail.refetch()}>
            Retry loading import
          </button>
        </div>
      ) : null}
      {jobDetail ? (
        <div className="rp-import-job">
          <div className="rp-row rp-row--spread">
            <strong>{jobDetail.fileName}</strong>
            <span className={`rp-badge rp-badge--${jobDetail.status}`}>
              {jobDetail.status.replaceAll('_', ' ')}
            </span>
          </div>
          <p>Job ID {jobDetail.id}</p>
          <p className="rp-meta">
            SHA-256 {jobDetail.originalHash} · {jobDetail.rowCount} rows · {jobDetail.appliedCount}{' '}
            applied
          </p>
          <button className="rp-button" onClick={exportReceipt}>
            Export all-row receipt
          </button>
          {dirty ? (
            <p role="status">Selection or repairs changed. Preview again before applying.</p>
          ) : null}
          {canEdit ? (
            <div className="rp-action-group">
              {['mapped', 'failed', 'partial', 'previewed'].includes(jobDetail.status) ? (
                <button
                  disabled={act.isPending}
                  className="rp-button"
                  onClick={() => act.mutate({ action: 'preview' })}
                >
                  Preview selected rows
                </button>
              ) : null}
              {['previewed', 'applying'].includes(jobDetail.status) ? (
                <button
                  disabled={act.isPending || dirty || !selected.size}
                  className="rp-button rp-button--primary"
                  onClick={() => act.mutate({ action: 'apply' })}
                >
                  Apply selected rows
                </button>
              ) : null}
              {jobDetail.status === 'applying' ? (
                <button
                  disabled={act.isPending}
                  className="rp-button"
                  onClick={() => act.mutate({ action: 'pause' })}
                >
                  Pause
                </button>
              ) : null}
              {jobDetail.status === 'paused' ? (
                <button
                  disabled={act.isPending}
                  className="rp-button"
                  onClick={() => act.mutate({ action: 'resume' })}
                >
                  Resume
                </button>
              ) : null}
              {['failed', 'partial'].includes(jobDetail.status) ? (
                <button
                  disabled={act.isPending}
                  className="rp-button"
                  onClick={() => act.mutate({ action: 'retry' })}
                >
                  Retry known failures
                </button>
              ) : null}
              {['unknown', 'needs_reconciliation'].includes(jobDetail.status) ? (
                <button
                  disabled={act.isPending}
                  className="rp-button"
                  onClick={() => act.mutate({ action: 'reconcile' })}
                >
                  Reconcile unknown outcome
                </button>
              ) : null}
              {!['completed', 'compensated', 'cancelled'].includes(jobDetail.status) ? (
                <button
                  disabled={act.isPending}
                  className="rp-button rp-button--danger"
                  onClick={() => act.mutate({ action: 'cancel' })}
                >
                  Cancel
                </button>
              ) : null}
              {['completed', 'partial'].includes(jobDetail.status) ? (
                <button
                  disabled={act.isPending}
                  className="rp-button"
                  onClick={() => act.mutate({ action: 'compensate' })}
                >
                  Preview compensation
                </button>
              ) : null}
              {compensationPreview ? (
                <button
                  disabled={act.isPending}
                  className="rp-button rp-button--danger"
                  onClick={() =>
                    act.mutate({
                      action: 'compensate',
                      previewHash: compensationPreview.previewHash,
                    })
                  }
                >
                  Commit compensation
                </button>
              ) : null}
            </div>
          ) : null}
          {act.error ? (
            <p className="rp-error" role="alert">
              The action failed safely. Check repair JSON and reload the job before retrying.
            </p>
          ) : null}
          {jobDetail.rows.length ? (
            <div
              className="rp-table-wrap"
              role="region"
              aria-label="Import row outcomes"
              tabIndex={0}
            >
              <table className="rp-table">
                <thead>
                  <tr>
                    <th scope="col">Selected</th>
                    <th scope="col">Row</th>
                    <th scope="col">Target</th>
                    <th scope="col">Preview</th>
                    <th scope="col">Final</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Repair</th>
                  </tr>
                </thead>
                <tbody>
                  {jobDetail.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select import row ${row.rowNumber}`}
                          checked={selected.has(row.id)}
                          disabled={!editablePreview}
                          onChange={(event) => {
                            setSelected((current) => {
                              const next = new Set(current);
                              event.target.checked ? next.add(row.id) : next.delete(row.id);
                              return next;
                            });
                            setDirty(true);
                          }}
                        />
                      </td>
                      <td>{row.rowNumber}</td>
                      <td>{row.canonicalTargetKey ?? '—'}</td>
                      <td>{row.previewClassification ?? 'not previewed'}</td>
                      <td>{row.finalOutcome ?? 'pending'}</td>
                      <td>{row.finalReason ?? row.previewReason ?? '—'}</td>
                      <td>
                        <textarea
                          aria-label={`Repair import row ${row.rowNumber} JSON`}
                          value={repairs[row.id] ?? '{}'}
                          disabled={!editablePreview}
                          onChange={(event) => {
                            setRepairs((current) => ({ ...current, [row.id]: event.target.value }));
                            setDirty(true);
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
