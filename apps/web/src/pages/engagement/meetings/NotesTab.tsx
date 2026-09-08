import { useState } from 'react';
import { AlertTriangle, CalendarClock, FileText, StickyNote } from 'lucide-react';
import {
  useApproveNote,
  useCancelNotetaker,
  useMeetingNotes,
  useUpdateNote,
} from './meetings-api.js';
import { Empty, MeriGlyph, SendMeriButton, eligibleForMeri } from './meetings-ui.js';
import { GeneratingState, RuleReinforcement, StagePill } from './tab-kit.js';
import { isCancelledMeeting, type Meeting, type MeetingNote } from './meetings-types.js';
import { EngagementDialog } from './EngagementDialog.js';
import { useMeetingPanelChrome } from './meeting-panel-chrome.js';

type NotesStageTone = 'navy' | 'gray' | 'warn' | 'err';

/**
 * The Notes tab's top-of-tab stage pill (see tab-kit.js's StagePill / the Prep
 * tab's equivalent). Once notes exist, the label stays "Summarized" (the
 * existing completion word — NotesTab.test.tsx already asserts on it) while
 * the TONE switches to navy once `m.notesApproved` — approval is a separate,
 * later signal from completion (spec §j / the per-note Draft/Edited/Approved/
 * Shared pill in noteStatusPill below), same split the tab-strip dot fix
 * (MeetingDetailPanel.tsx) now also keys off `notesApproved` for. Every other
 * branch is a real, distinct stage rather than a single generic "empty".
 */
function notesStage(
  m: Meeting,
  hasNotes: boolean,
  summarizing: boolean,
  scheduled: boolean,
): { label: string; tone: NotesStageTone } {
  if (hasNotes) return m.notesApproved ? { label: 'Summarized', tone: 'navy' } : { label: 'Summarized', tone: 'gray' };
  if (summarizing) return { label: 'Summarizing', tone: 'gray' };
  if (m.meri === 'failed') return { label: 'Capture failed', tone: 'err' };
  if (scheduled) return { label: 'Attending', tone: 'gray' };
  if (eligibleForMeri(m)) return { label: 'Not started', tone: 'gray' };
  return { label: 'Unavailable', tone: 'gray' };
}

/**
 * Phase 2 §3.e/§3.j — Draft/Edited/Approved/Shared status pill, distinct from
 * the tab's own "Summarized" (completion) indicator above. Shared implies
 * approved (the server refuses to share an unapproved note), so it takes
 * priority in display — completion and approval/share are visibly different
 * signals, never conflated.
 */
function noteStatusPill(note: MeetingNote) {
  if (note.sharedAt) return <span className="pill success">Shared</span>;
  if (note.status === 'approved') return <span className="pill info">Approved</span>;
  if (note.status === 'edited') return <span className="pill notable">Edited</span>;
  return <span className="pill muted">Draft</span>;
}

