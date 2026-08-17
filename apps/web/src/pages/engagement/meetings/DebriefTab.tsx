import { useEffect, useRef, useState } from 'react';
import { App } from 'antd';
import { Check, EyeOff, Lock, Mic, PenLine, Sparkles, Upload } from 'lucide-react';
import { parseDebriefBody } from '../meeting-actions.js';
import {
  useApproveDebrief,
  useGenerateDebriefDraft,
  useMeetingDebriefs,
  useMeetingNotes,
  useSaveDebrief,
  useUploadAndExtract,
} from './meetings-api.js';
import { exportArtifactPdf } from './meetings-print.js';
import { formatDayTitle } from './meetings-format.js';
import { Empty, MeriGlyph, SectionLabel } from './meetings-ui.js';
import { ArtifactActionBar, GeneratingState, RuleReinforcement, StagePill } from './tab-kit.js';
import type { Meeting, MeetingDebriefDraft } from './meetings-types.js';
import { EngagementDialog } from './EngagementDialog.js';

type DebriefStageTone = 'navy' | 'gray' | 'warn' | 'err';

/**
 * The Upload modal's pipeline explainer (design README §12 modal #9: "three
 * pipeline step rows... a step marker... and an explanation"). These
 * describe the REAL attachment pipeline, not invented copy:
 *   - Upload/Extract mirror useUploadAndExtract's own real three-call
 *     sequence (presigned S3 POST → confirm → extract-text; meetings-api.ts).
 *   - Delete describes the real `DELETE /attachments/:id` route
 *     (engagement.controller.ts) — a genuine backend capability with no
 *     frontend trigger in this modal yet, so it's listed as an explainer,
 *     not offered as an action here (nothing to wire it to would be built
 *     ahead of an actual delete affordance).
 */
const UPLOAD_PIPELINE_STEPS: Array<{ key: string; copy: string }> = [
  {
    key: 'Upload',
    copy: 'Requests a presigned upload URL, sends the file directly to storage, then confirms the attachment on this meeting.',
  },
  {
    key: 'Extract',
    copy: 'Extracts text from the confirmed attachment — audio and video are transcribed — so the debrief has a grounded source.',
  },
  {
    key: 'Delete',
    copy: 'Removing an attachment invalidates this meeting and calendar’s cached attachment lists so Library and Reports stay current.',
  },
];

/** The Debrief tab's top-of-tab stage pill (see tab-kit.js's StagePill / the
 *  Prep and Notes tabs' equivalents). Navy = approved; every blocked stage
 *  (locked/loading/generating/restricted/not-started) is gray — none of them
 *  are errors or need-attention states, just different reasons there's no
 *  approved debrief to show yet. */
function debriefStage(opts: {
  locked: boolean;
  loading: boolean;
  busy: boolean;
  hasCurrent: boolean;
  redraft: boolean;
  restricted: boolean;
  approved: boolean;
}): { label: string; tone: DebriefStageTone } {
  if (opts.locked) return { label: 'Locked', tone: 'gray' };
  if (opts.loading || opts.busy) return { label: 'Generating', tone: 'gray' };
  if (opts.restricted) return { label: 'Restricted', tone: 'gray' };
  if (!opts.hasCurrent || opts.redraft) return { label: 'Not started', tone: 'gray' };
  return opts.approved ? { label: 'Approved', tone: 'navy' } : { label: 'Draft', tone: 'gray' };
}

function formatDebriefBody(d: MeetingDebriefDraft): string {
  return [
    'Recap',
    d.recap.trim(),
    '',
    'Action Items',
    ...(d.actionItems.length ? d.actionItems.map((a) => `- ${a}`) : ['- (none)']),
    '',
    'Notes',
    d.notes.trim(),
  ].join('\n');
}

type Source = 'meri' | 'upload' | 'voice' | 'manual';

