/*
 * The pinned chat composer (Phase 2) — ported from the prototype's AskMeri box.
 *
 * Lives in the panel FOOTER, outside the message scroll container, so it stays
 * put no matter how long the thread gets. Stateless about what a send does: the
 * panel owns the mutation and the busy flag and receives (text, attachments).
 *
 * Replaces the old AskMeri component, whose box sat inline inside the scrolling
 * body and scrolled away with it.
 */
import { useRef, useState } from 'react';
import { App } from 'antd';
import { Icon } from './strategy-ui.js';
import { useUploadAttachment } from './api.js';
import type { StrategyChatAttachment } from './types.js';

interface Chip {
  localId: string;
  filename: string;
  /** null while the upload is still in flight. */
  id: string | null;
  kind: string;
  status: string;
  uploading: boolean;
}

let seq = 0;

export function StrategyChatComposer({
  placeholder,
  onSubmit,
  busy = false,
}: {
  placeholder: string;
  onSubmit: (text: string, attachments: StrategyChatAttachment[]) => void;
  busy?: boolean;
}) {
  const { message } = App.useApp();
  const upload = useUploadAttachment();
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploading = chips.some((c) => c.uploading);
  const ready = chips.filter((c) => c.id);
  // Text OR an attachment is enough — "read this" with a document attached is a
  // complete instruction. Still blocked while an upload is in flight, or the
  // send would drop the file it is about to reference.
  const canSend = (text.trim().length > 0 || ready.length > 0) && !busy && !uploading;

  const pick = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 8)) {
      const localId = `a${seq++}`;
      setChips((cs) => [
        ...cs,
        { localId, filename: file.name, id: null, kind: 'unsupported', status: 'uploading', uploading: true },
      ]);
      upload
        .mutateAsync(file)
        .then((res) => {
          if (!res.id) {
            message.warning(`${file.name} could not be attached.`);
            setChips((cs) => cs.filter((c) => c.localId !== localId));
          } else {
            setChips((cs) =>
              cs.map((c) =>
                c.localId === localId
                  ? { ...c, id: res.id, kind: res.kind, status: res.status, uploading: false }
                  : c,
              ),
            );
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
      ready.map((c) => ({ id: c.id as string, filename: c.filename, kind: c.kind, status: c.status })),
    );
    setText('');
    setChips([]);
  };

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1.5px solid var(--accent)',
        borderRadius: 9,
        boxShadow: '0 0 0 3px var(--accent-glow)',
      }}
    >
      {chips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '9px 11px 0' }}>
          {chips.map((c) => (
            <span
              key={c.localId}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--accent-soft)',
                border: '1px solid #C6D4F4',
                borderRadius: 6,
                padding: '3px 5px 3px 8px',
                fontSize: 'var(--text-2xs)',
                fontWeight: 600,
                color: 'var(--accent-ink)',
                maxWidth: 210,
                opacity: c.uploading ? 0.6 : 1,
              }}
            >
              <Icon name="paperclip" size={11} color="var(--accent-ink)" />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.filename}
              </span>
              <button
                onClick={() => setChips((cs) => cs.filter((x) => x.localId !== c.localId))}
                aria-label={`Remove ${c.filename}`}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 1,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 6,
                }}
              >
                <Icon name="x" size={11} color="var(--accent-ink)" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 11px' }}>
        <Icon name="spark" size={15} color="var(--accent)" />
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
          rows={1}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--ink-1)',
            resize: 'none',
            lineHeight: 1.4,
            // The prototype's global `*{padding:0;box-sizing:border-box}` zeroes
            // the UA's 2px textarea padding; this scope has no such reset, so
            // without these the composer row is 4px taller than the prototype's.
            padding: 0,
            boxSizing: 'border-box',
          }}
        />
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => pick(e.target.files)} />
        <button
          onClick={() => fileRef.current?.click()}
          title="Attach a file"
          aria-label="Attach a file"
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: 'var(--bg-sunken)',
            color: 'var(--ink-2)',
            border: '1px solid var(--border-2)',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Icon name="paperclip" size={14} color="var(--ink-2)" />
        </button>
        <button
          onClick={submit}
          disabled={!canSend}
          title="Send"
          aria-label="Send"
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            // Deliberately NOT greyed out when empty: the prototype's resting
            // state is a solid accent square, and that is the most-seen state of
            // this control. `disabled` still makes it inert and testable.
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            display: 'grid',
            placeItems: 'center',
            cursor: canSend ? 'pointer' : 'default',
            flexShrink: 0,
          }}
        >
          <Icon name={busy ? 'clock' : 'up'} size={14} color="#fff" />
        </button>
      </div>
    </div>
  );
}
