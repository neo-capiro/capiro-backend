import { ResearchPortfolioWatchConversionPanel } from './ResearchPortfolioWatchConversionPanel.js';
import {
  emptyOutputWorkspace,
  readOutputWorkspace,
  persistOutputWorkspace,
  outputWorkspaceKey,
  type RetainedOutputWorkspace,
} from './research-portfolio-output-draft.js';
import {
  ResearchPortfolioAuthorityBoundary,
  useResearchPortfolioAuthorityScope,
} from './research-portfolio-authority.js';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  ResearchPortfolioAnalyticsDto,
  ResearchPortfolioChangeDto,
  ResearchPortfolioClientFileReceiptDto,
  ResearchPortfolioDetailDto,
  ResearchPortfolioEventStateAction,
  ResearchPortfolioOutputJobDto,
  ResearchPortfolioSnapshotDto,
  ResearchPortfolioSubscriptionCadence,
  ResearchPortfolioSubscriptionChannel,
  ResearchPortfolioSubscriptionTargetKind,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import {
  actOnResearchPortfolioOutput,
  createResearchPortfolioOutput,
  createResearchPortfolioSnapshot,
  createResearchPortfolioSubscription,
  downloadResearchPortfolioOutput,
  getResearchPortfolioAnalytics,
  getResearchPortfolioOutputJob,
  getResearchPortfolioSnapshot,
  listResearchPortfolioChanges,
  listResearchPortfolioSnapshots,
  listResearchPortfolioSubscriptions,
  researchPortfolioKeys,
  newIdempotencyKey,
  saveResearchPortfolioOutputToClient,
  updateResearchPortfolioChangeState,
  updateResearchPortfolioSubscription,
} from './research-portfolios-api.js';

const TARGET_KINDS: readonly ResearchPortfolioSubscriptionTargetKind[] = [
  'portfolio',
  'program',
  'program_element',
  'project',
  'budget_line',
  'award',
  'client',
  'rule',
  'review',
];