function SourcePicker({
  hasNotes,
  busy,
  onUseNotes,
  onManual,
  onFile,
}: {
  hasNotes: boolean;
  busy: boolean;
  onUseNotes: () => void;
  onManual: (text: string) => void;
  onFile: (file: File | undefined) => void;
}) {
  const [sel, setSel] = useState<Source>(hasNotes ? 'meri' : 'upload');
  const [manual, setManual] = useState('');
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cards: {
    k: Source;
    title: string;
    sub: string;
    icon: React.ReactNode;
    disabled?: boolean;
  }[] = [
    {
      k: 'meri',
      title: "Use Meri's Meeting Notes",
      sub: hasNotes
        ? 'Draft a debrief from the notes Meri captured — polish or edit it before sending.'
        : 'Available after Meri attends and summarizes this call.',
      icon: <MeriGlyph size={18} tone={sel === 'meri' ? 'white' : 'navy'} />,
      disabled: !hasNotes,
    },
    {
      k: 'upload',
      title: 'Upload Recording or Transcript',
      sub: 'Accepts audio, video, .txt, or .docx files.',
      icon: <Upload size={15} />,
    },
    {
      k: 'voice',
      title: 'Record Voice Memo',
      sub: 'Upload an audio memo to transcribe.',
      icon: <Mic size={15} />,
    },
    {
      k: 'manual',
      title: 'Type Notes Manually',
      sub: 'Use written context for the generated debrief.',
      icon: <PenLine size={15} />,
    },
  ];

  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)', margin: '0 0 16px' }}>
        Choose a source for this meeting's debrief. Meri turns it into a recap, action items, and
        intelligence gathered.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 16 }}>
        {cards.map((c) => {
          const on = sel === c.k;
          return (
            <button
              key={c.k}
              type="button"
              disabled={c.disabled}
              onClick={() => !c.disabled && setSel(c.k)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 11,
                textAlign: 'left',
                cursor: c.disabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-sans)',
                opacity: c.disabled ? 0.55 : 1,
                border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border-1)'}`,
                background: on ? 'var(--accent-soft)' : 'var(--bg-surface)',
                borderRadius: 9,
                padding: '12px 14px',
              }}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: on ? 'var(--accent)' : 'var(--bg-sunken)',
                  color: on ? '#fff' : 'var(--ink-3)',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                {c.icon}
              </span>
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: 'var(--ink-1)',
                  }}
                >
                  {c.title}
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c.sub}</span>
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  flexShrink: 0,
                  border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
                  background: on ? 'var(--accent)' : 'transparent',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                {on && (
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />
                )}
              </span>
            </button>
          );
        })}
      </div>
      {sel === 'manual' && (
        <textarea
          rows={4}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Capture outcomes, decisions, commitments, and next steps…"
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 12.5,
            fontFamily: 'var(--font-sans)',
            border: '1px solid var(--border-1)',
            borderRadius: 8,
            resize: 'vertical',
            lineHeight: 1.55,
            color: 'var(--ink-1)',
            background: 'var(--bg-surface)',
            outline: 'none',
            boxSizing: 'border-box',
            marginBottom: 16,
          }}
        />
      )}
      {(sel === 'upload' || sel === 'voice') && (
        <button
          type="button"
          className="engagement-source-upload"
          onClick={() => setSourceDialogOpen(true)}
        >
          {sel === 'voice' ? <Mic size={20} /> : <Upload size={20} />}
          <strong>{sel === 'voice' ? 'Add a voice memo' : 'Add a recording or transcript'}</strong>
          <span>Open the source window to choose the exact file Meri may use.</span>
        </button>
      )}
      <EngagementDialog
        open={sourceDialogOpen}
        eyebrow="Meeting · attachments"
        title="Transcript and attachments"
        description={
          sel === 'voice'
            ? 'Choose the voice memo that should be transcribed and used as the debrief source.'
            : 'Choose an audio, video, text, PDF, or Word source. Generation stays grounded in the extracted source text.'
        }
        width={620}
        busy={busy}
        onClose={() => setSourceDialogOpen(false)}
        footer={
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setSourceDialogOpen(false)}
          >
            Cancel
          </button>
        }
      >
        <label className="engagement-source-upload">
          {sel === 'voice' ? <Mic size={24} /> : <Upload size={24} />}
          <strong>Choose a file</strong>
          <span>
            {sel === 'voice'
              ? 'Audio and video files are transcribed before drafting.'
              : 'Audio, video, .txt, .md, .vtt, .srt, PDF, .doc, and .docx are supported.'}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,video/*,.txt,.md,.vtt,.srt,.pdf,.doc,.docx"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (!file) return;
              setSourceDialogOpen(false);
              onFile(file);
            }}
          />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          {UPLOAD_PIPELINE_STEPS.map((step) => (
            <div
              key={step.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'var(--bg-sunken)',
              }}
            >
              <span
                style={{
                  flex: '0 0 84px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--accent)',
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
                {step.key}
              </span>
              <span style={{ flex: 1, fontSize: 13, lineHeight: 1.45, color: 'var(--ink-2)' }}>
                {step.copy}
              </span>
            </div>
          ))}
        </div>
      </EngagementDialog>
      <button
        type="button"
        className="btn btn-accent"
        style={{ width: '100%', justifyContent: 'center', gap: 7 }}
        disabled={busy || (sel === 'meri' && !hasNotes)}
        onClick={() => {
          if (sel === 'meri') onUseNotes();
          else if (sel === 'manual') onManual(manual);
          else if (sel === 'upload' || sel === 'voice') setSourceDialogOpen(true);
        }}
      >
        {sel === 'meri' ? <MeriGlyph size={16} tone="white" /> : <Sparkles size={15} />}
        Generate Debrief
      </button>
    </div>
  );
}

export function DebriefTab({ meeting }: { meeting: Meeting }) {
  const { message } = App.useApp();
  const debriefs = useMeetingDebriefs(meeting.id);
  const current = debriefs.data?.[0] ?? null;
  // Poll while Meri is summarizing (mirrors NotesTab) so a note that lands
  // while the user is sitting on the Debrief tab self-enables "Use Meri's
  // Meeting Notes" without a manual refresh.
  const notes = useMeetingNotes(meeting.id, meeting.meri === 'attended');
  // Meri's summary note (most recent readable one) — the seed for "Use Meri's
  // Meeting Notes".
  const meriNotes = notes.data?.find((n) => n.body && !n.restricted)?.body ?? '';
  const generate = useGenerateDebriefDraft();
  const save = useSaveDebrief();
  const approve = useApproveDebrief();
  const uploadExtract = useUploadAndExtract();

  const [redraft, setRedraft] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editBody, setEditBody] = useState('');
  useEffect(() => setRedraft(false), [meeting.id]);

  // Action-item checkboxes are session-local only (see the interactive
  // action-items block below) — parseDebriefBody() regex-parses these from a
  // plain-text blob with no stable per-item id, so there's no real field to
  // persist a checked state against yet. Keyed by index and reset whenever the
  // underlying debrief changes so a stale check can't survive onto different
  // content.
  const [checkedItems, setCheckedItems] = useState<Record<number, boolean>>({});
  useEffect(() => setCheckedItems({}), [current?.id]);

  const busy = generate.isPending || save.isPending || uploadExtract.isPending;
  // Belt-and-suspenders: the Debrief tab button is disabled while the meeting
  // is still in progress (MeetingDetailPanel), but this guards direct access
  // (e.g. a ?detail=debrief deep link) from ever reaching the source picker.
  // Unlocked once the scheduled end passed OR Meri detected the call ended early
  // (all participants left) — meri is then 'attended' (summarizing) or 'done'.
  const locked =
    new Date(meeting.endsAt).getTime() > Date.now() &&
    meeting.meri !== 'attended' &&
    meeting.meri !== 'done';

  const draftAndSave = async (method: 'manual' | 'upload' | 'voice', sourceText: string) => {
    if (!sourceText.trim()) {
      message.warning('Add some notes or a transcript first.');
      return;
    }
    try {
      const draft = await generate.mutateAsync({ meetingId: meeting.id, method, sourceText });
      await save.mutateAsync({ meetingId: meeting.id, body: formatDebriefBody(draft) });
      message.success('Debrief drafted.');
      setRedraft(false);
    } catch (err) {
      // Without this catch, the onUseNotes / onManual `void draftAndSave(...)` callers
      // swallow a generation or save failure silently — no toast, and the debrief is
      // never persisted. (onFile already has its own try/catch for the upload step.)
      message.error(err instanceof Error ? err.message : 'Could not draft the debrief.');
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const isAudio =
        /^audio|^video/.test(file.type) || /\.(mp3|mp4|m4a|wav|webm|mpeg|mpga)$/i.test(file.name);
      const text = await uploadExtract.mutateAsync({
        meetingId: meeting.id,
        clientId: meeting.client?.id ?? null,
        file,
      });
      await draftAndSave(isAudio ? 'voice' : 'upload', text);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Could not process that file.');
    }
  };

  if (locked) {
    return (
      <>
        <StagePill
          {...debriefStage({
            locked: true,
            loading: false,
            busy: false,
            hasCurrent: false,
            redraft: false,
            restricted: false,
            approved: false,
          })}
        />
        <Empty
          icon={<Lock size={20} />}
          title="Debrief locked"
          body="Debrief unlocks once this meeting ends."
        />
      </>
    );
  }

  if (debriefs.isLoading) {
    return (
      <>
        <StagePill
          {...debriefStage({
            locked: false,
            loading: true,
            busy: false,
            hasCurrent: false,
            redraft: false,
            restricted: false,
            approved: false,
          })}
        />
        <GeneratingState label="Loading debrief…" />
      </>
    );
  }
  if (busy) {
    return (
      <>
        <StagePill
          {...debriefStage({
            locked: false,
            loading: false,
            busy: true,
            hasCurrent: Boolean(current),
            redraft,
            restricted: false,
            approved: false,
          })}
        />
        <GeneratingState
          label="Meri is drafting the debrief…"
          sub="Turning your source into a recap, action items, and intelligence gathered."
        />
      </>
    );
  }

  // No debrief (or re-drafting) → source picker
  if (!current || redraft) {
    const hasNotes = Boolean(meriNotes);
    return (
      <>
        <StagePill
          {...debriefStage({
            locked: false,
            loading: false,
            busy: false,
            hasCurrent: Boolean(current),
            redraft,
            restricted: false,
            approved: false,
          })}
        />
        <SourcePicker
          hasNotes={hasNotes}
          busy={busy}
          onUseNotes={() => void draftAndSave('manual', meriNotes)}
          onManual={(t) => void draftAndSave('manual', t)}
          onFile={(f) => void onFile(f)}
        />
      </>
    );
  }

  if (current.restricted || current.body == null) {
    return (
      <>
        <StagePill
          {...debriefStage({
            locked: false,
            loading: false,
            busy: false,
            hasCurrent: true,
            redraft: false,
            restricted: true,
            approved: false,
          })}
        />
        <Empty
          icon={<EyeOff size={20} />}
          title="A private debrief by another author exists"
          body="The record is visible but its body is not exposed. Your own debrief is authored separately from the same meeting."
        />
      </>
    );
  }

  const parsed = parseDebriefBody(current.body);
  const status = meeting.debriefs.find((d) => d.id === current.id)?.status ?? current.status;
  const onExport = () =>
    exportArtifactPdf(`Debrief — ${meeting.subject}`, formatDayTitle(new Date(meeting.startsAt)), [
      { heading: 'Recap', body: parsed.recap },
      { heading: 'Action Items', items: parsed.actionItems },
      { heading: 'Notes', body: parsed.notes },
    ]);

  return (
    <div>
      <StagePill
        {...debriefStage({
          locked: false,
          loading: false,
          busy: false,
          hasCurrent: true,
          redraft: false,
          restricted: false,
          approved: status === 'approved',
        })}
      />
      <div style={{ marginBottom: 20 }}>
        <SectionLabel style={{ marginBottom: 7 }}>Recap</SectionLabel>
        <p
          style={{
            fontSize: 13,
            lineHeight: 1.65,
            color: 'var(--ink-1)',
            margin: 0,
            // Preserve the recap's structure (narrative headings + the Key specifics
            // bullet list) instead of collapsing every newline into one paragraph.
            whiteSpace: 'pre-wrap',
          }}
        >
          {parsed.recap || 'No recap saved.'}
        </p>
      </div>
      {parsed.actionItems.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <SectionLabel style={{ marginBottom: 9 }}>Action items</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {parsed.actionItems.map((a, i) => {
              const checked = Boolean(checkedItems[i]);
              const toggle = () => setCheckedItems((cur) => ({ ...cur, [i]: !cur[i] }));
              return (
                <div
                  key={i}
                  role="checkbox"
                  aria-checked={checked}
                  tabIndex={0}
                  onClick={toggle}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggle();
                    }
                  }}
                  style={{
                    display: 'flex',
                    gap: 11,
                    padding: '10px 0',
                    borderBottom:
                      i < parsed.actionItems.length - 1 ? '1px solid var(--border-1)' : 'none',
                    alignItems: 'flex-start',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 17,
                      height: 17,
                      borderRadius: 4,
                      border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
                      background: checked ? 'var(--accent)' : 'transparent',
                      display: 'grid',
                      placeItems: 'center',
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    {checked && <Check size={12} strokeWidth={3} color="#fff" />}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: checked ? 'var(--ink-3)' : 'var(--ink-1)',
                      textDecoration: checked ? 'line-through' : 'none',
                    }}
                  >
                    {a}
                  </div>
                </div>
              );
            })}
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--ink-4)' }}>
            Checking items off is for this session only — it isn&apos;t saved.
          </p>
        </div>
      )}
      {parsed.notes && (
        <div>
          <SectionLabel style={{ marginBottom: 7 }}>Intelligence gathered</SectionLabel>
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.6,
              color: 'var(--ink-2)',
              padding: '11px 13px',
              background: 'var(--info-soft)',
              borderRadius: 8,
            }}
          >
            {parsed.notes}
          </div>
        </div>
      )}

      <ArtifactActionBar
        onRegenerate={() => setRedraft(true)}
        onEdit={() => {
          setEditBody(current.body ?? '');
          setEditOpen(true);
        }}
        onExport={onExport}
        approved={status === 'approved'}
        shared={current.sharedAt != null}
        onApprove={async () => {
          await approve.mutateAsync({ meetingId: meeting.id, debriefId: current.id });
          message.success('Debrief approved.');
        }}
        approving={approve.isPending}
      />
      <RuleReinforcement>
        Approval unlocks explicit sharing; export remains available either way.
      </RuleReinforcement>

      <EngagementDialog
        open={editOpen}
        eyebrow="Meeting · secondary actions"
        title="Edit debrief"
        description="Edit the exact debrief body. Approval and sharing remain separate actions."
        width={680}
        busy={save.isPending}
        busyLabel="Saving debrief…"
        error={save.isError ? 'Could not save the debrief. Your edits are still here.' : null}
        dirty={editBody !== (current.body ?? '')}
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={save.isPending}
              onClick={() => setEditOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={save.isPending || !editBody.trim()}
              onClick={async () => {
                await save.mutateAsync({
                  meetingId: meeting.id,
                  debriefId: current.id,
                  body: editBody,
                });
                message.success('Debrief updated.');
                setEditOpen(false);
              }}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <label className="engagement-dialog__field">
          Debrief
          <textarea
            autoFocus
            rows={16}
            value={editBody}
            onChange={(event) => setEditBody(event.target.value)}
          />
        </label>
      </EngagementDialog>
    </div>
  );
}
