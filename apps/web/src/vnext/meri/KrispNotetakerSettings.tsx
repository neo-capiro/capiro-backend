import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../lib/use-api.js';

interface ImportedMeeting {
  id: string;
  title: string;
  startsAt: string;
  status: string;
  error: string | null;
}
interface Snapshot {
  preference: {
    enabled: boolean;
    folderId: string | null;
    lastCheckedAt: string | null;
    lastError: string | null;
  } | null;
  imports: ImportedMeeting[];
}
interface Candidate {
  id: string;
  subject: string;
  startsAt: string;
}
const BASE = '/api/clio/krisp-notetaker';

/** Mounted only for the server-authorized pilot app. API identity changes remount its state. */
export function KrispNotetakerSettings({ connected }: { connected: boolean }) {
  const api = useApi();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [enabled, setEnabled] = useState(false);
  const [folderId, setFolderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setFolders([]);
    setEditing(false);
    setError(null);
    const load = async (initial: boolean) => {
      try {
        const { data } = await api.get<Snapshot>(BASE);
        if (!active) return;
        setSnapshot(data);
        if (initial) {
          setEnabled(data.preference?.enabled ?? false);
          setFolderId(data.preference?.folderId ?? '');
        }
      } catch {
        if (active) setError('Krisp import settings could not be loaded.');
      }
    };
    void load(true);
    if (connected)
      void api
        .get<Array<{ id: string; name: string }>>(BASE + '/folders')
        .then(({ data }) => {
          if (active) setFolders(data);
        })
        .catch(() => {
          if (active) setError('Krisp folders could not be loaded. Reconnect Krisp and try again.');
        });
    const timer = setInterval(() => void load(false), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, connected]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<Snapshot>(BASE + '/preferences', {
        enabled,
        folderId: folderId || null,
      });
      setSnapshot(data);
      setEditing(false);
    } catch {
      setError('Settings could not be saved. Check your Krisp connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  const refresh = useCallback(async () => {
    const { data } = await api.get<Snapshot>(BASE);
    setSnapshot(data);
  }, [api]);
  const pending =
    snapshot?.imports.filter((item) => !['done', 'skipped'].includes(item.status)) ?? [];
  const completed = snapshot?.imports.filter((item) => item.status === 'done').length ?? 0;

  return (
    <section className="krisp-notetaker-settings" aria-label="Krisp automatic notes">
      <h2>Automatic meeting notes</h2>
      <p>
        Let Krisp capture your meetings. Meri checks every few minutes and saves notes and a debrief
        when the transcript is ready.
      </p>
      <label className="krisp-notetaker-settings__toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !snapshot || (!connected && !enabled)}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setEditing(true);
          }}
        />
        Automatically create Meri notes and debriefs from my Krisp meetings
      </label>
      <label className="krisp-notetaker-settings__folder">
        Import from
        <select
          value={folderId}
          disabled={busy || !connected}
          onChange={(event) => {
            setFolderId(event.target.value);
            setEditing(true);
          }}
        >
          <option value="">All new meetings I can access in Krisp</option>
          {folderId && !folders.some((folder) => folder.id === folderId) ? (
            <option value={folderId}>Selected folder (unavailable)</option>
          ) : null}
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      <p className="krisp-notetaker-settings__detail">
        Starts with meetings held after you enable this setting. Meri saves generated notes and
        debriefs to meetings you own, without automatically sharing them or retaining a raw
        transcript copy. Your originals remain in Krisp.
      </p>
      <button
        type="button"
        disabled={busy || !editing || (enabled && !connected)}
        onClick={() => void save()}
      >
        {busy ? 'Saving…' : 'Save import settings'}
      </button>
      {!connected ? <p>Connect your Krisp account above to start importing.</p> : null}
      {error || snapshot?.preference?.lastError ? (
        <p role="alert">{error ?? snapshot?.preference?.lastError}</p>
      ) : null}
      {snapshot?.preference?.lastCheckedAt ? (
        <p className="krisp-notetaker-settings__detail">
          Last checked {new Date(snapshot.preference.lastCheckedAt).toLocaleString()}. {completed}{' '}
          of the latest 50 imports completed.
        </p>
      ) : null}
      {pending.length ? (
        <div className="krisp-notetaker-settings__imports">
          <h3>Recent imports</h3>
          {pending.map((item) => (
            <ImportRow
              key={item.id}
              item={item}
              active={Boolean(connected && snapshot?.preference?.enabled)}
              onSaved={refresh}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ImportRow({
  item,
  active,
  onSaved,
}: {
  item: ImportedMeeting;
  active: boolean;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsMatch = ['needs_match', 'failed'].includes(item.status);
  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.get<Candidate[]>(`${BASE}/imports/${item.id}/candidates`);
      setCandidates(data);
    } catch {
      setError('Could not load your meetings. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const assign = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${BASE}/imports/${item.id}/match`, { meetingId: selected });
      await onSaved();
    } catch {
      setError('Could not assign this meeting. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="krisp-notetaker-settings__import">
      <strong>{item.title}</strong> <span>{new Date(item.startsAt).toLocaleString()}</span>
      <p>
        {item.status === 'needs_match'
          ? 'Choose the Meri meeting where these notes belong.'
          : (item.error ??
            (item.status === 'processing'
              ? 'Creating notes and debrief…'
              : 'Waiting for the next import check.'))}
      </p>
      {needsMatch && candidates === null ? (
        <button type="button" disabled={busy || !active} onClick={() => void choose()}>
          Choose meeting
        </button>
      ) : null}
      {needsMatch && candidates !== null ? (
        <>
          <select
            aria-label={`Meri meeting for ${item.title}`}
            value={selected}
            disabled={busy || !active}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select a meeting</option>
            {candidates.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.subject} — {new Date(candidate.startsAt).toLocaleString()}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!selected || busy || !active}
            onClick={() => void assign()}
          >
            Save to this meeting
          </button>
          {!candidates.length ? (
            <p>
              No meetings found near this time. Add the meeting to your Meri calendar first, then
              reopen this page.
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
