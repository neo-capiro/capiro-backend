import { useEffect, useRef, useState } from 'react';
import { App, Input, Modal } from 'antd';
import { Lock, Mic, PenLine, Sparkles, Upload } from 'lucide-react';
import { parseDebriefBody } from '../meeting-actions.js';
import {
  useApproveDebrief,
  useGenerateDebriefDraft,
  useMeetingDebriefs,
  useSaveDebrief,
  useUploadAndExtract,
} from './meetings-api.js';
import { exportArtifactPdf } from './meetings-print.js';
import { formatDayTitle } from './meetings-format.js';
import { Empty, MeriGlyph, SectionLabel } from './meetings-ui.js';
import { ArtifactActionBar, GeneratingState } from './tab-kit.js';
import type { Meeting, MeetingDebriefDraft } from './meetings-types.js';

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
  onManual,
  onFile,
}: {
  hasNotes: boolean;
  busy: boolean;
  onManual: (text: string) => void;
  onFile: (file: File | undefined) => void;
}) {
  const [sel, setSel] = useState<Source>(hasNotes ? 'meri' : 'upload');
  const [manual, setManual] = useState('');
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
        ? 'A debrief drafts automatically once Meri summarizes this call.'
        : 'Available after Meri attends and summarizes this call.',
      icon: <MeriGlyph size={18} tone={sel === 'meri' ? 'white' : 'navy'} />,
      disabled: true,
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
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          style={{
            border: '1.5px dashed var(--border-strong)',
            borderRadius: 9,
            padding: '22px',
            textAlign: 'center',
            color: 'var(--ink-3)',
            fontSize: 12.5,
            marginBottom: 16,
            background: 'var(--bg-surface-2)',
            cursor: 'pointer',
          }}
        >
          {sel === 'voice' ? (
            <Mic size={20} style={{ opacity: 0.5 }} />
          ) : (
            <Upload size={20} style={{ opacity: 0.5 }} />
          )}
          <div style={{ marginTop: 6 }}>
            Drop a file here or{' '}
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>browse</span>
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/*,.txt,.md,.vtt,.srt,.pdf,.doc,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="btn btn-accent"
        style={{ width: '100%', justifyContent: 'center', gap: 7 }}
        disabled={busy || sel === 'meri'}
        onClick={() => {
          if (sel === 'manual') onManual(manual);
          else if (sel === 'upload' || sel === 'voice') fileRef.current?.click();
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
  const generate = useGenerateDebriefDraft();
  const save = useSaveDebrief();
  const approve = useApproveDebrief();
  const uploadExtract = useUploadAndExtract();

  const [redraft, setRedraft] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editBody, setEditBody] = useState('');
  useEffect(() => setRedraft(false), [meeting.id]);

  const busy = generate.isPending || save.isPending || uploadExtract.isPending;
  // Belt-and-suspenders: the Debrief tab button is disabled while the meeting
  // is still in progress (MeetingDetailPanel), but this guards direct access
  // (e.g. a ?detail=debrief deep link) from ever reaching the source picker.
  const locked = new Date(meeting.endsAt).getTime() > Date.now();

  const draftAndSave = async (method: 'manual' | 'upload' | 'voice', sourceText: string) => {
    if (!sourceText.trim()) {
      message.warning('Add some notes or a transcript first.');
      return;
    }
    const draft = await generate.mutateAsync({ meetingId: meeting.id, method, sourceText });
    await save.mutateAsync({ meetingId: meeting.id, body: formatDebriefBody(draft) });
    message.success('Debrief drafted.');
    setRedraft(false);
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
      <Empty
        icon={<Lock size={20} />}
        title="Debrief locked"
        body="Debrief unlocks once this meeting ends."
      />
    );
  }

  if (debriefs.isLoading) return <GeneratingState label="Loading debrief…" />;
  if (busy) {
    return (
      <GeneratingState
        label="Meri is drafting the debrief…"
        sub="Turning your source into a recap, action items, and intelligence gathered."
      />
    );
  }

  // No debrief (or re-drafting) → source picker
  if (!current || redraft) {
    const hasNotes = (meeting.notes && meeting.notes.length > 0) || meeting.meri === 'done';
    return (
      <SourcePicker
        hasNotes={hasNotes}
        busy={busy}
        onManual={(t) => void draftAndSave('manual', t)}
        onFile={(f) => void onFile(f)}
      />
    );
  }

  if (current.restricted || current.body == null) {
    return (
      <div style={{ color: 'var(--ink-3)', fontSize: 13, padding: '20px 0' }}>
        This debrief is private to its author.
      </div>
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
      <div style={{ marginBottom: 20 }}>
        <SectionLabel style={{ marginBottom: 7 }}>Recap</SectionLabel>
        <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--ink-1)', margin: 0 }}>
          {parsed.recap || 'No recap saved.'}
        </p>
      </div>
      {parsed.actionItems.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <SectionLabel style={{ marginBottom: 9 }}>Action items</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {parsed.actionItems.map((a, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 11,
                  padding: '10px 0',
                  borderBottom:
                    i < parsed.actionItems.length - 1 ? '1px solid var(--border-1)' : 'none',
                  alignItems: 'flex-start',
                }}
              >
                <span
                  style={{
                    width: 17,
                    height: 17,
                    borderRadius: 4,
                    border: '1.5px solid var(--border-strong)',
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                />
                <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-1)' }}>
                  {a}
                </div>
              </div>
            ))}
          </div>
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
        onApprove={async () => {
          await approve.mutateAsync({ meetingId: meeting.id, debriefId: current.id });
          message.success('Debrief approved.');
        }}
        approving={approve.isPending}
      />

      <Modal
        title="Edit debrief"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        okText="Save"
        confirmLoading={save.isPending}
        rootClassName="redesign"
        width={560}
        onOk={async () => {
          await save.mutateAsync({ meetingId: meeting.id, debriefId: current.id, body: editBody });
          message.success('Debrief updated.');
          setEditOpen(false);
        }}
      >
        <Input.TextArea rows={12} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
      </Modal>
    </div>
  );
}
