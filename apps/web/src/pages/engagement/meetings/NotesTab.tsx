import { useState } from 'react';
import { App } from 'antd';
import { CalendarClock, StickyNote } from 'lucide-react';
import {
  useApproveNote,
  useCancelNotetaker,
  useMeetingNotes,
  useUpdateNote,
} from './meetings-api.js';
import { Empty, MeriGlyph, SendMeriButton, eligibleForMeri } from './meetings-ui.js';
import { GeneratingState } from './tab-kit.js';
import type { Meeting, MeetingNote } from './meetings-types.js';

/** Phase 2 §3.e — Draft/Edited/Approved status pill, distinct from "Summarized". */
function noteStatusPill(status: MeetingNote['status']) {
  if (status === 'approved') return <span className="pill success">Approved</span>;
  if (status === 'edited') return <span className="pill notable">Edited</span>;
  return <span className="pill muted">Draft</span>;
}

/** One note's body + Edit/Approve controls (Phase 2 §3.e). */
function NoteRow({ meetingId, note }: { meetingId: string; note: MeetingNote }) {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body ?? '');
  const update = useUpdateNote();
  const approve = useApproveNote();

  const save = async () => {
    try {
      await update.mutateAsync({ meetingId, noteId: note.id, body: draft });
      setEditing(false);
    } catch {
      message.error('Could not save the note.');
    }
  };

  return (
    <div style={{ margin: '0 0 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {noteStatusPill(note.status)}
        {!editing && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setDraft(note.body ?? '');
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
        {!editing && note.status !== 'approved' && (
          <button
            type="button"
            className="btn sm btn-accent"
            disabled={approve.isPending}
            onClick={() =>
              approve
                .mutateAsync({ meetingId, noteId: note.id })
                .catch(() => message.error('Could not approve the note.'))
            }
          >
            Approve
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            style={{
              width: '100%',
              fontSize: 13,
              lineHeight: 1.65,
              padding: 8,
              borderRadius: 6,
              border: '1px solid var(--border-2)',
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="button" className="btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn sm btn-accent"
              disabled={update.isPending || !draft.trim()}
              onClick={save}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p
          style={{
            fontSize: 13,
            lineHeight: 1.65,
            color: 'var(--ink-1)',
            margin: 0,
            whiteSpace: 'pre-wrap',
          }}
        >
          {note.body}
        </p>
      )}
    </div>
  );
}

/**
 * Meeting Notes tab = Meri's canonical record of the call (notes-first). After
 * Meri attends, this shows a "summarizing" state while the transcript is turned
 * into notes, then renders the summary here — the actual summary lands on THIS
 * tab, not Debrief. The Debrief tab is where those notes optionally become a
 * polished, sendable debrief.
 */
export function NotesTab({
  meeting: m,
  onSendMeri,
  onGoToDebrief,
}: {
  meeting: Meeting;
  onSendMeri: (m: Meeting) => void;
  onGoToDebrief: () => void;
}) {
  const { message, modal } = App.useApp();
  const cancel = useCancelNotetaker();
  const scheduled = m.meri === 'scheduled' || m.meri === 'attending';
  // Call ended (all participants left, or the scheduled end passed) and Meri is
  // turning the transcript into meeting notes.
  const summarizing = m.meri === 'attended';
  // Poll for the summary while Meri is summarizing so it lands without a refresh.
  const notes = useMeetingNotes(m.id, summarizing);
  const noteRows = (notes.data ?? []).filter((n) => n.body && !n.restricted);
  const hasNotes = noteRows.length > 0;

  const cancelMeri = () =>
    modal.confirm({
      title: 'Cancel Meri?',
      content: "Meri will leave the call and won't capture notes.",
      okText: 'Cancel Meri',
      okButtonProps: { danger: true },
      rootClassName: 'redesign',
      onOk: async () => {
        await cancel.mutateAsync(m.id);
        message.success('Meri cancelled.');
      },
    });

  // Meeting is over and Meri is turning the transcript into notes — surface this
  // immediately on the Notes tab.
  if (summarizing && !hasNotes) {
    return (
      <GeneratingState
        label="Meri is summarizing the meeting…"
        sub="Meri attended and is turning the transcript into meeting notes. They'll appear here in a moment."
      />
    );
  }

  if (notes.isLoading && m.meri === 'done') {
    return <GeneratingState label="Loading notes…" />;
  }

  if (!hasNotes) {
    if (scheduled) {
      return (
        <Empty
          icon={<CalendarClock size={20} />}
          title="Meri Attending"
          body="Meri will attend this meeting and take notes. Meeting notes will automatically populate here after Meri attends and summarizes the call."
          action={
            <button type="button" className="btn sm" onClick={cancelMeri}>
              Cancel Meri
            </button>
          }
        />
      );
    }
    if (eligibleForMeri(m)) {
      return (
        <Empty
          icon={<StickyNote size={20} />}
          title="No notes yet"
          body="Meeting notes will automatically populate here after Meri attends and summarizes the call. Use Send Meri to have Meri attend."
          action={<SendMeriButton m={m} onClick={() => onSendMeri(m)} size="sm" />}
        />
      );
    }
    return (
      <Empty
        icon={<StickyNote size={20} />}
        title="Notes unavailable"
        body="Meri takes notes on virtual meetings with an online join link. This meeting doesn't have one, so Meri can't attend."
      />
    );
  }

  const who = m.notetakers && m.notetakers.length > 0 ? m.notetakers : [];
  const capturedBy =
    who.length > 1 ? `${who.length} notetakers` : who.length === 1 ? `${who[0]}'s Meri` : 'Meri';

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: 'var(--ink-3)',
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <MeriGlyph size={18} />
        <span>
          Auto-captured by <b style={{ color: 'var(--ink-2)' }}>{capturedBy}</b>
        </span>
        {who.length > 1 && (
          <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>({who.join(', ')})</span>
        )}
        <span className="pill success" style={{ fontSize: 10 }}>
          Summarized
        </span>
      </div>

      {noteRows.map((n) => (
        <NoteRow key={n.id} meetingId={m.id} note={n} />
      ))}

      <button
        type="button"
        className="btn sm btn-accent"
        style={{ gap: 6 }}
        onClick={onGoToDebrief}
      >
        Draft a debrief from these notes
      </button>
    </div>
  );
}