/** One note's body + Edit/Approve controls (Phase 2 §3.e). */
function NoteRow({ meetingId, note }: { meetingId: string; note: MeetingNote }) {
  const chrome = useMeetingPanelChrome();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body ?? '');
  const update = useUpdateNote();
  const approve = useApproveNote();

  const save = async () => {
    try {
      await update.mutateAsync({ meetingId, noteId: note.id, body: draft });
      chrome.success('Meeting notes updated.');
      setEditing(false);
    } catch {
      chrome.error('Could not save the note.');
    }
  };

  return (
    <div style={{ margin: '0 0 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {noteStatusPill(note)}
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
        {note.status !== 'approved' && (
          <button
            type="button"
            className="btn sm btn-accent"
            disabled={approve.isPending}
            onClick={() =>
              approve
                .mutateAsync({ meetingId, noteId: note.id })
                .then(() => chrome.success('Meeting notes approved.'))
                .catch(() => chrome.error('Could not approve the note.'))
            }
          >
            Approve
          </button>
        )}
      </div>
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
      <EngagementDialog
        open={editing}
        eyebrow="Meeting · secondary actions"
        title="Edit meeting notes"
        description="Saving creates the current editable note state. Approval remains a separate action."
        width={660}
        busy={update.isPending}
        busyLabel="Saving notes…"
        error={update.isError ? 'Could not save the note. Your edits are still here.' : null}
        dirty={draft !== (note.body ?? '')}
        onClose={() => setEditing(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={update.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={update.isPending || !draft.trim()}
              onClick={() => void save()}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <label className="engagement-dialog__field">
          Meeting notes
          <textarea
            autoFocus
            rows={14}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
      </EngagementDialog>
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
  const chrome = useMeetingPanelChrome();
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
    chrome.confirm({
      title: 'Cancel Meri?',
      content: "Meri will leave the call and won't capture notes.",
      okText: 'Cancel Meri',
      danger: true,
      onOk: async () => {
        await cancel.mutateAsync(m.id);
        chrome.success('Meri cancelled.');
      },
    });

  if (isCancelledMeeting(m) && !hasNotes && !summarizing && !notes.isLoading) {
    return (
      <>
        <StagePill label="Cancelled" tone="gray" />
        <Empty icon={<CalendarClock size={20} />} title="Meeting cancelled"
          body="There are no saved notes for this cancelled meeting."
          action={scheduled ? <button type="button" className="btn sm" onClick={cancelMeri}>Cancel Meri</button> : undefined}
        />
      </>
    );
  }

  // Meeting is over and Meri is turning the transcript into notes — surface this
  // immediately on the Notes tab. Static tone panel, not a spinner: "follow the
  // prototype exactly" — the design's summarizing state is the same still-panel
  // shape as Notes' other four blocked stages (none/attending/failed/
  // unavailable below), not the generating spinner this used to reuse.
  if (summarizing && !hasNotes) {
    return (
      <>
        <StagePill {...notesStage(m, false, true, scheduled)} />
        <Empty
          icon={<FileText size={20} />}
          title="Summarizing the transcript"
          body="Meeting ended; Meri is turning the transcript into notes."
        />
      </>
    );
  }

  if (notes.isLoading && m.meri === 'done') {
    return (
      <>
        <StagePill label="Loading" tone="gray" />
        <GeneratingState label="Loading notes…" />
      </>
    );
  }

  // Meri was sent and did NOT capture the meeting (consent declined, provider
  // error, no-show) — distinct from "never sent" so this must say so instead of
  // quietly falling back to the same "No notes yet, Send Meri" prompt below.
  if (m.meri === 'failed' && !hasNotes) {
    return (
      <>
        <StagePill {...notesStage(m, false, false, scheduled)} />
        <Empty
          icon={<AlertTriangle size={20} />}
          title="Meri couldn't capture this meeting"
          body={m.meriError ?? 'Meri was sent to this meeting but was unable to take notes.'}
          action={<SendMeriButton m={m} onClick={() => onSendMeri(m)} size="sm" />}
        />
      </>
    );
  }

  if (!hasNotes) {
    if (scheduled) {
      return (
        <>
          <StagePill {...notesStage(m, false, false, true)} />
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
        </>
      );
    }
    if (eligibleForMeri(m)) {
      return (
        <>
          <StagePill {...notesStage(m, false, false, false)} />
          <Empty
            icon={<StickyNote size={20} />}
            title="No notes yet"
            body="Meeting notes will automatically populate here after Meri attends and summarizes the call. Use Send Meri to have Meri attend."
            action={<SendMeriButton m={m} onClick={() => onSendMeri(m)} size="sm" />}
          />
        </>
      );
    }
    return (
      <>
        <StagePill {...notesStage(m, false, false, false)} />
        <Empty
          icon={<StickyNote size={20} />}
          title="Notes unavailable"
          body="Meri takes notes on virtual meetings with an online join link. This meeting doesn't have one, so Meri can't attend."
        />
      </>
    );
  }

  const who = m.notetakers && m.notetakers.length > 0 ? m.notetakers : [];
  const capturedBy =
    who.length > 1 ? `${who.length} notetakers` : who.length === 1 ? `${who[0]}'s Meri` : 'Meri';

  return (
    <div>
      <StagePill {...notesStage(m, true, false, scheduled)} />
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
      </div>

      {noteRows.map((n) => (
        <NoteRow key={n.id} meetingId={m.id} note={n} />
      ))}

      {!isCancelledMeeting(m) && <button
        type="button"
        className="btn sm btn-accent"
        style={{ gap: 6 }}
        onClick={onGoToDebrief}
      >
        Draft a debrief from these notes
      </button>}
      <RuleReinforcement>
        Multiple notetakers are named. Notes are one shared summary; each person&apos;s own prep
        and debrief is retained separately.
      </RuleReinforcement>
    </div>
  );
}
