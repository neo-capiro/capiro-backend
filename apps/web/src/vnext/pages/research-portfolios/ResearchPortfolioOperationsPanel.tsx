import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ResearchPortfolioDecisionType,
  ResearchPortfolioDetailDto,
  ResearchPortfolioImportWorksheetKind,
  ResearchPortfolioReviewDto,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import {
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

export function ResearchPortfolioOperationsPanel({ portfolio, canEdit }: {
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

function ResearchReviewsPanel({ portfolio, canEdit }: { portfolio: ResearchPortfolioDetailDto; canEdit: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [lane, setLane] = useState<ReviewLane>('mine');
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
    mutationFn: ({ review, assigneeUserId }: { review: ResearchPortfolioReviewDto; assigneeUserId: string | null }) => assignResearchPortfolioReview(api, portfolio.id, review.id, {
      expectedRevision: review.revision,
      expectedPortfolioRevision: portfolio.revision,
      assigneeUserId,
      reason: reasonById[review.id]?.trim() || 'Review assignment updated',
    }),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: ({ review, decisionType }: { review: ResearchPortfolioReviewDto; decisionType: ResearchPortfolioDecisionType }) => {
      const sourceRevisionId = sourceById[review.id]?.trim();
      const evidence = sourceRevisionId ? [{ sourceRevisionId, locator: {}, quote: quoteById[review.id]?.trim() || null, stance: decisionType === 'dispute' ? 'against' as const : 'for' as const }] : [];
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
  const evidenceRequired = (review: ResearchPortfolioReviewDto) => !sourceById[review.id]?.trim();

  return (
    <section className="rp-card">
      <div className="rp-row rp-row--spread"><h2>Review queue</h2><span className="rp-count">{reviews.data?.length ?? 0}</span></div>
      <div className="rp-tabs" role="tablist" aria-label="Review lanes">
        {(['mine', 'team', 'deferred', 'resolved'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={lane === value} className="rp-button" onClick={() => setLane(value)}>{value}</button>
        ))}
      </div>
      {reviews.isLoading ? <p className="rp-state">Loading reviews…</p> : null}
      {reviews.error ? <p className="rp-error" role="alert">Reviews could not be loaded.</p> : null}
      {!reviews.isLoading && !reviews.data?.length ? <p className="rp-empty">No reviews in this lane.</p> : null}
      <ul className="rp-list">
        {reviews.data?.map((review) => (
          <li className="rp-review" key={review.id}>
            <div className="rp-row rp-row--spread">
              <div><strong>{review.targetKind.replaceAll('_', ' ')} · {review.targetId}</strong><p className="rp-meta">{review.trigger.replaceAll('_', ' ')} · revision {review.revision}</p></div>
              <span className={`rp-badge rp-badge--${review.status}`}>{review.status}</span>
            </div>
            <p>{review.reason}</p>
            <p className="rp-meta">Supporting evidence {review.evidenceFor.length} · conflicting evidence {review.evidenceAgainst.length} · assigned {review.assigneeUserId ?? 'team'}</p>
            {canEdit ? <div className="rp-review-controls">
              <label>Reason<input value={reasonById[review.id] ?? ''} onChange={(event) => setReasonById((state) => ({ ...state, [review.id]: event.target.value }))} /></label>
              <label>Evidence revision ID<input value={sourceById[review.id] ?? ''} onChange={(event) => setSourceById((state) => ({ ...state, [review.id]: event.target.value }))} /></label>
              <label>Evidence quote<input value={quoteById[review.id] ?? ''} onChange={(event) => setQuoteById((state) => ({ ...state, [review.id]: event.target.value }))} /></label>
              <label>Assignee user ID<input value={assigneeById[review.id] ?? ''} onChange={(event) => setAssigneeById((state) => ({ ...state, [review.id]: event.target.value }))} /></label>
              <div className="rp-action-group">
                <button className="rp-button" onClick={() => assign.mutate({ review, assigneeUserId: assigneeById[review.id]?.trim() || null })}>Assign</button>
                {(['include', 'exclude', 'dispute'] as const).map((decisionType) => <button key={decisionType} className="rp-button" disabled={evidenceRequired(review)} onClick={() => decide.mutate({ review, decisionType })}>{decisionType}</button>)}
                <button className="rp-button" onClick={() => decide.mutate({ review, decisionType: 'defer' })}>defer</button>
                {(review.status === 'resolved' || review.status === 'deferred') ? <button className="rp-button" onClick={() => decide.mutate({ review, decisionType: 'reopen' })}>reopen</button> : null}
              </div>
            </div> : null}
          </li>
        ))}
      </ul>
      {assign.error || decide.error ? <p className="rp-error" role="alert">The review update failed. Refresh to resolve revision conflicts.</p> : null}
    </section>
  );
}

function AnnualContinuityPanel({ portfolio, canEdit }: { portfolio: ResearchPortfolioDetailDto; canEdit: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const annual = useQuery({ queryKey: researchPortfolioKeys.annualReview(portfolio.id), queryFn: () => getResearchPortfolioAnnualReview(api, portfolio.id) });
  const reopen = useMutation({
    mutationFn: () => reopenResearchPortfolioAnnualReview(api, portfolio.id, { expectedRevision: portfolio.revision, continuityIds: [...selected], reason: reason.trim() || undefined }),
    onSuccess: async () => {
      setSelected(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.annualReview(portfolio.id) }),
        queryClient.invalidateQueries({ queryKey: ['research-portfolios', portfolio.id, 'reviews'] }),
        queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.detail(portfolio.id) }),
      ]);
    },
  });
  const material = useMemo(() => annual.data?.items.filter((item) => item.status !== 'unchanged' && item.status !== 'new') ?? [], [annual.data]);

  return <section className="rp-card">
    <h2>Annual continuity</h2>
    {annual.isLoading ? <p className="rp-state">Loading decision continuity…</p> : null}
    {annual.error ? <p className="rp-error" role="alert">Annual continuity could not be loaded.</p> : null}
    {annual.data ? <div className="rp-continuity-counts">{Object.entries(annual.data.counts).map(([status, count]) => <span key={status}><strong>{count}</strong> {status}</span>)}</div> : null}
    {!annual.isLoading && !annual.data?.items.length ? <p className="rp-empty">No prior decision history is available.</p> : null}
    <ul className="rp-list">{material.map((item) => <li className="rp-list__item" key={item.id}><label><input type="checkbox" disabled={!canEdit || Boolean(item.reopeningReviewId)} checked={selected.has(item.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} /> {item.status} · {item.continuityKey.slice(0, 12)}</label><span className="rp-meta">{item.reopeningReviewId ? 'Review already opened' : item.reopeningReason ?? 'Material dependency change'}</span></li>)}</ul>
    {canEdit && material.length ? <div className="rp-row"><input className="rp-grow-input" aria-label="Annual reopen reason" placeholder="Why these dependencies need review" value={reason} onChange={(event) => setReason(event.target.value)} /><button className="rp-button" disabled={!selected.size || reopen.isPending} onClick={() => reopen.mutate()}>Reopen selected</button></div> : null}
    {reopen.error ? <p className="rp-error" role="alert">Continuity reviews could not be reopened.</p> : null}
  </section>;
}

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function ResearchImportsPanel({ portfolio, canEdit }: { portfolio: ResearchPortfolioDetailDto; canEdit: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<ResearchPortfolioImportWorksheetKind>('membership');
  const [mappingText, setMappingText] = useState('{}');
  const [jobId, setJobId] = useState<string | null>(null);
  const detail = useQuery({ queryKey: researchPortfolioKeys.import(portfolio.id, jobId ?? 'none'), queryFn: () => getResearchPortfolioImport(api, portfolio.id, jobId!), enabled: Boolean(jobId) });
  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a CSV file');
      const mapping = JSON.parse(mappingText) as Record<string, string>;
      return createResearchPortfolioImport(api, portfolio.id, { expectedRevision: portfolio.revision, worksheetKind: kind, fileName: file.name, mediaType: file.type === 'application/vnd.ms-excel' ? 'application/vnd.ms-excel' : 'text/csv', contentBase64: await fileBase64(file), schemaVersion: `${kind}-v1`, mapping });
    },
    onSuccess: (job) => setJobId(job.id),
  });
  const act = useMutation({
    mutationFn: ({ action, previewHash }: { action: 'preview' | 'apply' | 'pause' | 'resume' | 'cancel' | 'retry' | 'reconcile' | 'compensate'; previewHash?: string }) => actOnResearchPortfolioImport(api, portfolio.id, jobId!, action, { expectedRevision: ['apply', 'compensate'].includes(action) ? portfolio.revision : undefined, compensationPreviewHash: previewHash }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.import(portfolio.id, jobId ?? 'none') }),
        queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.detail(portfolio.id) }),
      ]);
    },
  });
  const jobDetail = detail.data;
  const compensationPreview = [...(jobDetail?.compensationReceipts ?? [])].reverse().find((receipt) => receipt.status === 'previewed');

  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  return <section className="rp-card">
    <h2>Recoverable CSV import</h2>
    <p className="rp-meta">Membership columns: target_kind,target_id; rules: readable_expression,expression_json; reviews: target_kind,target_id,reason. Custom headers can be mapped with JSON.</p>
    {canEdit ? <form className="rp-import-form" onSubmit={submit}>
      <label>Worksheet<select value={kind} onChange={(event) => setKind(event.target.value as ResearchPortfolioImportWorksheetKind)}><option value="membership">Membership</option><option value="rules">Rules</option><option value="reviews">Reviews</option></select></label>
      <label>CSV file<input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <label>Field mapping JSON<textarea value={mappingText} onChange={(event) => setMappingText(event.target.value)} rows={3} /></label>
      <button className="rp-button rp-button--primary" disabled={!file || create.isPending}>Create import job</button>
    </form> : <p>Import history is read-only.</p>}
    {create.error ? <p className="rp-error" role="alert">The import could not be admitted. Check the CSV, schema, mapping, and portfolio revision.</p> : null}
    {jobId && detail.isLoading ? <p className="rp-state">Loading durable import job…</p> : null}
    {detail.error ? <p className="rp-error" role="alert">The import job could not be loaded.</p> : null}
    {jobDetail ? <div className="rp-import-job">
      <div className="rp-row rp-row--spread"><strong>{jobDetail.fileName}</strong><span className={`rp-badge rp-badge--${jobDetail.status}`}>{jobDetail.status.replaceAll('_', ' ')}</span></div>
      <p className="rp-meta">SHA-256 {jobDetail.originalHash} · {jobDetail.rowCount} rows · {jobDetail.appliedCount} applied</p>
      {canEdit ? <div className="rp-action-group">
        {['mapped', 'failed', 'partial', 'previewed'].includes(jobDetail.status) ? <button className="rp-button" onClick={() => act.mutate({ action: 'preview' })}>Preview</button> : null}
        {['previewed', 'applying'].includes(jobDetail.status) ? <button className="rp-button rp-button--primary" onClick={() => act.mutate({ action: 'apply' })}>Apply selected rows</button> : null}
        {jobDetail.status === 'applying' ? <button className="rp-button" onClick={() => act.mutate({ action: 'pause' })}>Pause</button> : null}
        {jobDetail.status === 'paused' ? <button className="rp-button" onClick={() => act.mutate({ action: 'resume' })}>Resume</button> : null}
        {['failed', 'partial'].includes(jobDetail.status) ? <button className="rp-button" onClick={() => act.mutate({ action: 'retry' })}>Retry known failures</button> : null}
        {['unknown', 'needs_reconciliation'].includes(jobDetail.status) ? <button className="rp-button" onClick={() => act.mutate({ action: 'reconcile' })}>Reconcile unknown outcome</button> : null}
        {!['completed', 'compensated', 'cancelled'].includes(jobDetail.status) ? <button className="rp-button rp-button--danger" onClick={() => act.mutate({ action: 'cancel' })}>Cancel</button> : null}
        {['completed', 'partial'].includes(jobDetail.status) ? <button className="rp-button" onClick={() => act.mutate({ action: 'compensate' })}>Preview compensation</button> : null}
        {compensationPreview ? <button className="rp-button rp-button--danger" onClick={() => act.mutate({ action: 'compensate', previewHash: compensationPreview.previewHash })}>Commit compensation</button> : null}
      </div> : null}
      {act.error ? <p className="rp-error" role="alert">The action failed safely. Refresh the job before retrying.</p> : null}
      {jobDetail.rows.length ? <div className="rp-table-wrap" role="region" aria-label="Import row outcomes" tabIndex={0}><table className="rp-table"><thead><tr><th>Row</th><th>Target</th><th>Preview</th><th>Final</th><th>Reason</th></tr></thead><tbody>{jobDetail.rows.map((row) => <tr key={row.id}><td>{row.rowNumber}</td><td>{row.canonicalTargetKey ?? '—'}</td><td>{row.previewClassification ?? 'not previewed'}</td><td>{row.finalOutcome ?? 'pending'}</td><td>{row.finalReason ?? row.previewReason ?? '—'}</td></tr>)}</tbody></table></div> : null}
    </div> : null}
  </section>;
}
