/*
 * Meri command box (NOD-4 / MRI-3 / CRT-5 / REF-4). Tall textarea (Enter
 * submits, Shift+Enter newline), paperclip attach with removable chips (clio
 * attachment pipeline → attachmentIds), send button. Stateless about what
 * happens on submit — the parent owns the mutation + busy state and receives
 * (text, attachmentIds).
 */
import { useRef, useState } from 'react';
import { App } from 'antd';
import { Icon, iconBtn } from './strategy-ui.js';
import { useUploadAttachment } from './api.js';

interface Chip {
  localId: string;
  filename: string;
  id: string | null;
  uploading: boolean;
}

let seq = 0;

export function AskMeri({
  placeholder,
  onSubmit,
  busy = false,
  tall = false,
}: {
  placeholder: string;
  onSubmit: (text: string, attachmentIds: string[]) => void;
  busy?: boolean;
  tall?: boolean;
}) {
  const { message } = App.useApp();
  const upload = useUploadAttachment();
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploading = chips.some((c) => c.uploading);
  const canSend = text.trim().length > 0 && !busy && !uploading;

  const pick = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 8)) {
      const localId = `a${seq++}`;
      setChips((cs) => [...cs, { localId, filename: file.name, id: null, uploading: true }]);
      upload
        .mutateAsync(file)
        .then((res) => {
          if (!res.id) {
            message.warning(`${file.name} could not be attached.`);
            setChips((cs) => cs.filter((c) => c.localId !== localId));
          } else {
            setChips((cs) => cs.map((c) => (c.localId === localId ? { ...c, id: res.id, uploading: false } : c)));
          }
        })
        .catch(() => {
          message.error(`Could not upload ${file.name}.`);
          setChips((cs) => cs.filter((c) => c.localId !== localId));
        });
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = () => {
    if (!canSend) return;
    onSubmit(
      text.trim(),
      chips.filter((c) => c.id).map((c) => c.id as string),
    );
    setText('');
    setChips([]);
  };

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Ignore Enter while an IME composition is in flight, else confirming
          // a candidate submits (and clears) partial text.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        rows={tall ? 3 : 2}
        disabled={busy}
        style={{
          width: '100%',
          border: '1px solid var(--border-2)',
          borderRadius: 9,
          padding: '9px 11px',
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
          color: 'var(--ink-1)',
          background: 'var(--bg-surface)',
          resize: 'none',
          lineHeight: 1.45,
          boxSizing: 'border-box',
        }}
      />
      {chips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {chips.map((c) => (
            <span
              key={c.localId}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 'var(--text-2xs)',
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-2)',
                borderRadius: 6,
                padding: '3px 7px',
                color: 'var(--ink-2)',
                opacity: c.uploading ? 0.6 : 1,
              }}
            >
              <Icon name="paperclip" size={11} color="var(--ink-3)" />
              <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.filename}
              </span>
              {c.uploading ? (
                <span style={{ fontSize: 8 }}>…</span>
              ) : (
                <span
                  onClick={() => setChips((cs) => cs.filter((x) => x.localId !== c.localId))}
                  style={{ cursor: 'pointer', display: 'grid' }}
                >
                  <Icon name="x" size={10} color="var(--ink-4)" />
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => pick(e.target.files)}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Attach a document"
          style={{ ...iconBtn, border: '1px solid var(--border-2)', width: 30, height: 30 }}
        >
          <Icon name="paperclip" size={14} color="var(--ink-3)" />
        </button>
        <span style={{ flex: 1 }} />
        <button
          onClick={submit}
          disabled={!canSend}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 13px',
            borderRadius: 8,
            border: 'none',
            background: canSend ? 'var(--accent)' : 'var(--border-2)',
            color: '#fff',
            fontSize: 'var(--text-sm)',
            fontWeight: 700,
            cursor: canSend ? 'pointer' : 'not-allowed',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {busy ? 'Working…' : 'Send'}
          {!busy && <Icon name="arrow" size={13} color="#fff" />}
        </button>
      </div>
    </div>
  );
}
