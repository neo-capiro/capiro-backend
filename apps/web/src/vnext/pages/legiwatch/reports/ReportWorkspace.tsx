import { BriefingWorkspace } from '../editorial/BriefingWorkspace.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeywordReview, KEYWORD_FEATURE } from '../keywords/KeywordReview.js';
import { WorkflowReview } from '../keywords/WorkflowReview.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { FOLDER_BASE, folderError, type Folder } from '../bills/folder-api.js';
import {
  REPORT_BASE as B,
  reportKey,
  useReportsFlag,
  defaultSettings,
  statusLabel,
  type Report,
  type Run,
  type Directory,
  type Selection,
  type Composition,
  type Subscription,
  type Occurrence,
  type Rule,
  type Staged,
  type Contact,
  type List,
  type Settings,
} from './report-api.js';
import './reports.css';
import { RecordBriefSelection, type SelectedRecordBrief } from './RecordBriefSelection.js';

const option = (value: string, label = value) => ({ value, label });
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const formatTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minutesOf = (time: string) => Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]);
const initialTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="lw-reports-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="lw-reports-empty">{children}</p>;
}
function Download({ run }: { run: Run }) {
  return (
    <CapiroButton
      size="compact"
      disabled={!run.rendered}
      onClick={() => {
        const url = URL.createObjectURL(
          new Blob([run.rendered!.html], { type: 'text/html;charset=utf-8' }),
        );
        const a = document.createElement('a');
        a.href = url;
        a.download = `legislative-report-${run.cutoff}.html`;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      Download HTML report
    </CapiroButton>
  );
}
export function ReportWorkspace({
  initialTab = 'reports',
  initialFolderId,
  onClose,
}: {
  initialTab?: string;
  initialFolderId?: string;
  /**
   * Existing dialog close callback, present only when the workspace is
   * composed inside a modal mount (FolderBillsTab). Renders the reference
   * footer Close — a relocation of the dialog's existing close action, not a
   * new control. Omitted on full-page mounts, where no footer appears.
   */
  onClose?: () => void;
}) {
  const flag = useReportsFlag();
  if (!flag.enabled) return null;
  return (
    <Workspace
      key={flag.scope}
      scope={flag.scope}
      deliveryEnabled={flag.deliveryEnabled}
      initialTab={initialTab}
      initialFolderId={initialFolderId}
      onClose={onClose}
    />
  );
}
function Workspace({
  scope,
  deliveryEnabled,
  initialTab,
  initialFolderId,
  onClose,
}: {
  scope: string;
  deliveryEnabled: boolean;
  initialTab: string;
  initialFolderId?: string;
  onClose?: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const keywordsEnabled = useIntelFeatureEnabled(KEYWORD_FEATURE);
  const workflowsEnabled = useIntelFeatureEnabled('legiwatch_internal_workflows_v1');
  const api = useApi(),
    qc = useQueryClient(),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [tab, setLocalTab] = useState(params.get('reportView') ?? initialTab),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const setTab = (value: string) => {
    setLocalTab(value);
    const next = new URLSearchParams(params);
    next.set('reportView', value);
    setParams(next);
  };
  useEffect(() => {
    setLocalTab(params.get('reportView') ?? initialTab);
  }, [params, initialTab]);
  const [editing, setEditing] = useState<Report | null>(null),
    [run, setRun] = useState<Run | null>(null);
  const [compose, setCompose] = useState(false),
    [cutoff, setCutoff] = useState(today),
    [audience, setAudience] = useState('external');
  const [schedule, setSchedule] = useState<Subscription | 'new' | null>(null),
    [rule, setRule] = useState<Rule | null>(null);
  const [contact, setContact] = useState<Contact | 'new' | null>(null),
    [list, setList] = useState<List | 'new' | null>(null);
  const query = <T,>(path: string) => ({
    queryKey: [...reportKey(scope), path],
    queryFn: async () => (await api.get<T>(`${B}${path}`)).data,
  });
  const reports = useQuery(query<Report[]>('')),
    history = useQuery({ ...query<Run[]>('/history'), enabled: tab === 'history' });
  const subscriptions = useQuery({
    ...query<Subscription[]>('/subscriptions'),
    enabled: tab === 'updates',
  });
  const rules = useQuery({ ...query<Rule[]>('/rules'), enabled: tab === 'alerts' });
  const directory = useQuery(query<Directory>('/recipients'));
  const staged = useQuery({ ...query<Staged[]>('/staged'), enabled: tab === 'imports' });
  const folders = useQuery({
    queryKey: [...reportKey(scope), 'folders'],
    queryFn: async () => (await api.get<Folder[]>(FOLDER_BASE)).data,
  });
  async function action<T>(work: () => Promise<T>, done?: (value: T) => void, success = '') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await work();
      if (alive.current) {
        setNotice(success);
        done?.(value);
        await qc.invalidateQueries({ queryKey: reportKey(scope) });
      }
    } catch (e) {
      if (alive.current) setError(folderError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const loadRun = (id: string) =>
    action(async () => (await api.get<Run>(`${B}/runs/${id}`)).data, setRun);
  const deepRun = useQuery({
    ...query<Run>('/runs/' + encodeURIComponent(params.get('reportRun') ?? '')),
    enabled: !!params.get('reportRun'),
    retry: false,
  });
  useEffect(() => {
    if (deepRun.data) setRun(deepRun.data);
  }, [deepRun.data]);
  const newReport = () => {
    const f = folders.data?.find((f) => f.id === initialFolderId);
    setEditing({
      id: '',
      name: '',
      folderIds: f ? [f.id] : [],
      jurisdiction: f?.jurisdiction ?? 'FL',
      sessionKey: f?.defaultSession ?? '',
      version: 0,
      settings: { ...defaultSettings },
    });
  };
  const mainViews: Array<[string, string]> = [
    ['reports', 'Report library'],
    ['briefings', 'Client briefings'],
    ['history', 'Run history'],
  ];
  const moreViews: Array<[string, string]> = [
    ['updates', 'Daily updates'],
    ['alerts', 'Published-record alerts'],
    ['contacts', 'Contacts & lists'],
    ['imports', 'Import review'],
    ...(keywordsEnabled ? [['keywords', 'Keyword rules'] as [string, string]] : []),
    ...(workflowsEnabled ? [['workflows', 'Follow-up workflows'] as [string, string]] : []),
  ];
  const activeMoreView = moreViews.find(([id]) => id === tab);
  return (
    <section className="lw-reports" aria-label="Reports and updates">
      <header className="lw-reports-heading">
        <div>
          <p className="lw-reports-eyebrow">LEGIWATCH / CLIENT COMMUNICATIONS</p>
          <h2>Your reports</h2>
          <p>Create briefings from saved legislative records and review previous runs.</p>
        </div>
        <CapiroButton variant="primary" size="compact" onClick={newReport}>
          Create report
        </CapiroButton>
      </header>
      <nav className="lw-reports-tabs" role="tablist" aria-label="Report views">
        {mainViews.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      <details className="lw-reports-more" open={Boolean(activeMoreView)}>
        <summary>{activeMoreView ? `Settings and tools · ${activeMoreView[1]}` : 'Settings and tools'}</summary>
        <nav className="lw-reports-tabs" role="tablist" aria-label="Report settings and tools">
          {moreViews.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </details>
      {error && (
        <p role="alert" className="lw-reports-warning">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {tab === 'briefings' ? <BriefingWorkspace /> : null}
      {tab === 'workflows' ? <WorkflowReview initialFolderId={initialFolderId} /> : null}
      {tab === 'keywords' && keywordsEnabled ? (
        <KeywordReview initialView="rules" folderId={initialFolderId} />
      ) : null}
      {[
        reports,
        folders,
        directory,
        ...(tab === 'history' ? [history] : []),
        ...(tab === 'updates' ? [subscriptions] : []),
        ...(tab === 'alerts' ? [rules] : []),
        ...(tab === 'imports' ? [staged] : []),
      ].some((q) => q.isError) && (
        <p role="alert">
          This view could not load.{' '}
          <button
            type="button"
            onClick={() => void qc.invalidateQueries({ queryKey: reportKey(scope) })}
          >
            Retry
          </button>
        </p>
      )}
      {tab === 'reports' && (
        <>
          <p>
            For a summary of current updates,{' '}
            <CapiroButton size="compact" onClick={() => {
              const next = new URLSearchParams(params);
              next.set('digestMode', 'legacy');
              next.delete('reportView');
              next.delete('reportRun');
              setParams(next);
            }}>Open intelligence brief</CapiroButton>
          </p>
          <div className="lw-reports-controls">
            <CapiroInput
              type="date"
              label="Report cutoff"
              value={cutoff}
              max={today()}
              onChange={(e) => setCutoff(e.target.value)}
            />
            <CapiroSelect
              label="Audience"
              helpText={audience === 'external' ? 'Private notes are excluded.' : undefined}
              value={audience}
              options={[
                option('external', 'External'),
                option('internal', 'Internal review'),
              ]}
              onChange={(e) => setAudience(e.target.value)}
            />
          </div>
          {reports.isPending ? (
            <Empty>Loading report library…</Empty>
          ) : !reports.data?.length ? (
            <Empty>No report definitions yet. Create a report or review staged imports.</Empty>
          ) : (
            <div className="lw-reports-table">
              <table>
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Scope</th>
                    <th>Last generated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.data.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                        <small>
                          Version {r.version + 1}
                          {r.sourceId ? ` · Source ${r.sourceId}` : ''} · {r.id.slice(0, 8)}
                        </small>
                      </td>
                      <td>
                        {r.folderIds
                          .map(
                            (id) =>
                              folders.data?.find((f) => f.id === id)?.name ?? 'Folder unavailable',
                          )
                          .join(', ')}
                        <small>
                          {r.jurisdiction} · {r.sessionKey}
                        </small>
                      </td>
                      <td>
                        {r.lastGeneratedAt
                          ? new Date(r.lastGeneratedAt).toLocaleString()
                          : 'Not generated'}
                      </td>
                      <td>
                        <div className="lw-reports-actions">
                          <CapiroButton
                            size="compact"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                async () =>
                                  (
                                    await api.post<Run>(`${B}/${r.id}/generate`, {
                                      cutoff,
                                      audience,
                                      expectedVersion: r.version,
                                    })
                                  ).data,
                                setRun,
                              )
                            }
                          >
                            Generate
                          </CapiroButton>
                          <CapiroButton
                            size="compact"
                            disabled={!r.canEdit}
                            onClick={() => setEditing(r)}
                          >
                            Edit
                          </CapiroButton>
                          <CapiroButton
                            size="compact"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                () => api.post(`${B}/${r.id}/duplicate`),
                                undefined,
                                'Report duplicated.',
                              )
                            }
                          >
                            Duplicate
                          </CapiroButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {tab === 'history' && (
        <>
          <p>Frozen documents retain the settings and source facts used when generated.</p>
          {history.isPending ? (
            <Empty>Loading runs…</Empty>
          ) : (
            <div className="lw-reports-table">
              <table>
                <thead>
                  <tr>
                    <th>Generated</th>
                    <th>Report</th>
                    <th>Source check</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data?.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {new Date(r.generatedAt).toLocaleString()}
                        <small>Cutoff {r.cutoff}</small>
                      </td>
                      <td>
                        {reports.data?.find((x) => x.id === r.reportId)?.name ?? r.reportId}
                        <small>
                          {r.audience} · Version {r.definitionVersion + 1}
                        </small>
                      </td>
                      <td>{r.complete ? 'Complete' : 'Incomplete — send held'}</td>
                      <td>
                        <CapiroButton size="compact" onClick={() => void loadRun(r.id)}>
                          Open run
                        </CapiroButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!history.data?.length && <Empty>No report runs yet.</Empty>}
            </div>
          )}
        </>
      )}
      {tab === 'updates' && (
        <>
          <div className="lw-reports-heading">
            <p>Daily occurrences use a named timezone. New schedules start disabled.</p>
            <CapiroButton size="compact" onClick={() => setSchedule('new')}>
              Create schedule
            </CapiroButton>
          </div>
          {subscriptions.data?.map((s) => (
            <div className="lw-reports-card" key={s.id}>
              <div className="lw-reports-heading">
                <div>
                  <h3>{reports.data?.find((r) => r.id === s.reportId)?.name ?? s.reportId}</h3>
                  <p>
                    {s.enabled ? 'Enabled' : 'Paused'} ·{' '}
                    {s.mode === 'send' ? 'Automatic send' : 'Draft for review'} ·{' '}
                    {formatTime(s.localMinutes)} {s.timezone}
                  </p>
                  {s.enabled && s.mode === 'send' && !deliveryEnabled && (
                    <p role="status">Delivery disabled for this workspace</p>
                  )}
                  <small>
                    {s.enabled ? (s.mode === 'send' && !deliveryEnabled ? 'Next scheduled run: ' : 'Next: ') : 'No updates while paused'}
                    {s.enabled &&
                      (s.nextDueAt
                        ? new Date(s.nextDueAt).toLocaleString(undefined, {
                            timeZone: s.timezone,
                            timeZoneName: 'short',
                          })
                        : 'Not scheduled')}
                  </small>
                </div>
                <div className="lw-reports-actions">
                  <CapiroButton size="compact" onClick={() => setSchedule(s)}>
                    Review schedule
                  </CapiroButton>
                  <CapiroButton
                    size="compact"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        () =>
                          api.post(`${B}/subscriptions/${s.id}/run-now`, {
                            requestKey: crypto.randomUUID(),
                          }),
                        undefined,
                        'Draft occurrence requested; open its history for the result.',
                      )
                    }
                  >
                    Run now as draft
                  </CapiroButton>
                  {s.enabled && (
                    <CapiroButton
                      size="compact"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () =>
                            api.post(`${B}/subscriptions/${s.id}/activation`, {
                              enabled: false,
                              expectedVersion: s.version,
                            }),
                          undefined,
                          'Schedule paused.',
                        )
                      }
                    >
                      Pause
                    </CapiroButton>
                  )}
                </div>
              </div>
              <OccurrenceHistory
                id={s.id}
                scope={scope}
                loadRun={loadRun}
                retry={(id) =>
                  action(
                    () => api.post(`${B}/occurrences/${id}/retry`),
                    undefined,
                    'Occurrence queued again as a draft.',
                  )
                }
              />
            </div>
          ))}
          {!subscriptions.data?.length && <Empty>No daily report schedules.</Empty>}
        </>
      )}
      {tab === 'alerts' && (
        <>
          <p>
            These staff alerts cover published bill actions and amendments. Activation starts a new
            baseline and holds unresolved targets or recipients.
          </p>
          {rules.data?.map((r) => (
            <div className="lw-reports-card" key={r.id}>
              <div className="lw-reports-heading">
                <div>
                  <h3>{r.name}</h3>
                  <p>
                    {statusLabel(r.state)} · {r.cadence === 'realtime' ? 'Real time' : 'End of day'}{' '}
                    · {r.folderIds.length} folders
                  </p>
                  {r.issues.length > 0 && (
                    <p className="lw-reports-warning">{r.issues.join(' · ')}</p>
                  )}
                </div>
                <CapiroButton size="compact" onClick={() => setRule(r)}>
                  Review rule
                </CapiroButton>
              </div>
            </div>
          ))}
          {!rules.data?.length && (
            <Empty>No promoted action/amendment templates. Review staged imports to begin.</Empty>
          )}
        </>
      )}
      {tab === 'contacts' && (
        <>
          <div className="lw-reports-actions">
            <CapiroButton size="compact" onClick={() => setContact('new')}>
              Add contact
            </CapiroButton>
            <CapiroButton size="compact" onClick={() => setList('new')}>
              Create list
            </CapiroButton>
          </div>
          <div className="lw-reports-columns">
            <section>
              <h3>Contacts · {directory.data?.contacts.length ?? 0}</h3>
              {directory.data?.contacts.map((c) => (
                <button className="lw-reports-list-row" key={c.id} onClick={() => setContact(c)}>
                  <strong>{c.name}</strong>
                  <span>{c.email ?? 'Email missing'}</span>
                  <small>
                    {c.optedOut
                      ? 'Opted out'
                      : !c.active
                        ? 'Inactive'
                        : c.verified
                          ? 'Verified'
                          : 'Needs verification'}{' '}
                    · {c.id.slice(0, 8)}
                  </small>
                </button>
              ))}
            </section>
            <section>
              <h3>Mailing lists · {directory.data?.lists.length ?? 0}</h3>
              {directory.data?.lists.map((l) => (
                <button className="lw-reports-list-row" key={l.id} onClick={() => setList(l)}>
                  <strong>{l.name}</strong>
                  <span>
                    {l.contactIds.length} contacts · {l.private ? 'Private' : 'Workspace'}
                  </span>
                  <small>{l.id.slice(0, 8)}</small>
                </button>
              ))}
            </section>
          </div>
        </>
      )}
      {tab === 'imports' && (
        <>
          <p>
            Promotion creates reviewable definitions and preserves the original capture. Reports and
            lists are never paired by name.
          </p>
          {staged.data
            ?.filter((s) => ['report', 'alert'].includes(s.kind))
            .map((s) => (
              <div key={s.id} className="lw-reports-list-row">
                <span>
                  {s.kind} · {s.sourceId}
                </span>
                <small>{s.state}</small>
                <CapiroButton
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void action(
                      async () =>
                        (
                          await api.post<{ state?: string; reason?: string }>(
                            s.kind === 'report'
                              ? `${B}/promote/${s.id}`
                              : `${B}/rules/promote/${s.id}`,
                            s.kind === 'alert' ? { userMappings: {} } : {},
                          )
                        ).data,
                      (result) =>
                        setNotice(result.reason ?? statusLabel(result.state ?? 'needs_review')),
                    )
                  }
                >
                  Promote for review
                </CapiroButton>
              </div>
            ))}
          <ContactPromotion
            busy={busy}
            promote={(sourceAccount) =>
              action(
                () => api.post(`${B}/recipients/promote`, { sourceAccount }),
                undefined,
                'Contacts and list memberships promoted for review.',
              )
            }
          />
        </>
      )}
      {editing && (
        <CapiroModal
          open
          title={editing.id ? 'Edit report' : 'New report'}
          width={920}
          onClose={() => setEditing(null)}
        >
          <ReportEditor
            initial={editing}
            folders={folders.data ?? []}
            busy={busy}
            save={(value) =>
              action(
                (): Promise<unknown> =>
                  value.id
                    ? api.put(`${B}/${value.id}`, { ...value, expectedVersion: value.version })
                    : api.post(B, value),
                () => setEditing(null),
                'Report saved.',
              )
            }
          />
        </CapiroModal>
      )}
      {run && (
        <CapiroModal
          open
          title="Report preview"
          width={1100}
          onClose={() => {
            setRun(null);
            setCompose(false);
          }}
        >
          <div className="lw-reports">
            <div className="lw-reports-heading">
              <div>
                <strong>
                  {run.complete
                    ? 'Source check complete'
                    : 'Source check incomplete — delivery held'}
                </strong>
                <small>
                  Generated {new Date(run.generatedAt).toLocaleString()} · {run.audience} ·{' '}
                  {run.contentHash.slice(0, 12)}
                </small>
              </div>
              <div className="lw-reports-actions">
                <Download run={run} />
                <CapiroButton
                  size="compact"
                  onClick={() => {
                    const frame = document.getElementById(
                      'lw-report-preview',
                    ) as HTMLIFrameElement | null;
                    frame?.contentWindow?.print();
                  }}
                >
                  Print / save PDF
                </CapiroButton>
                <CapiroButton
                  size="compact"
                  disabled={!run.complete || run.audience !== 'external'}
                  onClick={() => setCompose(!compose)}
                >
                  Review delivery
                </CapiroButton>
              </div>
            </div>
            {compose && (
              <Composer
                key={run.id}
                run={run}
                directory={directory.data}
                deliveryEnabled={deliveryEnabled}
                action={action}
              />
            )}
            <iframe
              id="lw-report-preview"
              className="lw-reports-preview"
              title="Frozen legislative report"
              sandbox="allow-same-origin allow-modals"
              srcDoc={run.rendered?.html}
            />
            <DeliveryHistory runId={run.id} scope={scope} />
          </div>
        </CapiroModal>
      )}
      {schedule && (
        <CapiroModal
          open
          title="Daily report schedule"
          width={820}
          onClose={() => setSchedule(null)}
        >
          <ScheduleEditor
            initial={schedule}
            reports={reports.data ?? []}
            directory={directory.data}
            deliveryEnabled={deliveryEnabled}
            busy={busy}
            save={(value) =>
              action(
                async () =>
                  (
                    await (schedule === 'new'
                      ? api.post<Subscription>(`${B}/subscriptions`, value)
                      : api.put<Subscription>(`${B}/subscriptions/${schedule.id}`, {
                          ...value,
                          expectedVersion: schedule.version,
                        }))
                  ).data,
                setSchedule,
                'Schedule saved and disabled. Review it before enabling.',
              )
            }
            activate={(s, confirmSend, resumePolicy) =>
              action(
                async () =>
                  (
                    await api.post<Subscription>(`${B}/subscriptions/${s.id}/activation`, {
                      enabled: true,
                      expectedVersion: s.version,
                      confirmSend,
                      resumePolicy,
                    })
                  ).data,
                setSchedule,
                'Schedule enabled.',
              )
            }
          />
        </CapiroModal>
      )}
      {rule && (
        <CapiroModal open title="Published-record alert" width={850} onClose={() => setRule(null)}>
          <RuleEditor
            initial={rule}
            folders={folders.data ?? []}
            scope={scope}
            busy={busy}
            save={(value) =>
              action(
                async () =>
                  (
                    await api.put<Rule>(`${B}/rules/${rule.id}`, {
                      ...value,
                      expectedVersion: rule.version,
                    })
                  ).data,
                setRule,
                'Rule saved for activation review.',
              )
            }
            activate={(enabled) =>
              action(
                () =>
                  api.post(`${B}/rules/${rule.id}/activation`, {
                    enabled,
                    expectedVersion: rule.version,
                  }),
                () => setRule(null),
                enabled ? 'Rule activated with a new baseline.' : 'Rule paused.',
              )
            }
          />
        </CapiroModal>
      )}
      {contact && (
        <CapiroModal open title="Contact" onClose={() => setContact(null)}>
          <ContactEditor
            initial={contact}
            busy={busy}
            save={(value) =>
              action(
                (): Promise<unknown> =>
                  contact === 'new'
                    ? api.post(`${B}/contacts`, value)
                    : api.put(`${B}/contacts/${contact.id}`, {
                        ...value,
                        expectedVersion: contact.version,
                      }),
                () => setContact(null),
                'Contact saved.',
              )
            }
          />
        </CapiroModal>
      )}
      {list && (
        <CapiroModal open title="Mailing list" onClose={() => setList(null)}>
          <ListEditor
            initial={list}
            contacts={directory.data?.contacts ?? []}
            busy={busy}
            save={(value) =>
              action(
                (): Promise<unknown> =>
                  list === 'new'
                    ? api.post(`${B}/lists`, value)
                    : api.put(`${B}/lists/${list.id}`, { ...value, expectedVersion: list.version }),
                () => setList(null),
                'List saved.',
              )
            }
          />
        </CapiroModal>
      )}
      {onClose ? (
        // Reference reports modal footer: the dialog's existing close action
        // (FolderBillsTab's onClose) relocated to the bottom-right Close. The
        // generic header X is visually hidden by the modal-context CSS, so
        // this button keeps an always-visible close control in the tab order.
        <footer className="lw-reports-modal-footer">
          <CapiroButton size="compact" onClick={onClose}>
            Close
          </CapiroButton>
        </footer>
      ) : null}
    </section>
  );
}

type Action = <T>(
  work: () => Promise<T>,
  done?: (value: T) => void,
  success?: string,
) => Promise<void>;
function FolderSelection({
  folders,
  value,
  onChange,
}: {
  folders: Folder[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="lw-reports-fieldset">
      <legend>Folder scope</legend>
      {folders.map((f) => (
        <Check
          key={f.id}
          label={`${f.name} · ${f.id.slice(0, 8)}${f.archived ? ' · Archived' : ''}`}
          checked={value.includes(f.id)}
          disabled={!f.canEdit && !value.includes(f.id)}
          onChange={(checked) =>
            onChange(checked ? [...value, f.id] : value.filter((id) => id !== f.id))
          }
        />
      ))}
      {!folders.length && <Empty>No folders available.</Empty>}
    </fieldset>
  );
}
function ReportEditor({
  initial,
  folders,
  busy,
  save,
}: {
  initial: Report;
  folders: Folder[];
  busy: boolean;
  save: (report: Report) => Promise<void>;
}) {
  const api = useApi(),
    [draft, setDraft] = useState(initial);
  const sessions = useQuery({
    queryKey: ['legiwatch-report-sessions', draft.jurisdiction],
    queryFn: async () =>
      (
        await api.get<Array<{ key: string; label: string }>>(
          `${FOLDER_BASE}/sessions/${draft.jurisdiction}`,
        )
      ).data,
  });
  const setting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: value } }));
  return (
    <form
      className="lw-reports lw-reports-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(draft);
      }}
    >
      <CapiroInput
        label="Report name"
        required
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <div className="lw-reports-columns">
        <section>
          <h3>Selection</h3>
          <FolderSelection
            folders={folders}
            value={draft.folderIds}
            onChange={(folderIds) => setDraft({ ...draft, folderIds })}
          />
          <CapiroSelect
            label="Jurisdiction"
            value={draft.jurisdiction}
            options={['FL', 'US', 'CA', 'TX', 'NY', 'VA'].map((x) => option(x))}
            onChange={(e) => setDraft({ ...draft, jurisdiction: e.target.value, sessionKey: '' })}
          />
          <CapiroSelect
            label="Session"
            value={draft.sessionKey}
            options={[
              option('', 'Select session'),
              ...(sessions.data ?? []).map((s) => option(s.key, s.label)),
            ]}
            onChange={(e) => setDraft({ ...draft, sessionKey: e.target.value })}
          />
          <Check
            label="Only top-priority bills"
            checked={draft.settings.priorityOnly}
            onChange={(v) => setting('priorityOnly', v)}
          />
          <CapiroInput
            label="Select bills with action on or after (optional)"
            type="date"
            value={draft.settings.actionDateFrom ?? ''}
            onChange={(e) => setting('actionDateFrom', e.target.value || undefined)}
          />
          <CapiroInput
            label="Select bills with action on or before (optional)"
            type="date"
            value={draft.settings.actionDateTo ?? ''}
            onChange={(e) => setting('actionDateTo', e.target.value || undefined)}
          />
        </section>
        <section>
          <h3>Include</h3>
          <CapiroSelect
            label="Committee references"
            value={draft.settings.committees}
            options={[
              option('off', 'Off'),
              option('current', 'Current committee'),
              option('all', 'All references'),
            ]}
            onChange={(e) => setting('committees', e.target.value)}
          />
          <CapiroSelect
            label="Action display"
            value={draft.settings.actions}
            options={[
              option('off', 'Off'),
              option('last', 'Last action'),
              option('last3', 'Last 3 actions'),
              option('five_days', 'Last 5 calendar days'),
              option('all', 'All actions'),
            ]}
            onChange={(e) => setting('actions', e.target.value)}
          />
          <p className="lw-reports-help">
            The action display window keeps unchanged bills in the report. Selection filters narrow
            the bill list.
          </p>
          <CapiroSelect
            label="Related bills"
            value={draft.settings.relations}
            options={[
              option('off', 'Off'),
              option('title', 'Title only'),
              option('title_action', 'Title and last action'),
            ]}
            onChange={(e) => setting('relations', e.target.value)}
          />
          {(
            [
              ['summary', 'Source description'],
              ['priority', 'Priority and position'],
              ['externalComments', 'External folder comments'],
              ['internalComments', 'Internal comments — internal previews only'],
              ['billNotes', 'Global bill notes'],
              ['reportComments', 'Report comments'],
            ] as const
          ).map(([key, label]) => (
            <Check
              key={key}
              label={label}
              checked={draft.settings[key]}
              onChange={(v) => setting(key, v)}
            />
          ))}
        </section>
      </div>
      <div className="lw-reports-controls">
        <CapiroSelect
          label="Order"
          value={draft.settings.order}
          options={[
            option('number', 'Bill number'),
            option('folder', 'Folder'),
            option('last_action', 'Last action date'),
          ]}
          onChange={(e) => setting('order', e.target.value)}
        />
        <CapiroSelect
          label="Bill links"
          value={draft.settings.links}
          options={[
            option('public', 'Official public source'),
            option('subscribers', 'Capiro — authorized account required'),
          ]}
          onChange={(e) => setting('links', e.target.value)}
        />
      </div>
      <Check
        label="Include archived folders"
        checked={draft.settings.includeArchived}
        onChange={(v) => setting('includeArchived', v)}
      />
      <Check
        label="Accept clearly labeled gaps in optional source fields"
        checked={draft.settings.acceptOptionalGaps}
        onChange={(v) => setting('acceptOptionalGaps', v)}
      />
      <p className="lw-reports-help">
        Missing required identity, action coverage, or source freshness always holds delivery.
      </p>
      <CapiroButton
        type="submit"
        variant="primary"
        disabled={busy || !draft.folderIds.length || !draft.sessionKey}
      >
        Save report
      </CapiroButton>
    </form>
  );
}

