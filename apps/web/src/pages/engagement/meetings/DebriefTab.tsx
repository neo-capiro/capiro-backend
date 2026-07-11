import { useRef, useState } from 'react';
import { App, Button, Input, Modal, Spin } from 'antd';
import {
  AudioOutlined,
  CheckCircleFilled,
  CloudUploadOutlined,
  EditOutlined,
  ExportOutlined,
} from '@ant-design/icons';
import { DebriefNotesView, parseDebriefBody } from '../meeting-actions.js';
import {
  useApproveDebrief,
  useGenerateDebriefDraft,
  useMeetingDebriefs,
  useSaveDebrief,
  useUploadAndExtract,
} from './meetings-api.js';
import { exportArtifactPdf } from './meetings-print.js';
import { formatDayTitle } from './meetings-format.js';
import type { Meeting, MeetingDebriefDraft } from './meetings-types.js';

/** Assemble a debrief body from a draft so the web parseDebriefBody round-trips it. */
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

type SourceMode = null | 'manual';

export function DebriefTab({ meeting }: { meeting: Meeting }) {
  const { message } = App.useApp();
  const debriefs = useMeetingDebriefs(meeting.id);
  const current = debriefs.data?.[0] ?? null;
  const generate = useGenerateDebriefDraft();
  const save = useSaveDebrief();
  const approve = useApproveDebrief();
  const uploadExtract = useUploadAndExtract();

  const [mode, setMode] = useState<SourceMode>(null);
  const [manualText, setManualText] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editBody, setEditBody] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = generate.isPending || save.isPending || uploadExtract.isPending;

  const draftAndSave = async (method: 'manual' | 'upload' | 'voice', sourceText: string) => {
    if (!sourceText.trim()) {
      message.warning('Add some notes or a transcript first.');
      return;
    }
    const draft = await generate.mutateAsync({ meetingId: meeting.id, method, sourceText });
    await save.mutateAsync({ meetingId: meeting.id, body: formatDebriefBody(draft) });
    message.success('Debrief drafted.');
    setMode(null);
    setManualText('');
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await uploadExtract.mutateAsync({
        meetingId: meeting.id,
        clientId: meeting.client?.id ?? null,
        file,
      });
      await draftAndSave('upload', text);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Could not process that file.');
    }
  };

  if (debriefs.isLoading) {
    return (
      <div className="mtg-empty-tab">
        <Spin />
      </div>
    );
  }

  // ── Existing debrief ──────────────────────────────────────────────────────
  if (current) {
    if (current.restricted || current.body == null) {
      return <div className="mtg-empty-tab">This debrief is private to its author.</div>;
    }
    const status = meeting.debriefs.find((d) => d.id === current.id)?.status ?? current.status;
    const onExport = () => {
      const parsed = parseDebriefBody(current.body ?? '');
      exportArtifactPdf(
        `Debrief — ${meeting.subject}`,
        formatDayTitle(new Date(meeting.startsAt)),
        [
          { heading: 'Recap', body: parsed.recap },
          { heading: 'Action Items', items: parsed.actionItems },
          { heading: 'Notes', body: parsed.notes },
        ],
      );
    };
    return (
      <div>
        <DebriefNotesView body={current.body} />
        <div className="mtg-tab-actions">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditBody(current.body ?? '');
              setEditOpen(true);
            }}
          >
            Edit
          </Button>
          <Button size="small" icon={<ExportOutlined />} onClick={onExport}>
            Export PDF
          </Button>
          {status === 'approved' ? (
            <span className="mtg-approved-chip">
              <CheckCircleFilled /> Approved
            </span>
          ) : (
            <Button
              size="small"
              type="primary"
              loading={approve.isPending}
              style={{ marginLeft: 'auto' }}
              onClick={async () => {
                await approve.mutateAsync({ meetingId: meeting.id, debriefId: current.id });
                message.success('Debrief approved.');
              }}
            >
              Approve
            </Button>
          )}
        </div>
        <Modal
          title="Edit debrief"
          open={editOpen}
          onCancel={() => setEditOpen(false)}
          okText="Save"
          confirmLoading={save.isPending}
          rootClassName="redesign"
          width={560}
          onOk={async () => {
            await save.mutateAsync({
              meetingId: meeting.id,
              debriefId: current.id,
              body: editBody,
            });
            message.success('Debrief updated.');
            setEditOpen(false);
          }}
        >
          <Input.TextArea
            rows={12}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
          />
        </Modal>
      </div>
    );
  }

  // ── No debrief: Meri capturing ────────────────────────────────────────────
  if (meeting.meri === 'scheduled' || meeting.meri === 'attending') {
    return (
      <div className="mtg-empty-tab">
        Meri is capturing this meeting — a debrief will draft automatically once the call is
        summarized.
      </div>
    );
  }

  // ── No debrief: source cards (spec §5.2) ──────────────────────────────────
  if (busy) {
    return (
      <div className="mtg-empty-tab">
        <Spin /> <div style={{ marginTop: 8 }}>Meri is drafting your debrief…</div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ color: 'var(--ink-2)' }}>
        Capture what happened. Meri will structure it into a recap, action items, and notes.
      </p>
      <div className="mtg-source-cards">
        <div
          className="mtg-source-card"
          role="button"
          tabIndex={0}
          onClick={() => setMode('manual')}
        >
          <EditOutlined />
          <div className="mtg-source-card-label">Type Notes Manually</div>
        </div>
        <div
          className="mtg-source-card"
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
        >
          <CloudUploadOutlined />
          <div className="mtg-source-card-label">Upload Recording</div>
        </div>
        <div
          className="mtg-source-card"
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
        >
          <AudioOutlined />
          <div className="mtg-source-card-label">Voice / Audio File</div>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/*,.txt,.md,.vtt,.srt,.pdf,.doc,.docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          void onPickFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      <Modal
        title="Type your debrief notes"
        open={mode === 'manual'}
        onCancel={() => setMode(null)}
        okText="Draft with Meri"
        confirmLoading={busy}
        rootClassName="redesign"
        width={560}
        onOk={() => void draftAndSave('manual', manualText)}
      >
        <Input.TextArea
          rows={10}
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          placeholder="What happened, decisions, next steps, who owns what…"
        />
      </Modal>
    </div>
  );
}
