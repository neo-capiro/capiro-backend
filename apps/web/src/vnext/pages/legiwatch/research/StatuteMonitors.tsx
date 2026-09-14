import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect } from '../../../components/fields/index.js';
const BASE = '/intel-api/legiwatch/research/monitors';
export function StatuteMonitors({ sessionKey }: { sessionKey: string }) {
  const api = useApi(),
    identity = useApiScope();
  const monitors = useQuery({
    queryKey: ['statute-monitors', identity],
    queryFn: async () => (await api.get<any[]>(BASE)).data,
    retry: false,
  });
  const folders = useQuery({
    queryKey: ['monitor-folders', identity],
    queryFn: async () => (await api.get<any[]>('/intel-api/legiwatch/folders')).data,
    retry: false,
  });
  const staff = useQuery({
    queryKey: ['monitor-staff', identity],
    queryFn: async () =>
      (
        await api.get<{ members: Array<{ id: string; name: string }> }>(
          '/intel-api/legiwatch/folders/members',
        )
      ).data,
    retry: false,
  });
  return (
    <section aria-label="Statute reference monitors">
      <h3>Configure promoted statute alerts</h3>
      <p>
        Each definition keeps its own scope and baseline. Matching runs create reviewable evidence.
        Report delivery has a separate review.
      </p>
      {monitors.isError ? (
        <p>Monitor definitions are unavailable. Check current workspace access.</p>
      ) : null}
      {(monitors.data ?? []).map((rule) => (
        <Monitor
          key={rule.id + ':' + rule.version}
          rule={rule}
          folders={folders.data ?? []}
          staff={staff.data?.members ?? []}
          sessionKey={sessionKey}
          refresh={() => monitors.refetch()}
        />
      ))}
    </section>
  );
}
function Monitor({
  rule,
  folders,
  staff,
  sessionKey,
  refresh,
}: {
  rule: any;
  folders: any[];
  staff: Array<{ id: string; name: string }>;
  sessionKey: string;
  refresh: () => Promise<unknown>;
}) {
  const api = useApi(),
    [folderIds, setFolders] = useState<string[]>(rule.config.folderIds ?? []),
    [numbers, setNumbers] = useState(''),
    [cadence, setCadence] = useState(rule.config.cadence ?? ''),
    [descendants, setDescendants] = useState(rule.config.descendants === true),
    [recipients, setRecipients] = useState<
      Array<{ userId: string; email: boolean; inApp: boolean }>
    >(rule.config.recipients ?? []),
    [preview, setPreview] = useState<any>(null),
    [events, setEvents] = useState<any[]>([]),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus('');
    try {
      await fn();
    } catch (e: any) {
      setStatus(
        e?.response?.data?.code === 'MONITOR_REVIEW_REQUIRED'
          ? 'Activation requires a current source preview and completed qualification.'
          : 'Action could not complete. Reload the definition and check the selected source and folder access.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <article>
      <h4>
        {rule.name ?? 'Unnamed statute alert'} · {rule.state.replaceAll('_', ' ')}
      </h4>
      <details>
        <summary>Folders, corpus, cadence and staff</summary>
        <p>
          Choose the folders whose tracked statutes should match bills in the explicit corpus below.
        </p>
        {folders.map((f) => (
          <label key={f.id}>
            <input
              type="checkbox"
              checked={folderIds.includes(f.id)}
              disabled={f.archived}
              onChange={(e) =>
                setFolders(
                  e.target.checked ? [...folderIds, f.id] : folderIds.filter((id) => id !== f.id),
                )
              }
            />
            {f.name}
            {f.archived ? ' · archived' : ''}
          </label>
        ))}
        <CapiroInput
          label={'Bill numbers in Florida session ' + sessionKey}
          placeholder="SB 1156, HB 1207"
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
        />
        <CapiroSelect
          label="Matching cadence"
          value={cadence}
          options={[
            { value: '', label: 'Choose a cadence' },
            { value: 'manual', label: 'Run when requested' },
            { value: 'hourly', label: 'Hourly' },
            { value: 'daily', label: 'Daily' },
          ]}
          onChange={(e) => setCadence(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={descendants}
            onChange={(e) => setDescendants(e.target.checked)}
          />
          Include descendants of tracked chapters and sections
        </label>
        <p>Staff mapping for review. Selecting a member here does not enable delivery.</p>
        {staff.map((s) => (
          <label key={s.id}>
            <input
              type="checkbox"
              checked={recipients.some((r) => r.userId === s.id)}
              onChange={(e) =>
                setRecipients(
                  e.target.checked
                    ? [...recipients, { userId: s.id, email: false, inApp: false }]
                    : recipients.filter((r) => r.userId !== s.id),
                )
              }
            />
            {s.name}
          </label>
        ))}
        <CapiroButton
          disabled={busy || !cadence || !numbers.trim()}
          onClick={() =>
            action(async () => {
              const resolved = (
                await api.post<any[]>('/intel-api/legiwatch/folders/resolve', {
                  jurisdiction: 'FL',
                  sessionKey,
                  billNumbers: numbers,
                  folderIds,
                })
              ).data;
              if (!resolved.length || resolved.some((r) => r.status !== 'resolved'))
                throw Error('Bill resolution required');
              await api.post(BASE + '/' + rule.id + '/configure', {
                expectedVersion: rule.version,
                config: {
                  folderIds,
                  billIds: resolved.map((r) => r.bill.id),
                  jurisdiction: 'FL',
                  sessionKey,
                  descendants,
                  cadence,
                  recipients,
                },
              });
              await refresh();
              setPreview(null);
              setStatus('Configuration saved. Review its exact source preview before activating.');
            })
          }
        >
          Save configuration
        </CapiroButton>
      </details>
      <CapiroButton
        disabled={busy}
        onClick={() =>
          action(async () =>
            setPreview((await api.post(BASE + '/' + rule.id + '/preview', {})).data),
          )
        }
      >
        Preview monitor
      </CapiroButton>
      {preview ? (
        <div>
          <p>
            {preview.targets.length} legal targets · {preview.matches.length} retained matches ·{' '}
            {preview.coverage.complete ? 'Qualified selected corpus' : 'Qualification required'}
          </p>
          <ul>
            {preview.gaps.map((g: string) => (
              <li key={g}>{g.replaceAll('_', ' ').toLowerCase()}</li>
            ))}
          </ul>
          <CapiroButton
            disabled={busy || !preview.coverage.complete}
            onClick={() =>
              action(async () => {
                await api.post(BASE + '/' + rule.id + '/activation', {
                  expectedVersion: rule.version,
                  enabled: true,
                  baseline: 'from_now',
                  previewHash: preview.previewHash,
                });
                await refresh();
                setStatus('Matching activated from now. Existing matches are baseline evidence.');
              })
            }
          >
            Activate matching from now
          </CapiroButton>
        </div>
      ) : null}
      {rule.state === 'active' ? (
        <>
          <CapiroButton
            disabled={busy}
            onClick={() =>
              action(async () => {
                const result = (await api.post<any>(BASE + '/' + rule.id + '/scan', {})).data;
                setStatus(
                  result.state === 'complete'
                    ? `${result.added} evidence records added.`
                    : 'Matching held for source or membership review.',
                );
                await refresh();
              })
            }
          >
            Check for new matches
          </CapiroButton>
          <CapiroButton
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api.post(BASE + '/' + rule.id + '/activation', {
                  expectedVersion: rule.version,
                  enabled: false,
                });
                await refresh();
              })
            }
          >
            Pause matching
          </CapiroButton>
        </>
      ) : null}
      <CapiroButton
        disabled={busy}
        onClick={() =>
          action(async () =>
            setEvents((await api.get<any[]>(BASE + '/' + rule.id + '/events')).data),
          )
        }
      >
        Show match history
      </CapiroButton>
      {events.map((event) => (
        <blockquote key={event.id}>
          {event.payload.quote}
          <footer>
            {event.baseline ? 'Historical baseline' : 'Newly observed evidence'} ·{' '}
            {event.payload.relation.replaceAll('_', ' ')} · {event.payload.locator}
          </footer>
        </blockquote>
      ))}
      {status ? <p role="status">{status}</p> : null}
    </article>
  );
}
