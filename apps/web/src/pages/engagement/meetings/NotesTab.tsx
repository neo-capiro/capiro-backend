import { App } from 'antd';
import { CalendarClock, StickyNote } from 'lucide-react';
import { useCancelNotetaker, useMeetingNotes } from './meetings-api.js';
import { Empty, MeriGlyph, SendMeriButton, eligibleForMeri } from './meetings-ui.js';
import { GeneratingState } from './tab-kit.js';
import type { Meeting } from './meetings-types.js';

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
        <p
          key={n.id}
          style={{
            fontSize: 13,
            lineHeight: 1.65,
            color: 'var(--ink-1)',
            margin: '0 0 18px',
            whiteSpace: 'pre-wrap',
          }}
        >
          {n.body}
        </p>
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
