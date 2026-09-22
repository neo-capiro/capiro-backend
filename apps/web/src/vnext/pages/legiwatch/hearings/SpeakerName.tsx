/**
 * Transcript speaker with inline rename. The name map is per diarization label,
 * so one rename renames every segment with that label (useRenameSpeaker).
 * Enter/blur save, Escape cancels; a failed save is reported beside the name.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { speakerDisplay } from '../lib/hearing-detail-states.js';
import { w1Error } from '../lib/wave1-api.js';

export function SpeakerName({
  segment,
  onRename,
}: {
  segment: { speakerName?: string | null; speakerLabel?: string | null };
  onRename: (label: string, displayName: string) => Promise<unknown>;
}) {
  const display = speakerDisplay(segment);
  const label = segment.speakerLabel?.trim();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter commits and the input then blurs on unmount; only the first wins.
  const settled = useRef(true);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!display) return null;
  if (!label) return <strong style={{ fontSize: 13 }}>{display}</strong>;

  const start = () => {
    setValue(display);
    setError(null);
    settled.current = false;
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = value.trim();
    if (!save || !next || next === display) return;
    setSaving(true);
    onRename(label, next)
      .catch((err: unknown) => setError(w1Error(err)))
      .finally(() => setSaving(false));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label="Speaker name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => finish(true)}
        style={{
          fontSize: 13,
          fontWeight: 600,
          padding: '0 6px',
          border: '1px solid var(--lw-control)',
          borderRadius: 6,
          width: 180,
        }}
      />
    );
  }
  return (
    <>
      <button
        type="button"
        className="lw-backlink"
        title="Rename speaker"
        style={{ padding: 0, fontSize: 13 }}
        disabled={saving}
        onClick={start}
      >
        {display}
      </button>
      {saving ? <span style={{ fontSize: 11, color: 'var(--lw-meta)' }}>Saving…</span> : null}
      {error ? (
        <span role="alert" style={{ fontSize: 11, color: 'var(--lw-danger, #b42318)' }}>
          {error}
        </span>
      ) : null}
    </>
  );
}
