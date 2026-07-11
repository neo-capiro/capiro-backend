import { App } from 'antd';
import { CalendarClock, StickyNote } from 'lucide-react';
import { useCancelNotetaker } from './meetings-api.js';
import { Empty, MeriGlyph, SectionLabel, SendMeriButton, eligibleForMeri } from './meetings-ui.js';
import type { Meeting } from './meetings-types.js';

/**
 * Meeting Notes tab = the Meri notetaker surface (prototype NotesPanel). Notes
 * are Meri's canonical record of the call; the takeaways live in Debrief.
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
  const attending = m.meri === 'scheduled' || m.meri === 'attending';
  const hasNotes = (m.notes && m.notes.length > 0) || m.meri === 'done';

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

  if (!hasNotes) {
    if (attending) {
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
          action={<SendMeriButton m={m} onClick={onSendMeri} size="sm" />}
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
      <div>
        <SectionLabel style={{ marginBottom: 7 }}>Summary</SectionLabel>
        <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--ink-1)', margin: '0 0 18px' }}>
          Meri captured this meeting and drafted a debrief from the transcript. Open the Debrief tab
          for the recap, action items, and intelligence gathered.
        </p>
      </div>
      <button
        type="button"
        className="btn sm btn-accent"
        style={{ gap: 6 }}
        onClick={onGoToDebrief}
      >
        View the debrief
      </button>
    </div>
  );
}