function Recipients({
  directory,
  value,
  onChange,
}: {
  directory?: Directory;
  value: Selection[];
  onChange: (selection: Selection[]) => void;
}) {
  const [role, setRole] = useState<'to' | 'bcc'>('to'),
    [manual, setManual] = useState('');
  return (
    <fieldset className="lw-reports-fieldset">
      <legend>Recipients</legend>
      <CapiroSelect
        label="Recipient role"
        value={role}
        options={[option('to', 'To'), option('bcc', 'Bcc')]}
        onChange={(e) => setRole(e.target.value as 'to' | 'bcc')}
      />
      <CapiroSelect
        label="Add contact or list"
        value=""
        options={[
          option('', 'Choose a contact or list'),
          ...(directory?.contacts ?? []).map((c) =>
            option(
              `contact:${c.id}`,
              `${c.name} · ${c.email ?? 'Missing email'}${c.verified && c.active && !c.optedOut ? '' : ' · Needs review'}`,
            ),
          ),
          ...(directory?.lists ?? []).map((l) =>
            option(
              `list:${l.id}`,
              `${l.name} · ${l.contactIds.length} contacts${l.private ? ' · Private' : ''}`,
            ),
          ),
        ]}
        onChange={(e) => {
          const [kind, id] = e.target.value.split(':');
          if (id) onChange([...value, { kind: kind as 'contact' | 'list', id, role }]);
        }}
      />
      <div className="lw-reports-controls">
        <CapiroInput
          label="Manual email"
          type="email"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <CapiroButton
          size="compact"
          disabled={!manual}
          onClick={() => {
            onChange([...value, { kind: 'manual', email: manual, role }]);
            setManual('');
          }}
        >
          Add email
        </CapiroButton>
        {directory?.senderEmail && (
          <CapiroButton
            size="compact"
            onClick={() =>
              onChange([...value, { kind: 'manual', email: directory.senderEmail!, role: 'bcc' }])
            }
          >
            Copy me (Bcc)
          </CapiroButton>
        )}
      </div>
      <ul>
        {value.map((s, i) => (
          <li key={i}>
            {s.role.toUpperCase()} ·{' '}
            {s.email ??
              directory?.contacts.find((c) => c.id === s.id)?.name ??
              directory?.lists.find((l) => l.id === s.id)?.name ??
              s.id}{' '}
            <button type="button" onClick={() => onChange(value.filter((_, index) => index !== i))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <p className="lw-reports-help">
        Each recipient gets an isolated envelope. Bcc identities are never included in another
        recipient’s message. List aliases resolve to one destination.
      </p>
    </fieldset>
  );
}
function Composer({
  run,
  directory,
  deliveryEnabled,
  action,
}: {
  run: Run;
  directory?: Directory;
  deliveryEnabled: boolean;
  action: Action;
}) {
  const [recordBriefs, setRecordBriefs] = useState<SelectedRecordBrief[]>([]);
  const api = useApi(),
    [selection, setSelection] = useState<Selection[]>([]),
    [subject, setSubject] = useState('Legislative report'),
    [introduction, setIntroduction] = useState(''),
    [review, setReview] = useState<Composition | null>(null),
    [sending, setSending] = useState(false);
  const change = (fn: () => void) => {
    setReview(null);
    fn();
  };
  return (
    <section className="lw-reports-card">
      <h3>Review exact delivery</h3>
      <RecordBriefSelection
        reportId={run.reportId}
        value={recordBriefs}
        onChange={(v) => change(() => setRecordBriefs(v))}
      />
      <Recipients
        directory={directory}
        value={selection}
        onChange={(v) => change(() => setSelection(v))}
      />
      <CapiroInput
        label="Subject"
        value={subject}
        maxLength={200}
        onChange={(e) => change(() => setSubject(e.target.value))}
      />
      <CapiroTextarea
        label="Introduction"
        value={introduction}
        onChange={(e) => change(() => setIntroduction(e.target.value))}
      />
      <CapiroButton
        size="compact"
        disabled={!selection.length || sending}
        onClick={() =>
          void action(
            async () =>
              (
                await api.post<Composition>(`${B}/runs/${run.id}/compose`, {
                  recordBriefs,
                  selection,
                  subject,
                  introduction,
                })
              ).data,
            setReview,
          )
        }
      >
        Preview exact recipients
      </CapiroButton>
      {review && (
        <>
          <h4>Resolved destinations · {review.composition.recipients.length}</h4>
          <ul>
            {review.composition.recipients.map((r) => (
              <li key={r.email}>
                {r.role.toUpperCase()} · {r.email} · {r.contacts.length} contact identities
              </li>
            ))}
          </ul>
          <p>
            <strong>{review.composition.subject}</strong>
          </p>
          <p className="lw-reports-introduction">{review.composition.introduction}</p>
          {review.composition.plainText ? (
            <details open>
              <summary>Exact message for approval</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {review.composition.plainText}
              </pre>
            </details>
          ) : null}
          <CapiroButton
            variant="primary"
            disabled={!deliveryEnabled || !review.complete || sending}
            onClick={() => {
              setSending(true);
              void action(
                () =>
                  api.post(`${B}/runs/${run.id}/send`, {
                    recordBriefs,
                    selection,
                    subject,
                    introduction,
                    approvalHash: review.approvalHash,
                  }),
                () => setReview(null),
                'Delivery queued. Provider acceptance and errors appear below.',
              ).finally(() => setSending(false));
            }}
          >
            Approve and queue {review.composition.recipients.length} recipients
          </CapiroButton>
        </>
      )}
      {!deliveryEnabled && (
        <p className="lw-reports-help">External report delivery is disabled for this workspace.</p>
      )}
    </section>
  );
}
function DeliveryRecovery({
  id,
  state,
  contentHash,
  reload,
}: {
  id: string;
  state: string;
  contentHash: string;
  reload: () => void;
}) {
  const api = useApi(),
    [reason, setReason] = useState(''),
    [providerId, setProviderId] = useState(''),
    [outcome, setOutcome] = useState('provider_accepted'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <details>
      <summary>Review delivery recovery</summary>
      <form
        className="lw-reports-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.post(`${B}/deliveries/${id}/${state === 'held' ? 'retry' : 'reconcile'}`, {
              reason,
              contentHash,
              outcome,
              providerId,
            });
            reload();
          } catch (failure) {
            setError(folderError(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {state === 'held'
            ? 'Retry the same frozen content and destinations after resolving the hold. Changed contacts or report settings require a new review.'
            : 'Check provider records before choosing an outcome. An uncertain attempt must never be retried on assumption.'}
        </p>
        {state === 'uncertain' && (
          <>
            <CapiroSelect
              label="Verified provider outcome"
              value={outcome}
              options={[
                option('provider_accepted', 'Provider accepted — record message ID'),
                option(
                  'confirmed_not_sent',
                  'Confirmed not sent — queue the same reviewed content',
                ),
              ]}
              onChange={(e) => setOutcome(e.target.value)}
            />
            {outcome === 'provider_accepted' && (
              <CapiroInput
                label="Provider message ID"
                required
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              />
            )}
          </>
        )}
        <CapiroInput
          label="Review evidence and reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <CapiroButton type="submit" disabled={busy || !reason.trim()}>
          {state === 'held' ? 'Recheck and queue reviewed delivery' : 'Record verified outcome'}
        </CapiroButton>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
function DeliveryHistory({ runId, scope }: { runId: string; scope: string }) {
  const api = useApi();
  const q = useQuery({
    queryKey: [...reportKey(scope), 'delivery', runId],
    queryFn: async () =>
      (
        await api.get<
          Array<{
            id: string;
            approvedAt: string;
            contentHash: string;
            recipients: Array<{
              id: string;
              recipient: { email: string; role: string };
              state: string;
              providerId: string | null;
              error: string | null;
            }>;
          }>
        >(`${B}/runs/${runId}/deliveries`)
      ).data,
    refetchInterval: 15000,
  });
  return (
    <section>
      <h3>Delivery history</h3>
      <p className="lw-reports-help">
        Provider acceptance confirms submission. It does not confirm inbox delivery.
      </p>
      {q.data?.flatMap((d) =>
        d.recipients.map((r) => (
          <div className="lw-reports-list-row" key={r.id}>
            <span>
              {r.recipient.role.toUpperCase()} · {r.recipient.email}
            </span>
            <strong>{statusLabel(r.state)}</strong>
            <small>{r.error ?? r.providerId ?? new Date(d.approvedAt).toLocaleString()}</small>
            {(r.state === 'held' || r.state === 'uncertain') && (
              <DeliveryRecovery
                id={r.id}
                state={r.state}
                contentHash={d.contentHash}
                reload={() => {
                  void q.refetch();
                }}
              />
            )}
          </div>
        )),
      )}
      {!q.data?.length && <Empty>No approved delivery attempts for this run.</Empty>}
      {q.isError && <p role="alert">Delivery history could not load.</p>}
    </section>
  );
}
function OccurrenceHistory({
  id,
  scope,
  loadRun,
  retry,
}: {
  id: string;
  scope: string;
  loadRun: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
}) {
  const api = useApi();
  const q = useQuery({
    queryKey: [...reportKey(scope), 'occurrences', id],
    queryFn: async () => (await api.get<Occurrence[]>(`${B}/subscriptions/${id}/history`)).data,
    refetchInterval: 30000,
  });
  return (
    <details>
      <summary>Occurrence history · {q.data?.length ?? 0}</summary>
      {q.data?.map((o) => (
        <div className="lw-reports-list-row" key={o.id}>
          <strong>{statusLabel(o.state)}</strong>
          <span>{new Date(o.intendedAt).toLocaleString()}</span>
          <small>
            {o.windowStart} → {o.windowEnd}
          </small>
          {o.error && <small>{statusLabel(o.error)}</small>}
          {o.composition ? (
            <details>
              <summary>
                Frozen composition
                {o.composition.recordBriefs?.length
                  ? ' · includes selected published-record briefs'
                  : ''}
              </summary>
              <strong>{o.composition.subject}</strong>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {o.composition.plainText}
              </pre>
            </details>
          ) : null}
          <div className="lw-reports-actions">
            {o.runId && (
              <CapiroButton size="compact" onClick={() => void loadRun(o.runId!)}>
                Open frozen run
              </CapiroButton>
            )}
            {o.state === 'held' && (
              <CapiroButton size="compact" onClick={() => void retry(o.id)}>
                Retry as a new draft
              </CapiroButton>
            )}
          </div>
        </div>
      ))}
      {q.isError && <p role="alert">Occurrence history could not load.</p>}
    </details>
  );
}
function ScheduleEditor({
  initial,
  reports,
  directory,
  deliveryEnabled,
  busy,
  save,
  activate,
}: {
  initial: Subscription | 'new';
  reports: Report[];
  directory?: Directory;
  deliveryEnabled: boolean;
  busy: boolean;
  save: (value: object) => Promise<void>;
  activate: (s: Subscription, confirm: boolean, resume: string) => Promise<void>;
}) {
  const [recordBriefs, setRecordBriefs] = useState<SelectedRecordBrief[]>(
    initial === 'new' ? [] : (initial.recordBriefs ?? []),
  );
  const [reportId, setReportId] = useState(
    initial === 'new' ? (reports[0]?.id ?? '') : initial.reportId,
  );
  const [mode, setMode] = useState(initial === 'new' ? 'draft' : initial.mode),
    [timezone, setTimezone] = useState(initial === 'new' ? initialTimezone() : initial.timezone);
  const [time, setTime] = useState(initial === 'new' ? '08:00' : formatTime(initial.localMinutes)),
    [subject, setSubject] = useState(
      initial === 'new' ? 'Daily legislative update' : initial.subject,
    );
  const [introduction, setIntroduction] = useState(initial === 'new' ? '' : initial.introduction),
    [selection, setSelection] = useState<Selection[]>([]);
  const [sendNoChange, setSendNoChange] = useState(
      initial === 'new' ? false : initial.sendNoChange,
    ),
    [confirm, setConfirm] = useState(false),
    [resume, setResume] = useState('from_now'),
    [dirty, setDirty] = useState(false);
  const change = (work: () => void) => {
    setDirty(true);
    setConfirm(false);
    work();
  };
  useEffect(() => {
    setDirty(false);
    setConfirm(false);
  }, [initial]);
  return (
    <div className="lw-reports lw-reports-form">
      <CapiroSelect
        label="Report definition"
        value={reportId}
        options={[
          option('', 'Select report'),
          ...reports.map((r) => option(r.id, `${r.name} · ${r.id.slice(0, 8)}`)),
        ]}
        onChange={(e) =>
          change(() => {
            setReportId(e.target.value);
            setRecordBriefs([]);
          })
        }
      />
      <CapiroSelect
        label="Occurrence mode"
        value={mode}
        options={[
          option('draft', 'Generate a draft for review'),
          option('send', 'Send automatically to reviewed recipients'),
        ]}
        onChange={(e) => change(() => setMode(e.target.value))}
      />
      <RecordBriefSelection
        reportId={reportId}
        value={recordBriefs}
        onChange={(v) => change(() => setRecordBriefs(v))}
      />
      <div className="lw-reports-controls">
        <CapiroInput
          label="IANA timezone"
          value={timezone}
          onChange={(e) => change(() => setTimezone(e.target.value))}
        />
        <CapiroInput
          label="Daily local time"
          type="time"
          value={time}
          onChange={(e) => change(() => setTime(e.target.value))}
        />
      </div>
      <p className="lw-reports-help">
        Spring clock gaps run at the first valid minute after the requested time. Fall clock repeats
        run once. Missed days produce a catch-up draft.
      </p>
      <Check
        label="Produce a report even when no new published records were observed"
        checked={sendNoChange}
        onChange={(v) => change(() => setSendNoChange(v))}
      />
      <CapiroInput
        label="Subject"
        value={subject}
        onChange={(e) => change(() => setSubject(e.target.value))}
      />
      <CapiroTextarea
        label="Introduction"
        value={introduction}
        onChange={(e) => change(() => setIntroduction(e.target.value))}
      />
      {mode === 'send' && (
        <Recipients
          directory={directory}
          value={selection}
          onChange={(v) => change(() => setSelection(v))}
        />
      )}
      <CapiroButton
        disabled={busy || !reportId || (mode === 'send' && (!deliveryEnabled || !selection.length))}
        onClick={() =>
          void save({
            recordBriefs,
            reportId,
            mode,
            timezone,
            localMinutes: minutesOf(time),
            subject,
            introduction,
            selection,
            sendNoChange,
            catchUp: 'draft',
          })
        }
      >
        Save disabled schedule
      </CapiroButton>
      {initial !== 'new' && !initial.enabled && (
        <section className="lw-reports-card">
          <h3>Enable saved schedule</h3>
          <p>
            {initial.mode === 'send' ? 'Automatic send' : 'Draft only'} ·{' '}
            {formatTime(initial.localMinutes)} {initial.timezone}
          </p>
          <ul>
            {initial.recipients.map((r) => (
              <li key={r.email}>
                {r.role.toUpperCase()} · {r.email}
              </li>
            ))}
          </ul>
          {initial.baselineAt && (
            <CapiroSelect
              label="Resume policy"
              value={resume}
              options={[
                option('from_now', 'Start from now'),
                option('catch_up_draft', 'Catch up missed records as a draft'),
              ]}
              onChange={(e) => setResume(e.target.value)}
            />
          )}
          {initial.mode === 'send' && (
            <Check
              label="I reviewed these exact recipients and authorize automatic sending"
              checked={confirm}
              onChange={setConfirm}
            />
          )}
          <CapiroButton
            variant="primary"
            disabled={busy || dirty || (initial.mode === 'send' && (!confirm || !deliveryEnabled))}
            onClick={() => void activate(initial, confirm, resume)}
          >
            Enable saved schedule
          </CapiroButton>
          {dirty && <p>Save your changes before activation.</p>}
        </section>
      )}
    </div>
  );
}
export function RuleEditor({
  initial,
  folders,
  scope,
  busy,
  save,
  activate,
  apiBase = `${B}/rules`,
}: {
  initial: Rule;
  folders: Folder[];
  scope: string;
  busy: boolean;
  save: (value: Rule) => Promise<void>;
  activate: (enabled: boolean) => Promise<void>;
  apiBase?: string;
}) {
  const api = useApi(),
    [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(initial);
    setDirty(false);
  }, [initial]);
  const members = useQuery({
    queryKey: [...reportKey(scope), 'staff'],
    queryFn: async () =>
      (await api.get<{ members: Array<{ id: string; name: string }> }>(`${FOLDER_BASE}/members`))
        .data,
  });
  const readiness = useQuery({
    queryKey: [...reportKey(scope), 'readiness', initial.id, initial.version],
    queryFn: async () =>
      (
        await api.get<{
          ready: boolean;
          issues: string[];
          examples: Array<{ key: string; number: string; text: string; date: string | null }>;
        }>(`${apiBase}/${initial.id}/readiness`)
      ).data,
  });
  const change = (patch: Partial<Rule>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  return (
    <div className="lw-reports lw-reports-form">
      <CapiroInput
        label="Rule name"
        value={draft.name}
        onChange={(e) => change({ name: e.target.value })}
      />
      <FolderSelection
        folders={folders}
        value={draft.folderIds}
        onChange={(folderIds) => change({ folderIds })}
      />
      <CapiroSelect
        label="Cadence"
        value={draft.cadence}
        options={[option('realtime', 'Real time'), option('end_of_day', 'End of day')]}
        onChange={(e) => change({ cadence: e.target.value })}
      />
      {draft.cadence === 'end_of_day' && (
        <div className="lw-reports-controls">
          <CapiroInput
            label="IANA timezone"
            value={draft.timezone ?? ''}
            onChange={(e) => change({ timezone: e.target.value })}
          />
          <CapiroInput
            label="Local end-of-day time"
            type="time"
            value={draft.localMinutes == null ? '' : formatTime(draft.localMinutes)}
            onChange={(e) => change({ localMinutes: minutesOf(e.target.value) })}
          />
        </div>
      )}
      <fieldset className="lw-reports-fieldset">
        <legend>Staff recipients and channels</legend>
        {members.data?.members.map((m) => {
          const selected = draft.recipients.find((r) => r.userId === m.id);
          const toggle = (channel: 'email' | 'inApp', value: boolean) =>
            change({
              recipients: [
                ...draft.recipients.filter((r) => r.userId !== m.id),
                {
                  userId: m.id,
                  email: selected?.email ?? false,
                  inApp: selected?.inApp ?? false,
                  [channel]: value,
                },
              ],
            });
          return (
            <div className="lw-reports-recipient" key={m.id}>
              <span>
                {m.name}
                <small>{m.id}</small>
              </span>
              <Check
                label="Email"
                checked={selected?.email ?? false}
                onChange={(v) => toggle('email', v)}
              />
              <Check
                label="In-app"
                checked={selected?.inApp ?? false}
                onChange={(v) => toggle('inApp', v)}
              />
            </div>
          );
        })}
      </fieldset>
      <CapiroButton disabled={busy || !dirty} onClick={() => void save(draft)}>
        Save reviewed targets and channels
      </CapiroButton>
      <section className="lw-reports-card">
        <h3>Activation readiness</h3>
        {readiness.isPending ? (
          <p>Checking current mappings and source coverage…</p>
        ) : readiness.isError ? (
          <p role="alert">Readiness could not be checked.</p>
        ) : readiness.data?.ready ? (
          <p>Targets, staff, and published records are ready.</p>
        ) : (
          <ul>{readiness.data?.issues.map((i) => <li key={i}>{i}</li>)}</ul>
        )}
        <h4>Source examples</h4>
        {readiness.data?.examples.map((e) => (
          <p key={e.key}>
            {e.number} · {e.date ?? 'Date unavailable'} · {e.text}
          </p>
        ))}
        <p className="lw-reports-help">
          Activation baselines current records. New folder memberships are baselined separately, so
          historical records do not flood the queue.
        </p>
        <CapiroButton
          variant="primary"
          disabled={busy || dirty || (initial.state !== 'active' && !readiness.data?.ready)}
          onClick={() => void activate(initial.state !== 'active')}
        >
          {initial.state === 'active' ? 'Pause rule' : 'Activate from now'}
        </CapiroButton>
      </section>
    </div>
  );
}
function ContactEditor({
  initial,
  busy,
  save,
}: {
  initial: Contact | 'new';
  busy: boolean;
  save: (value: object) => Promise<void>;
}) {
  const [draft, setDraft] = useState(
    initial === 'new'
      ? { name: '', email: '', verified: false, active: true, optedOut: false }
      : initial,
  );
  return (
    <form
      className="lw-reports lw-reports-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(draft);
      }}
    >
      <CapiroInput
        label="Contact name"
        required
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <CapiroInput
        label="Email"
        type="email"
        value={draft.email ?? ''}
        onChange={(e) => setDraft({ ...draft, email: e.target.value, verified: false })}
      />
      <Check
        label="I verified this destination"
        checked={draft.verified}
        onChange={(v) => setDraft({ ...draft, verified: v })}
      />
      <Check
        label="Active contact"
        checked={draft.active}
        onChange={(v) => setDraft({ ...draft, active: v })}
      />
      <Check
        label="Opted out — blocks this email across aliases"
        checked={draft.optedOut}
        onChange={(v) => setDraft({ ...draft, optedOut: v })}
      />
      <CapiroButton type="submit" variant="primary" disabled={busy}>
        Save contact
      </CapiroButton>
    </form>
  );
}
function ListEditor({
  initial,
  contacts,
  busy,
  save,
}: {
  initial: List | 'new';
  contacts: Contact[];
  busy: boolean;
  save: (value: object) => Promise<void>;
}) {
  const [draft, setDraft] = useState(
    initial === 'new'
      ? { name: '', contactIds: [] as string[], private: true, active: true }
      : initial,
  );
  return (
    <form
      className="lw-reports lw-reports-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(draft);
      }}
    >
      <CapiroInput
        label="List name"
        required
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <Check
        label="Private to owner and administrators"
        checked={draft.private}
        onChange={(v) => setDraft({ ...draft, private: v })}
      />
      <Check
        label="Active list"
        checked={draft.active}
        onChange={(v) => setDraft({ ...draft, active: v })}
      />
      <fieldset className="lw-reports-fieldset">
        <legend>Membership · {draft.contactIds.length}</legend>
        {contacts.map((c) => (
          <Check
            key={c.id}
            label={`${c.name} · ${c.email ?? 'Missing email'} · ${c.id.slice(0, 8)}`}
            checked={draft.contactIds.includes(c.id)}
            onChange={(checked) =>
              setDraft({
                ...draft,
                contactIds: checked
                  ? [...draft.contactIds, c.id]
                  : draft.contactIds.filter((id) => id !== c.id),
              })
            }
          />
        ))}
      </fieldset>
      <p className="lw-reports-help">
        An empty list stays empty. Identical email addresses preserve their separate contact
        identities.
      </p>
      <CapiroButton type="submit" variant="primary" disabled={busy}>
        Save list
      </CapiroButton>
    </form>
  );
}
function ContactPromotion({
  busy,
  promote,
}: {
  busy: boolean;
  promote: (sourceAccount: string) => Promise<void>;
}) {
  const [sourceAccount, setSourceAccount] = useState('');
  return (
    <section className="lw-reports-card">
      <h3>Captured contact directory</h3>
      <CapiroInput
        label="Exact imported source account"
        value={sourceAccount}
        onChange={(e) => setSourceAccount(e.target.value)}
      />
      <CapiroButton disabled={busy || !sourceAccount} onClick={() => void promote(sourceAccount)}>
        Promote contacts and exact memberships
      </CapiroButton>
      <p className="lw-reports-help">Imported destinations need current verification before use.</p>
    </section>
  );
}
