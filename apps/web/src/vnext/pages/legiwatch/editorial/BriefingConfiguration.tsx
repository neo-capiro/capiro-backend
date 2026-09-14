import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BRIEFING_TEMPLATES } from '@capiro/shared';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { REPORT_BASE, type Directory, type Report } from '../reports/report-api.js';
import { EVIDENCE_BASE, useEvidence, type Row } from './evidence-api.js';
const option = (value: string, label = value) => ({ value, label });
const categoryLabels: Record<string, string> = {
  '1': 'Calendar',
  '6': 'Executive',
  '4': 'House',
  '5': 'Joint',
  '10': 'Miscellaneous',
  '3': 'Senate',
  '11': 'Site News',
  '9': 'Special Report',
  '69': 'Business & Economy',
  '61': 'Climate & Environment',
  '55': 'Education',
  '49': 'General Government',
  '56': 'Health Care',
};
export function BriefingConfigurations({
  client,
  folder,
  reports,
}: {
  client: string;
  folder: string;
  reports: Report[];
}) {
  const api = useApi(),
    scope = useApiScope(),
    qc = useQueryClient(),
    query = useEvidence<Row>('briefings/configurations', {}),
    [editing, setEditing] = useState<Row | null>(null),
    [review, setReview] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['legiwatch-evidence', scope] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Configuration needs review.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h4>Imported alert families and schedules</h4>
      <p>
        Each source family keeps its own configuration. Saved settings pause execution until
        reviewed. Historical audience entries require a current recipient selection.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="lw-evidence-table">
        <table>
          <thead>
            <tr>
              <th>Source family</th>
              <th>Preparation / sending</th>
              <th>Schedule & execution</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(query.data?.configurations ?? []).map((r: Row) => (
              <tr key={r.id}>
                <td>
                  {r.source.family?.displayName ?? r.source_key}
                  <small>
                    {r.state} · version {r.version}
                  </small>
                </td>
                <td>
                  {r.config.prepareEnabled ? 'Preparation configured' : 'Preparation paused'}
                  <small>
                    {r.config.sendEnabled
                      ? `${r.config.recipients?.length ?? 0} reviewed email destinations`
                      : 'Sending paused'}
                  </small>
                </td>
                <td>
                  {r.config.schedule
                    ? `${String(r.config.schedule.hour).padStart(2, '0')}:${String(r.config.schedule.minute).padStart(2, '0')} ${r.config.schedule.timezone}`
                    : 'Cadence not captured; setup required'}
                  <small>
                    Last success:{' '}
                    {r.last_success_at ? new Date(r.last_success_at).toLocaleString() : 'None'}
                  </small>
                  <small>{r.last_held_reason}</small>
                </td>
                <td>
                  <div className="lw-evidence-actions">
                    <CapiroButton
                      size="compact"
                      disabled={!folder || busy}
                      onClick={() => setEditing(r)}
                    >
                      Configure
                    </CapiroButton>
                    <CapiroButton
                      size="compact"
                      disabled={busy || !r.config.schedule}
                      onClick={() =>
                        r.state === 'active'
                          ? void action(() =>
                              api.post(
                                `${EVIDENCE_BASE}/briefings/configurations/${r.id}/activation`,
                                { expectedVersion: r.version, enabled: false },
                              ),
                            )
                          : setReview(r)
                      }
                    >
                      {r.state === 'active' ? 'Pause' : 'Review activation'}
                    </CapiroButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!query.isPending && !query.data?.configurations?.length && (
        <p>
          No alert families have been staged. Use News → Monitors & import to review the capture.
        </p>
      )}
      {editing && (
        <ConfigurationEditor
          row={editing}
          client={client}
          folder={folder}
          reports={reports}
          busy={busy}
          close={() => setEditing(null)}
          save={(config) =>
            void action(async () => {
              await api.post(`${EVIDENCE_BASE}/briefings/configurations/${editing.id}`, {
                expectedVersion: editing.version,
                config,
              });
              setEditing(null);
            })
          }
        />
      )}
      {review && (
        <CapiroModal open onClose={() => setReview(null)} title="Review scheduled edition">
          <p>
            {BRIEFING_TEMPLATES[review.config.template as keyof typeof BRIEFING_TEMPLATES]} ·{' '}
            {review.config.schedule.timezone}
          </p>
          <p>
            Preparation: {review.config.prepareEnabled ? 'enabled' : 'paused'}. Sending:{' '}
            {review.config.sendEnabled ? 'enabled after approval' : 'paused'}.
          </p>
          <p>
            {review.config.monitorIds.length} selected monitors ·{' '}
            {review.config.includedKinds.join(', ')} evidence. A missing source holds distribution.
          </p>
          {review.config.sendEnabled && (
            <>
              <p>
                Each approved destination receives an isolated email envelope. New contact or list
                changes require review.
              </p>
              <ul>
                {review.config.recipients.map((r: Row) => (
                  <li key={r.email}>
                    {r.role.toUpperCase()} · {r.name} · {r.email}
                  </li>
                ))}
              </ul>
              <p>Subject: {review.config.subject}</p>
            </>
          )}
          <CapiroButton
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api.post(
                  `${EVIDENCE_BASE}/briefings/configurations/${review.id}/activation`,
                  {
                    expectedVersion: review.version,
                    enabled: true,
                    approvalHash: review.approvalHash,
                  },
                );
                setReview(null);
              })
            }
          >
            {review.config.sendEnabled
              ? 'Approve standing preparation and sending'
              : 'Activate preparation'}
          </CapiroButton>
        </CapiroModal>
      )}
    </>
  );
}
function ConfigurationEditor({
  row,
  client,
  folder,
  reports,
  busy,
  close,
  save,
}: {
  row: Row;
  client: string;
  folder: string;
  reports: Report[];
  busy: boolean;
  close: () => void;
  save: (config: Row) => void;
}) {
  const api = useApi(),
    scope = useApiScope(),
    prior = row.config,
    s = prior.schedule ?? {},
    [template, setTemplate] = useState(
      prior.template ??
        (row.source.family?.family === 'budget'
          ? 'research_update'
          : row.source.family?.family === 'daily_legislative_brief'
            ? 'daily_legislative_brief'
            : 'morning_news_brief'),
    ),
    [report, setReport] = useState(prior.reportId ?? reports[0]?.id ?? ''),
    [hour, setHour] = useState(
      `${String(s.hour ?? 8).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`,
    ),
    [timezone, setTimezone] = useState(
      s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [weekdays, setWeekdays] = useState<number[]>(s.weekdays ?? [1, 2, 3, 4, 5]),
    [prepare, setPrepare] = useState(prior.prepareEnabled === true),
    [send, setSend] = useState(prior.sendEnabled === true),
    [accepted, setAccepted] = useState(prior.dictionaryScopeAccepted === true),
    [acceptAvailableFields, setAcceptAvailableFields] = useState(
      prior.acceptAvailableFields === true,
    ),
    [selected, setSelected] = useState<string[]>(prior.monitorIds ?? []),
    [kinds, setKinds] = useState<string[]>(prior.includedKinds ?? ['news']),
    [subject, setSubject] = useState(prior.subject ?? 'Capiro client briefing'),
    [noChange, setNoChange] = useState(s.noChange ?? 'skip'),
    [sourceGap, setSourceGap] = useState(s.sourceGap ?? 'hold'),
    [selection, setSelection] = useState<Row[]>(
      Array.isArray(prior.recipientSelection) ? prior.recipientSelection : [],
    ),
    [entries, setEntries] = useState<Row>(prior.categoryMapping?.entries ?? {});
  const monitors = useEvidence<Row>('news/monitors', {}),
    directory = useQuery({
      queryKey: ['phase8-directory', scope],
      queryFn: async () => (await api.get<Directory>(`${REPORT_BASE}/recipients`)).data,
    });
  const visible = (monitors.data?.monitors ?? []).filter(
      (m: Row) => (m.config.clientId ?? '') === client,
    ),
    toggle = (values: string[], value: string) =>
      values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  return (
    <CapiroModal
      open
      onClose={close}
      title={`Configure ${row.source.family?.displayName ?? 'briefing'}`}
    >
      <p>
        The captured schedule and dictionary binding were unspecified. Choose the current folder,
        evidence, cadence and audience for this edition.
      </p>
      <div className="lw-evidence-toolbar">
        <CapiroSelect
          label="Template"
          value={template}
          options={Object.entries(BRIEFING_TEMPLATES).map(([id, label]) => option(id, label))}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <CapiroSelect
          label="Folder report"
          value={report}
          options={[option('', 'Choose report'), ...reports.map((r) => option(r.id, r.name))]}
          onChange={(e) => setReport(e.target.value)}
        />
      </div>
      <fieldset className="lw-evidence-fieldset">
        <legend>Evidence to include</legend>
        {['news', 'budget', 'personnel', 'research'].map((kind) => (
          <label key={kind} className="lw-evidence-check">
            <input
              type="checkbox"
              checked={kinds.includes(kind)}
              onChange={() => setKinds(toggle(kinds, kind))}
            />
            {kind === 'research' ? 'Published legislative research' : kind}
          </label>
        ))}
      </fieldset>
      <fieldset className="lw-evidence-fieldset">
        <legend>Specific news monitors</legend>
        {visible.length ? (
          visible.map((m: Row) => (
            <label key={m.id} className="lw-evidence-check">
              <input
                type="checkbox"
                checked={selected.includes(m.id)}
                onChange={() => setSelected(toggle(selected, m.id))}
              />
              {m.config.name ?? m.config.query} · {m.state}
            </label>
          ))
        ) : (
          <p>No configured monitors in this client scope.</p>
        )}
      </fieldset>
      {(row.source.family?.categories ?? []).length > 0 && (
        <fieldset className="lw-evidence-fieldset">
          <legend>Source category mapping</legend>
          <p>
            Namespace: {row.source.family.categoryNamespace}. Record an explicit basis for every
            captured category.
          </p>
          {row.source.family.categories.map((id: string) => (
            <div key={id} className="lw-evidence-toolbar">
              <CapiroSelect
                label={`${id} · ${categoryLabels[id]}`}
                value={entries[id]?.decision ?? 'pending'}
                options={[
                  option('pending', 'Pending review'),
                  option('included', 'Included in selected evidence scope'),
                  option('excluded', 'Excluded with reason'),
                ]}
                onChange={(e) =>
                  setEntries({ ...entries, [id]: { ...entries[id], decision: e.target.value } })
                }
              />
              <CapiroInput
                label="Mapping basis or exclusion reason"
                value={entries[id]?.reason ?? ''}
                onChange={(e) =>
                  setEntries({
                    ...entries,
                    [id]: {
                      ...entries[id],
                      reason: e.target.value,
                      decision: entries[id]?.decision ?? 'pending',
                    },
                  })
                }
              />
            </div>
          ))}
        </fieldset>
      )}
      <div className="lw-evidence-toolbar">
        <CapiroInput
          label="Local time (HH:MM)"
          value={hour}
          onChange={(e) => setHour(e.target.value)}
        />
        <CapiroInput
          label="Timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        />
      </div>
      <fieldset className="lw-evidence-fieldset">
        <legend>Days</legend>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
          <label key={day} className="lw-evidence-check">
            <input
              type="checkbox"
              checked={weekdays.includes(i)}
              onChange={() =>
                setWeekdays(
                  weekdays.includes(i) ? weekdays.filter((d) => d !== i) : [...weekdays, i],
                )
              }
            />
            {day}
          </label>
        ))}
      </fieldset>
      <div className="lw-evidence-toolbar">
        <CapiroSelect
          label="No change"
          value={noChange}
          options={[
            option('skip', 'Skip with receipt'),
            option('draft', 'Hold for an internal source review'),
          ]}
          onChange={(e) => setNoChange(e.target.value)}
        />
        <CapiroSelect
          label="Missing source"
          value={sourceGap}
          options={[
            option('hold', 'Hold preparation'),
            option('draft', 'Prepare internal draft with gap notice'),
          ]}
          onChange={(e) => setSourceGap(e.target.value)}
        />
      </div>
      <label className="lw-evidence-check">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        I reviewed this folder, dictionary and evidence scope
      </label>
      <label className="lw-evidence-check">
        <input type="checkbox" checked={prepare} onChange={(e) => setPrepare(e.target.checked)} />
        Prepare scheduled editions
      </label>
      <label className="lw-evidence-check">
        <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
        Configure external email sending for separate activation review
      </label>
      {send && (
        <>
          <label className="lw-evidence-check">
            <input
              type="checkbox"
              checked={acceptAvailableFields}
              onChange={(e) => setAcceptAvailableFields(e.target.checked)}
            />
            Allow cited headlines and excerpts with visible source limitations. Provider outages and
            incomplete monitoring windows still hold sending.
          </label>
          <CapiroInput
            label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <fieldset className="lw-evidence-fieldset">
            <legend>Current verified recipients</legend>
            {(directory.data?.contacts ?? [])
              .filter((c) => c.active && c.verified && !c.optedOut && c.email)
              .map((c) => (
                <div key={c.id} className="lw-evidence-toolbar">
                  <label>
                    <input
                      type="checkbox"
                      checked={selection.some((r) => r.kind === 'contact' && r.id === c.id)}
                      onChange={() =>
                        setSelection(
                          selection.some((r) => r.id === c.id)
                            ? selection.filter((r) => r.id !== c.id)
                            : [...selection, { kind: 'contact', id: c.id, role: 'bcc' }],
                        )
                      }
                    />
                    {c.name} · {c.email}
                  </label>
                  {selection.some((r) => r.id === c.id) && (
                    <CapiroSelect
                      label="Recipient role"
                      value={selection.find((r) => r.id === c.id)?.role ?? 'bcc'}
                      options={[option('bcc', 'BCC'), option('to', 'To')]}
                      onChange={(e) =>
                        setSelection(
                          selection.map((r) =>
                            r.id === c.id ? { ...r, role: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  )}
                </div>
              ))}
          </fieldset>
        </>
      )}
      <CapiroButton
        disabled={busy || !folder || !report || !/^\d\d:\d\d$/.test(hour)}
        onClick={() =>
          save({
            clientId: client || null,
            folderId: folder,
            template,
            reportId: report,
            monitorIds: selected,
            includedKinds: kinds,
            subject,
            recipientSelection: selection,
            prepareEnabled: prepare,
            sendEnabled: send,
            dictionaryScopeAccepted: accepted,
            acceptAvailableFields,
            categoryMapping: {
              namespace: row.source.family?.categoryNamespace ?? null,
              version: 1,
              entries,
            },
            schedule: {
              timezone,
              hour: Number(hour.split(':')[0]),
              minute: Number(hour.split(':')[1]),
              weekdays,
              noChange,
              sourceGap,
              mode: send ? 'send' : 'prepare',
            },
          })
        }
      >
        Save paused settings
      </CapiroButton>
    </CapiroModal>
  );
}
