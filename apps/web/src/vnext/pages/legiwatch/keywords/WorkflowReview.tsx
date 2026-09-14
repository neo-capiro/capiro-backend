import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect } from '../../../components/fields/index.js';
import { FOLDER_BASE, folderKey, folderError, type Folder } from '../bills/folder-api.js';
import { REPORT_BASE, reportKey, type Report } from '../reports/report-api.js';
import './keyword-review.css';
const B = '/intel-api/legiwatch/workflows';
const templates = [
  [
    'hearing_preparation',
    'Prepare for a hearing',
    'A calendar change involving this folder prepares a private hearing packet.',
  ],
  [
    'added_bill_review',
    'Review a newly tracked bill',
    'A committed addition creates a private review item linked to the bill.',
  ],
  [
    'published_review',
    'Review published changes',
    'Published evidence enters the existing reconciliation review.',
  ],
  [
    'report_review',
    'Prepare a report draft',
    'Published changes create an unapproved report draft for review.',
  ],
] as const;
type Template = {
  id: string;
  name: string;
  template: string;
  version: number;
  state: string;
  config: { folderIds: string[]; jurisdiction: string; sessionKey: string };
};
type Action = {
  id: string;
  template: string;
  state: string;
  reason: string | null;
  created_at: string;
  steps: { draftId?: string; reviewUrl?: string; recordRunId?: string; reportRunId?: string };
  input: { eventRevision?: number; triggerKey?: string };
};
export function WorkflowReview({ initialFolderId }: { initialFolderId?: string }) {
  const scope = useApiScope(),
    enabled = useIntelFeatureEnabled('legiwatch_internal_workflows_v1');
  return enabled ? (
    <Review key={scope + ':' + initialFolderId} scope={scope} initialFolderId={initialFolderId} />
  ) : null;
}
function Review({ scope, initialFolderId }: { scope: string; initialFolderId?: string }) {
  const api = useApi(),
    qc = useQueryClient(),
    [params, setParams] = useSearchParams(),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [folderId, setFolder] = useState(initialFolderId ?? params.get('folder') ?? ''),
    [jurisdiction, setJurisdiction] = useState(params.get('jurisdiction') ?? 'FL'),
    [sessionKey, setSession] = useState(params.get('session') ?? ''),
    [reportId, setReport] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reviewed, setReviewed] = useState(false);
  const folders = useQuery({
    queryKey: [...folderKey(scope), 'list'],
    queryFn: async () => (await api.get<Folder[]>(FOLDER_BASE)).data,
  });
  const reports = useQuery({
    queryKey: [...reportKey(scope), 'workflow-reports'],
    queryFn: async () => (await api.get<Report[]>(REPORT_BASE)).data,
  });
  const configs = useQuery({
    queryKey: ['lw-workflows', scope, folderId, 'templates'],
    enabled: !!folderId,
    queryFn: async () =>
      (await api.get<Template[]>(B + '/templates/' + encodeURIComponent(folderId))).data,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['lw-workflows', scope, folderId, 'history'],
    enabled: !!folderId,
    queryFn: async () =>
      (await api.get<Action[]>(B + '/history/' + encodeURIComponent(folderId))).data,
    retry: false,
  });
  const selection = useRef('');
  selection.current = [scope, folderId, jurisdiction, sessionKey].join(':');
  useEffect(() => {
    setReviewed(false);
    setError('');
    setNotice('');
  }, [folderId, jurisdiction, sessionKey]);
  async function perform(path: string, body: unknown, message: string) {
    const selected = selection.current;
    setBusy(true);
    setError('');
    try {
      await api.post(B + path, body);
      if (alive.current && selected === selection.current) {
        setNotice(message);
        await qc.invalidateQueries({ queryKey: ['lw-workflows', scope] });
      }
    } catch (e) {
      if (alive.current && selected === selection.current) setError(folderError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const current = folders.data?.find((f) => f.id === folderId);
  return (
    <section className="lw-keywords" aria-label="Follow-up workflows">
      <h3>Follow-up workflows</h3>
      <p>
        Choose an internal next step for this folder. Each action retains its source and output for
        review.
      </p>
      <div className="lw-keywords-controls">
        <CapiroSelect
          label="Folder"
          value={folderId}
          options={[
            { value: '', label: 'Select folder' },
            ...(folders.data ?? []).map((f) => ({
              value: f.id,
              label: f.name + (!f.canEdit ? ' · Read only' : ''),
            })),
          ]}
          onChange={(e) => setFolder(e.target.value)}
        />
        <CapiroInput
          label="Jurisdiction"
          value={jurisdiction}
          maxLength={2}
          onChange={(e) => setJurisdiction(e.target.value.toUpperCase())}
        />
        <CapiroInput
          label="Session"
          value={sessionKey}
          onChange={(e) => setSession(e.target.value)}
        />
        <CapiroSelect
          label="Report for draft handoff"
          value={reportId}
          options={[
            { value: '', label: 'Select a report' },
            ...(reports.data ?? [])
              .filter((r) => r.canEdit && r.folderIds.includes(folderId))
              .map((r) => ({ value: r.id, label: r.name })),
          ]}
          onChange={(e) => setReport(e.target.value)}
        />
      </div>
      <div className="lw-workflow-cards">
        {templates.map(([kind, title, description]) => (
          <article className="lw-keywords-rule" key={kind}>
            <h4>{title}</h4>
            <p>{description}</p>
            <CapiroButton
              size="compact"
              disabled={
                busy || !current?.canEdit || !sessionKey || (kind === 'report_review' && !reportId)
              }
              onClick={() =>
                void perform(
                  '/templates',
                  {
                    name: title,
                    template: kind,
                    config: { folderIds: [folderId], jurisdiction, sessionKey, reportId },
                  },
                  'Workflow saved paused. Review its scope before activation.',
                )
              }
            >
              Configure paused workflow
            </CapiroButton>
          </article>
        ))}
      </div>
      {error || configs.error || history.error ? (
        <p role="alert">{error || folderError(configs.error || history.error)}</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <label>
        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />{' '}
        I reviewed this folder, session and internal outputs. Start with new changes.
      </label>
      {configs.data
        ?.filter(
          (c) => c.config.jurisdiction === jurisdiction && c.config.sessionKey === sessionKey,
        )
        .map((c) => (
          <article key={c.id} className="lw-keywords-rule">
            <h4>{c.name}</h4>
            <p>
              {c.state} · {c.config.jurisdiction} {c.config.sessionKey} · version {c.version}
            </p>
            <CapiroButton
              size="compact"
              disabled={busy || (!reviewed && c.state !== 'active')}
              onClick={() =>
                void perform(
                  '/templates/' + c.id + '/activation',
                  {
                    expectedVersion: c.version,
                    enabled: c.state !== 'active',
                    baseline: 'from_now',
                    reviewed,
                  },
                  c.state === 'active'
                    ? 'Workflow paused. Existing work is retained.'
                    : 'Workflow activated for new changes.',
                )
              }
            >
              {c.state === 'active' ? 'Pause' : 'Activate from now'}
            </CapiroButton>
          </article>
        ))}
      <h4>Run history</h4>
      {!history.data?.length ? <p>No actions in this folder yet.</p> : null}
      {history.data?.map((a) => (
        <article
          key={a.id}
          className="lw-keywords-run"
          aria-current={params.get('workflowAction') === a.id ? 'true' : undefined}
        >
          <h4>
            {templates.find((t) => t[0] === a.template)?.[1] ?? 'Workflow review'} · {a.state}
          </h4>
          <p>
            {new Date(a.created_at).toLocaleString()}
            {a.input.eventRevision != null ? ' · source revision ' + a.input.eventRevision : ''}
          </p>
          {a.reason ? <p>{a.reason.toLowerCase().replaceAll('_', ' ')}</p> : null}
          {a.steps.draftId ? (
            <Link to={'/workspace/draft/' + encodeURIComponent(a.steps.draftId)}>
              Open preparation draft
            </Link>
          ) : null}
          {a.steps.reviewUrl?.startsWith('/legiwatch') ? (
            <Link to={a.steps.reviewUrl}>Open review output</Link>
          ) : null}
          {!['complete', 'paused', 'stale', 'denied'].includes(a.state) ? (
            <CapiroButton
              size="compact"
              disabled={busy}
              onClick={() =>
                void perform(
                  '/actions/' + a.id + '/retry',
                  {},
                  'Action resumed; inspect its saved output.',
                )
              }
            >
              Resume remaining steps
            </CapiroButton>
          ) : null}
          <CapiroButton
            size="compact"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('workflowAction', a.id);
              setParams(next);
            }}
          >
            Link to this action
          </CapiroButton>
        </article>
      ))}
    </section>
  );
}