function basisLabel(analytics: ResearchPortfolioAnalyticsDto): string {
  const basis =
    analytics.totals[0]?.basis ?? analytics.contributions.find((item) => item.basis)?.basis;
  if (!basis) return 'No compatible financial basis';
  return [
    `FY${basis.fundingFiscalYear}`,
    basis.requestEdition,
    basis.stage,
    basis.metric.replaceAll('_', ' '),
    basis.unit.replaceAll('_', ' '),
    basis.knownAt ? `known ${new Date(basis.knownAt).toLocaleDateString()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ResearchPortfolioProjectionView({
  analytics,
  heading = 'Qualified analytics',
}: {
  analytics: ResearchPortfolioAnalyticsDto;
  heading?: string;
}) {
  return (
    <div className="rp-projection" data-testid="research-portfolio-projection">
      <div className="rp-row rp-row--spread">
        <div>
          <h3>{heading}</h3>
          <p className="rp-meta">
            {basisLabel(analytics)} · portfolio revision {analytics.portfolioRevision}
          </p>
        </div>
        <span className={`rp-badge rp-badge--${analytics.availability}`}>
          {analytics.availability}
        </span>
      </div>
      <dl className="rp-coverage" aria-label="Analytics coverage">
        <div>
          <dt>Eligible members</dt>
          <dd>{analytics.coverage.eligibleMembers}</dd>
        </div>
        <div>
          <dt>Supported</dt>
          <dd>{analytics.coverage.supportedMembers}</dd>
        </div>
        <div>
          <dt>Included facts</dt>
          <dd>{analytics.coverage.includedContributions}</dd>
        </div>
        <div>
          <dt>Overlap removed</dt>
          <dd>{analytics.coverage.overlapContributions}</dd>
        </div>
        <div>
          <dt>Unavailable</dt>
          <dd>{analytics.coverage.unavailableMembers}</dd>
        </div>
      </dl>
      {analytics.totals.length ? (
        <div className="rp-table-wrap">
          <table className="rp-table rp-table--compact">
            <caption>Compatible qualified totals</caption>
            <thead>
              <tr>
                <th scope="col">Basis</th>
                <th scope="col">Exact value</th>
                <th scope="col">Contributions</th>
              </tr>
            </thead>
            <tbody>
              {analytics.totals.map((total, index) => (
                <tr
                  key={`${total.basis.fundingFiscalYear}-${total.basis.metric}-${total.basis.unit}-${index}`}
                >
                  <td>
                    FY{total.basis.fundingFiscalYear} · {total.basis.stage} ·{' '}
                    {total.basis.metric.replaceAll('_', ' ')}
                  </td>
                  <td className="rp-number">
                    {total.value} {total.basis.unit.replaceAll('_', ' ')}
                  </td>
                  <td>{total.contributionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rp-unavailable" role="status">
          No qualified compatible total is available. Missing, withheld, and unsupported values are
          not counted as zero.
        </p>
      )}
      <div className="rp-table-wrap">
        <table className="rp-table">
          <caption>Contribution and exclusion ledger</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Disposition</th>
              <th scope="col">Exact value</th>
              <th scope="col">Reason and evidence</th>
            </tr>
          </thead>
          <tbody>
            {analytics.contributions.map((contribution) => (
              <tr key={contribution.contributionId}>
                <td>
                  <strong>{contribution.label || contribution.targetId}</strong>
                  <br />
                  <span className="rp-meta">{contribution.targetKind.replaceAll('_', ' ')}</span>
                </td>
                <td>
                  <span className={`rp-badge rp-badge--${contribution.disposition}`}>
                    {contribution.disposition}
                  </span>
                </td>
                <td className="rp-number">{contribution.value ?? '—'}</td>
                <td>
                  {contribution.reason}
                  <br />
                  <span className="rp-meta">
                    {contribution.sourceRevisionIds.length} source revision
                    {contribution.sourceRevisionIds.length === 1 ? '' : 's'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {analytics.limitations.length ? (
        <details className="rp-limitations">
          <summary>Limitations ({analytics.limitations.length})</summary>
          <ul>
            {analytics.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function ResearchPortfolioAnalyticsPanel({
  portfolio,
  canCreateSnapshot,
}: {
  portfolio: ResearchPortfolioDetailDto;
  canCreateSnapshot: boolean;
}) {
  return (
    <section className="rp-phase9" aria-label="Changes, analytics, snapshots, and outputs">
      <ChangesAndSubscriptions portfolio={portfolio} />
      <AnalyticsAndSnapshots portfolio={portfolio} canCreateSnapshot={canCreateSnapshot} />
      <DurableOutputs portfolio={portfolio} />
    </section>
  );
}

export function ChangesAndSubscriptions(props: { portfolio: ResearchPortfolioDetailDto }) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <ChangesAndSubscriptionsContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function ChangesAndSubscriptionsContent({ portfolio }: { portfolio: ResearchPortfolioDetailDto }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [targetKind, setTargetKind] =
    useState<ResearchPortfolioSubscriptionTargetKind>('portfolio');
  const [targetId, setTargetId] = useState(portfolio.id);
  const [channel, setChannel] = useState<ResearchPortfolioSubscriptionChannel>('in_app');
  const [cadence, setCadence] = useState<ResearchPortfolioSubscriptionCadence>('immediate');
  useEffect(() => {
    if (targetKind === 'portfolio') setTargetId(portfolio.id);
  }, [portfolio.id, targetKind]);
  const changes = useQuery({
    queryKey: researchPortfolioKeys.changes(portfolio.id),
    queryFn: () => listResearchPortfolioChanges(api, portfolio.id),
  });
  const subscriptions = useQuery({
    queryKey: researchPortfolioKeys.subscriptions(portfolio.id),
    queryFn: () => listResearchPortfolioSubscriptions(api, portfolio.id),
  });
  const refreshChanges = () =>
    queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.changes(portfolio.id) });
  const refreshSubscriptions = () =>
    queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.subscriptions(portfolio.id) });
  const changeState = useMutation({
    mutationFn: ({
      change,
      action,
    }: {
      change: ResearchPortfolioChangeDto;
      action: ResearchPortfolioEventStateAction;
    }) =>
      updateResearchPortfolioChangeState(api, portfolio.id, change.id, {
        action,
        ...(change.state ? { expectedRevision: change.state.revision } : {}),
      }),
    onSuccess: refreshChanges,
  });
  const createSubscription = useMutation({
    mutationFn: () =>
      createResearchPortfolioSubscription(api, portfolio.id, {
        targetKind,
        targetId: targetId.trim(),
        channel,
        cadence,
      }),
    onSuccess: refreshSubscriptions,
  });
  const toggleSubscription = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      updateResearchPortfolioSubscription(api, portfolio.id, id, { active }),
    onSuccess: refreshSubscriptions,
  });

  return (
    <section className="rp-card" id="research-portfolio-tour-changes">
      <div className="rp-row rp-row--spread">
        <div>
          <h2>Changes and watches</h2>
          <p className="rp-meta">
            Change state is personal. Watches begin from their recorded baseline.
          </p>
        </div>
        <span className="rp-count">{changes.data?.items.length ?? 0}</span>
      </div>
      <div className="rp-phase9-grid">
        <div>
          {changes.isLoading ? <p className="rp-state">Loading changes…</p> : null}
          {changes.error ? (
            <p className="rp-error" role="alert">
              Changes could not be loaded.
            </p>
          ) : null}
          {!changes.isLoading && !changes.data?.items.length ? (
            <p className="rp-empty">No material changes have been recorded.</p>
          ) : null}
          <ol className="rp-change-list">
            {changes.data?.items.map((change) => (
              <li
                key={change.id}
                className={
                  change.state?.dismissedAt ? 'rp-change rp-change--dismissed' : 'rp-change'
                }
              >
                <div>
                  <strong>{change.eventKind.replaceAll('_', ' ')}</strong>
                  <p className="rp-meta">
                    Revision {change.aggregateRevision} ·{' '}
                    {new Date(change.occurredAt).toLocaleString()}
                  </p>
                </div>
                <div className="rp-action-group">
                  {!change.state?.seenAt ? (
                    <button
                      className="rp-button"
                      onClick={() => changeState.mutate({ change, action: 'seen' })}
                    >
                      Mark seen
                    </button>
                  ) : null}
                  {!change.state?.acknowledgedAt ? (
                    <button
                      className="rp-button"
                      onClick={() => changeState.mutate({ change, action: 'acknowledged' })}
                    >
                      Acknowledge
                    </button>
                  ) : null}
                  {!change.state?.dismissedAt ? (
                    <button
                      className="rp-button"
                      onClick={() => changeState.mutate({ change, action: 'dismissed' })}
                    >
                      Dismiss
                    </button>
                  ) : null}
                  {change.state && (change.state.acknowledgedAt || change.state.dismissedAt) ? (
                    <button
                      className="rp-button"
                      onClick={() => changeState.mutate({ change, action: 'undo' })}
                    >
                      Undo state
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {changeState.error ? (
            <p className="rp-error" role="alert">
              The personal change state could not be updated. Reload before retrying.
            </p>
          ) : null}
        </div>
        <div className="rp-watch-panel">
          <ResearchPortfolioWatchConversionPanel
            portfolioId={portfolio.id}
            canEdit={
              ['owner', 'editor'].includes(portfolio.myRole) && portfolio.lifecycle === 'active'
            }
          />
          <h3>Explicit watches</h3>
          <form
            className="rp-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (targetId.trim()) createSubscription.mutate();
            }}
          >
            <label>
              Target type
              <select
                value={targetKind}
                onChange={(event) =>
                  setTargetKind(event.target.value as ResearchPortfolioSubscriptionTargetKind)
                }
              >
                {TARGET_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {value.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Target ID
              <input
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                readOnly={targetKind === 'portfolio'}
                required
              />
            </label>
            <label>
              Channel
              <select
                value={channel}
                onChange={(event) =>
                  setChannel(event.target.value as ResearchPortfolioSubscriptionChannel)
                }
              >
                <option value="in_app">In app</option>
                <option value="email" disabled>
                  Email (not configured)
                </option>
              </select>
            </label>
            <label>
              Cadence
              <select
                value={cadence}
                onChange={(event) =>
                  setCadence(event.target.value as ResearchPortfolioSubscriptionCadence)
                }
              >
                <option value="immediate">Immediate</option>
                <option value="daily" disabled>
                  Daily (not configured)
                </option>
                <option value="weekly" disabled>
                  Weekly (not configured)
                </option>
              </select>
            </label>
            <button
              className="rp-button rp-button--primary"
              disabled={createSubscription.isPending || !targetId.trim()}
            >
              Create watch
            </button>
          </form>
          <ul className="rp-list">
            {subscriptions.data?.map((subscription) => (
              <li className="rp-list__item" key={subscription.id}>
                <div>
                  <strong>{subscription.targetKind.replaceAll('_', ' ')}</strong>
                  <p>
                    {subscription.channel.replaceAll('_', ' ')} · {subscription.cadence} · baseline
                    revision {subscription.baselineRevision}
                  </p>
                </div>
                <button
                  className="rp-button"
                  disabled={toggleSubscription.isPending}
                  onClick={() =>
                    toggleSubscription.mutate({ id: subscription.id, active: !subscription.active })
                  }
                >
                  {subscription.active ? 'Pause' : 'Resume'}
                </button>
              </li>
            ))}
          </ul>
          {subscriptions.error || createSubscription.error || toggleSubscription.error ? (
            <p className="rp-error" role="alert">
              The watch preference could not be saved.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function AnalyticsAndSnapshots(props: {
  portfolio: ResearchPortfolioDetailDto;
  canCreateSnapshot: boolean;
}) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <AnalyticsAndSnapshotsContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function AnalyticsAndSnapshotsContent({
  portfolio,
  canCreateSnapshot,
}: {
  portfolio: ResearchPortfolioDetailDto;
  canCreateSnapshot: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [snapshotName, setSnapshotName] = useState('');
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const analytics = useQuery({
    queryKey: researchPortfolioKeys.analytics(portfolio.id),
    queryFn: () => getResearchPortfolioAnalytics(api, portfolio.id),
  });
  const snapshots = useQuery({
    queryKey: researchPortfolioKeys.snapshots(portfolio.id),
    queryFn: () => listResearchPortfolioSnapshots(api, portfolio.id),
  });
  const snapshot = useQuery({
    queryKey: researchPortfolioKeys.snapshot(portfolio.id, selectedSnapshotId ?? ''),
    queryFn: () => getResearchPortfolioSnapshot(api, portfolio.id, selectedSnapshotId!),
    enabled: Boolean(selectedSnapshotId),
  });
  const createSnapshot = useMutation({
    mutationFn: () =>
      createResearchPortfolioSnapshot(api, portfolio.id, {
        name: snapshotName.trim(),
        expectedRevision: portfolio.revision,
      }),
    onSuccess: async (created) => {
      setSnapshotName('');
      setSelectedSnapshotId(created.id);
      queryClient.setQueryData(researchPortfolioKeys.snapshot(portfolio.id, created.id), created);
      await queryClient.invalidateQueries({
        queryKey: researchPortfolioKeys.snapshots(portfolio.id),
      });
    },
  });
  return (
    <section className="rp-card" id="research-portfolio-tour-analytics">
      <h2>Analytics and immutable snapshots</h2>
      {analytics.isLoading ? <p className="rp-state">Calculating qualified analytics…</p> : null}
      {analytics.error ? (
        <p className="rp-error" role="alert">
          Qualified analytics are unavailable. No total has been inferred.
        </p>
      ) : null}
      {analytics.data ? <ResearchPortfolioProjectionView analytics={analytics.data} /> : null}
      <div className="rp-snapshot-workspace">
        <div>
          <h3>Snapshot history</h3>
          {canCreateSnapshot ? (
            <form
              className="rp-form rp-form--snapshot"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                if (snapshotName.trim()) createSnapshot.mutate();
              }}
            >
              <label>
                Snapshot name
                <input
                  value={snapshotName}
                  onChange={(event) => setSnapshotName(event.target.value)}
                  placeholder="Committee mark review"
                  required
                />
              </label>
              <button
                className="rp-button rp-button--primary"
                disabled={!snapshotName.trim() || createSnapshot.isPending}
              >
                Create from revision {portfolio.revision}
              </button>
            </form>
          ) : (
            <p className="rp-meta">
              Snapshot creation is unavailable in read-only portfolio state.
            </p>
          )}
          <ul className="rp-list">
            {snapshots.data?.map((item) => (
              <li className="rp-list__item" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <p>
                    Revision {item.portfolioRevision} · {new Date(item.capturedAt).toLocaleString()}
                  </p>
                  <small className="rp-hash">{item.contentHash}</small>
                </div>
                <button className="rp-button" onClick={() => setSelectedSnapshotId(item.id)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
          {!snapshots.isLoading && !snapshots.data?.length ? (
            <p className="rp-empty">No immutable snapshots yet.</p>
          ) : null}
          {snapshots.error || createSnapshot.error ? (
            <p className="rp-error" role="alert">
              The snapshot operation failed. Refresh before retrying.
            </p>
          ) : null}
        </div>
        {selectedSnapshotId ? (
          <aside className="rp-snapshot-detail" aria-label="Opened snapshot">
            <div className="rp-row rp-row--spread">
              <h3>Opened snapshot</h3>
              <button className="rp-button" onClick={() => setSelectedSnapshotId(null)}>
                Close
              </button>
            </div>
            {snapshot.isLoading ? <p className="rp-state">Opening pinned projection…</p> : null}
            {snapshot.error ? (
              <p className="rp-error" role="alert">
                This snapshot is unavailable under your current access.
              </p>
            ) : null}
            {snapshot.data ? <SnapshotReceipt snapshot={snapshot.data} /> : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function SnapshotReceipt({ snapshot }: { snapshot: ResearchPortfolioSnapshotDto }) {
  return (
    <div>
      <p>
        <strong>{snapshot.name}</strong>
        <br />
        <span className="rp-meta">
          Captured {new Date(snapshot.capturedAt).toLocaleString()} · revision{' '}
          {snapshot.portfolioRevision}
        </span>
      </p>
      <p className="rp-meta rp-hash">Content hash {snapshot.contentHash}</p>
      <p className="rp-meta">
        {snapshot.membership.length} pinned members · {snapshot.versions.sources.length} pinned
        source versions · {snapshot.calculationVersion}
      </p>
      <ResearchPortfolioProjectionView
        analytics={snapshot.projection}
        heading="Pinned projection"
      />
    </div>
  );
}

export function DurableOutputs(props: { portfolio: ResearchPortfolioDetailDto }) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <DurableOutputsContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function DurableOutputsContent({ portfolio }: { portfolio: ResearchPortfolioDetailDto }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const scope = useResearchPortfolioAuthorityScope()!;
  const storageKey = outputWorkspaceKey(scope, portfolio.id);
  const [initial] = useState(() => {
    try {
      return { value: readOutputWorkspace(storageKey), error: null as string | null };
    } catch (error) {
      return { value: emptyOutputWorkspace(), error: (error as Error).message };
    }
  });
  const [workspace, setWorkspace] = useState<RetainedOutputWorkspace>(initial.value);
  const [storageError, setStorageError] = useState<string | null>(initial.error);
  const [snapshotId, setSnapshotId] = useState(workspace.create?.payload.snapshotId ?? '');
  const [includeSourceAppendix, setIncludeSourceAppendix] = useState(
    workspace.create?.payload.includeSourceAppendix ?? true,
  );
  const [clientId, setClientId] = useState(
    workspace.filing?.clientId ?? portfolio.clientLinks[0]?.clientId ?? '',
  );
  const [receipt, setReceipt] = useState<ResearchPortfolioClientFileReceiptDto | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  function retain(value: RetainedOutputWorkspace) {
    persistOutputWorkspace(storageKey, value);
    setWorkspace(value);
    setStorageError(null);
  }
  const snapshots = useQuery({
    queryKey: researchPortfolioKeys.snapshots(portfolio.id),
    queryFn: () => listResearchPortfolioSnapshots(api, portfolio.id),
  });
  const output = useQuery({
    queryKey: researchPortfolioKeys.outputJob(portfolio.id, workspace.jobId ?? ''),
    queryFn: () => getResearchPortfolioOutputJob(api, portfolio.id, workspace.jobId!),
    enabled: Boolean(workspace.jobId),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.status ?? '') ? 2_000 : false,
  });
  const createdJob = useMutation({
    mutationFn: async () => {
      if (initial.error) throw Error(initial.error);
      if (workspace.filing && !workspace.filing.confirmed)
        throw Error('Reconcile the retained client filing before building another output');
      const attempt = workspace.create ?? {
        operationKey: newIdempotencyKey('output-create'),
        payload: {
          snapshotId: snapshotId || null,
          selectedSections: ['analytics', 'contributions', 'sources'],
          includeSourceAppendix,
          format: 'csv' as const,
        },
      };
      try {
        retain({
          ...workspace,
          create: attempt,
          filing: workspace.filing?.confirmed ? null : workspace.filing,
        });
      } catch {
        setStorageError(
          'The exact output request could not be retained. No request was sent. Free browser storage and retry.',
        );
        throw Error('Output storage unavailable');
      }
      return createResearchPortfolioOutput(
        api,
        portfolio.id,
        attempt.payload,
        attempt.operationKey,
      );
    },
    onSuccess: (job) => {
      const next = { ...workspace, create: null, filing: null, jobId: job.id };
      setWorkspace(next);
      setReceipt(null);
      queryClient.setQueryData(researchPortfolioKeys.outputJob(portfolio.id, job.id), job);
      try {
        persistOutputWorkspace(storageKey, next);
        setStorageError(null);
      } catch {
        setStorageError(
          'The server accepted this output, but its recovery handle could not be retained. Keep this page open and record the job ID.',
        );
      }
    },
  });
  const act = useMutation({
    mutationFn: ({
      job,
      action,
    }: {
      job: ResearchPortfolioOutputJobDto;
      action: 'cancel' | 'retry' | 'reconcile';
    }) => actOnResearchPortfolioOutput(api, portfolio.id, job.id, action),
    onSuccess: (job) =>
      queryClient.setQueryData(researchPortfolioKeys.outputJob(portfolio.id, job.id), job),
  });
  const save = useMutation({
    mutationFn: async ({ artifactId }: { artifactId: string }) => {
      if (initial.error) throw Error(initial.error);
      const attempt = workspace.filing ?? {
        operationKey: newIdempotencyKey('output-client-file'),
        artifactId,
        clientId,
        confirmed: false,
      };
      try {
        retain({ ...workspace, filing: attempt });
      } catch {
        setStorageError(
          'The exact filing request could not be retained. No filing was sent. Free browser storage and retry.',
        );
        throw Error('Filing storage unavailable');
      }
      const saved = await saveResearchPortfolioOutputToClient(
        api,
        portfolio.id,
        attempt.artifactId,
        { clientId: attempt.clientId },
        attempt.operationKey,
      );
      return { saved, attempt };
    },
    onSuccess: ({ saved, attempt }) => {
      setReceipt(saved);
      const next = { ...workspace, filing: { ...attempt, confirmed: true } };
      setWorkspace(next);
      try {
        persistOutputWorkspace(storageKey, next);
        setStorageError(null);
      } catch {
        setStorageError(
          'The server confirmed this filing, but its retry identity could not be retained. Keep this receipt open.',
        );
      }
    },
  });
  const job = output.data ?? createdJob.data;
  const linkedClient = useMemo(
    () => portfolio.clientLinks.find((item) => item.clientId === clientId),
    [clientId, portfolio.clientLinks],
  );

  async function download() {
    if (!job?.artifact) return;
    setDownloadError(null);
    try {
      const blob = await downloadResearchPortfolioOutput(api, portfolio.id, job.artifact);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = job.artifact.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
    } catch {
      setDownloadError('The output is no longer downloadable under your current access.');
    }
  }

  return (
    <section className="rp-card" id="research-portfolio-tour-outputs">
      <div className="rp-row rp-row--spread">
        <div>
          <h2>Durable CSV output</h2>
          <p className="rp-meta">
            The stored job, attempts, exact bytes, and client-file receipt remain available after
            refresh.
          </p>
        </div>
        {job ? (
          <span className={`rp-badge rp-badge--${job.status}`}>
            {job.status.replaceAll('_', ' ')}
          </span>
        ) : null}
      </div>
      <form
        className="rp-form rp-form--output"
        onSubmit={(event) => {
          event.preventDefault();
          createdJob.mutate();
        }}
      >
        <label>
          Projection
          <select
            disabled={
              Boolean(workspace.create) || Boolean(workspace.filing && !workspace.filing.confirmed)
            }
            value={snapshotId}
            onChange={(event) => setSnapshotId(event.target.value)}
          >
            <option value="">Current qualified projection</option>
            {snapshots.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · revision {item.portfolioRevision}
              </option>
            ))}
          </select>
        </label>
        <label className="rp-checkbox">
          <input
            type="checkbox"
            disabled={
              Boolean(workspace.create) || Boolean(workspace.filing && !workspace.filing.confirmed)
            }
            checked={includeSourceAppendix}
            onChange={(event) => setIncludeSourceAppendix(event.target.checked)}
          />{' '}
          Include source appendix
        </label>
        <button
          className="rp-button rp-button--primary"
          disabled={
            createdJob.isPending ||
            Boolean(initial.error) ||
            Boolean(workspace.filing && !workspace.filing.confirmed)
          }
        >
          {workspace.create ? 'Retry exact CSV request' : 'Build CSV'}
        </button>
      </form>
      {storageError ? (
        <p className="rp-error" role="alert">
          {storageError}
        </p>
      ) : null}
      {workspace.create ? (
        <p className="rp-notice">
          The prior output request may have committed. Its original payload and key are retained;
          retry to recover it.
        </p>
      ) : null}
      {createdJob.error || output.error ? (
        <p className="rp-error" role="alert">
          The output job could not be created or restored.
        </p>
      ) : null}
      {job ? (
        <div className="rp-output-receipt">
          <p>
            <strong>Job {job.id}</strong>
            <br />
            <span className="rp-meta">
              {job.attemptCount} attempt{job.attemptCount === 1 ? '' : 's'} · updated{' '}
              {new Date(job.updatedAt).toLocaleString()}
            </span>
          </p>
          {job.lastError ? (
            <p className="rp-error">
              {job.lastErrorCode ?? 'Output error'}: {job.lastError}
            </p>
          ) : null}
          <div className="rp-action-group">
            {['queued', 'running'].includes(job.status) ? (
              <button className="rp-button" onClick={() => act.mutate({ job, action: 'cancel' })}>
                Cancel
              </button>
            ) : null}
            {['failed', 'outcome_unknown', 'cancelled'].includes(job.status) ? (
              <button className="rp-button" onClick={() => act.mutate({ job, action: 'retry' })}>
                Retry
              </button>
            ) : null}
            {job.status === 'outcome_unknown' ? (
              <button
                className="rp-button"
                onClick={() => act.mutate({ job, action: 'reconcile' })}
              >
                Reconcile outcome
              </button>
            ) : null}
            {job.artifact ? (
              <button className="rp-button rp-button--primary" onClick={() => void download()}>
                Download {job.artifact.fileName}
              </button>
            ) : null}
          </div>
          {job.artifact ? (
            <p className="rp-meta rp-hash">
              SHA-256 {job.artifact.contentHash} · {job.artifact.byteSize} bytes
            </p>
          ) : null}
          {downloadError ? (
            <p className="rp-error" role="alert">
              {downloadError}
            </p>
          ) : null}
          {job.artifact && portfolio.clientLinks.length ? (
            <div className="rp-client-file-save">
              <label>
                Authorized destination
                <select
                  disabled={Boolean(workspace.filing)}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                >
                  {portfolio.clientLinks.map((client) => (
                    <option key={client.clientId} value={client.clientId}>
                      {client.clientName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="rp-button"
                disabled={!clientId || save.isPending || Boolean(initial.error) || Boolean(receipt)}
                onClick={() => save.mutate({ artifactId: job.artifact!.id })}
              >
                {workspace.filing
                  ? 'Reconcile exact client filing'
                  : `Save exact file to ${linkedClient?.clientName ?? 'Client Files'}`}
              </button>
            </div>
          ) : null}
          {save.error ? (
            <p className="rp-error" role="alert">
              The client filing outcome is unconfirmed. Its original artifact, destination and key
              are retained. Reconcile the same request; no replacement upload is started.
            </p>
          ) : null}
          {receipt ? (
            <p className="rp-notice">
              Saved as {receipt.attachmentName} · scan {receipt.scanStatus ?? 'pending'} ·{' '}
              <Link to={receipt.openPath}>Open in Client Files</Link>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rp-empty">No output job has been created in this browser.</p>
      )}
    </section>
  );
}
