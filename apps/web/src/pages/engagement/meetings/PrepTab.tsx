import { useState } from 'react';
import { App, Button, Input, Modal, Spin } from 'antd';
import {
  CheckCircleFilled,
  ExportOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useApprovePrep, useGeneratePrep } from './meetings-api.js';
import { exportArtifactPdf } from './meetings-print.js';
import { formatDayTitle } from './meetings-format.js';
import type { Meeting } from './meetings-types.js';

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mtg-section">
      <div className="mtg-section-label">{label}</div>
      {children}
    </div>
  );
}

export function PrepTab({ meeting, aiConfigured }: { meeting: Meeting; aiConfigured: boolean }) {
  const { message } = App.useApp();
  const prep = meeting.preps[0] ?? null;
  const generate = useGeneratePrep();
  const approve = useApprovePrep();
  const [addCtxOpen, setAddCtxOpen] = useState(false);
  const [addCtx, setAddCtx] = useState('');

  const runGenerate = async (additionalContext?: string) => {
    await generate.mutateAsync({ meetingId: meeting.id, additionalContext });
    message.success('Prep generated.');
  };

  if (generate.isPending) {
    return (
      <div className="mtg-empty-tab">
        <Spin /> <div style={{ marginTop: 8 }}>Meri is drafting your prep…</div>
      </div>
    );
  }

  if (!prep) {
    return (
      <div className="mtg-empty-tab">
        <p>No prep yet. Meri can draft talking points, an agenda, and watch-outs.</p>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={!aiConfigured}
          onClick={() => runGenerate()}
        >
          Generate Prep
        </Button>
        {!aiConfigured ? (
          <div style={{ color: 'var(--ink-3)', marginTop: 8, fontSize: 12 }}>
            AI isn&apos;t configured for your tenant yet.
          </div>
        ) : null}
      </div>
    );
  }

  const onExport = () =>
    exportArtifactPdf(`Prep — ${meeting.subject}`, formatDayTitle(new Date(meeting.startsAt)), [
      { heading: 'Summary', body: prep.summary ?? '' },
      { heading: 'Agenda', items: prep.agenda },
      { heading: 'Talking Points', items: prep.talkingPoints, ordered: true },
      { heading: 'Watch-outs', items: prep.risks },
      { heading: 'Follow-ups', items: prep.followUps },
    ]);

  return (
    <div>
      {prep.status === 'stale' ? (
        <div
          className="mtg-tab-banner"
          style={{ background: 'var(--notable-soft)', color: 'var(--notable)' }}
        >
          Context changed since this prep was generated — regenerate for the latest.
        </div>
      ) : (
        <div className="mtg-tab-banner">
          Meri drafted this prep from your client context and recent activity.
        </div>
      )}

      {prep.summary ? (
        <Section label="Summary">
          <p style={{ margin: 0 }}>{prep.summary}</p>
        </Section>
      ) : null}

      {prep.agenda.length ? (
        <Section label="Agenda">
          <ul className="engagement-bullet-list">
            {prep.agenda.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {prep.talkingPoints.length ? (
        <Section label="Talking Points">
          {prep.talkingPoints.map((t, i) => (
            <div className="mtg-talking-point" key={i}>
              <span className="idx">{String(i + 1).padStart(2, '0')}</span>
              <span>{t}</span>
            </div>
          ))}
        </Section>
      ) : null}

      {prep.risks.length ? (
        <Section label="Watch-outs">
          {prep.risks.map((r, i) => (
            <div className="mtg-watchout" key={i} style={{ marginBottom: 6 }}>
              {r}
            </div>
          ))}
        </Section>
      ) : null}

      {prep.followUps.length ? (
        <Section label="Follow-ups">
          <ul className="engagement-bullet-list">
            {prep.followUps.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="mtg-tab-actions">
        <Button
          size="small"
          icon={<ReloadOutlined />}
          disabled={!aiConfigured}
          onClick={() => runGenerate()}
        >
          Regenerate
        </Button>
        <Button size="small" disabled={!aiConfigured} onClick={() => setAddCtxOpen(true)}>
          Add context
        </Button>
        <Button size="small" icon={<ExportOutlined />} onClick={onExport}>
          Export PDF
        </Button>
        {prep.status === 'approved' ? (
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
              await approve.mutateAsync(prep.id);
              message.success('Prep approved.');
            }}
          >
            Approve
          </Button>
        )}
      </div>

      <Modal
        title="Add context and regenerate"
        open={addCtxOpen}
        onCancel={() => setAddCtxOpen(false)}
        okText="Regenerate"
        confirmLoading={generate.isPending}
        rootClassName="redesign"
        onOk={async () => {
          await runGenerate(addCtx.trim() || undefined);
          setAddCtx('');
          setAddCtxOpen(false);
        }}
      >
        <Input.TextArea
          rows={4}
          value={addCtx}
          onChange={(e) => setAddCtx(e.target.value)}
          placeholder="Anything Meri should factor in — a recent development, the ask, sensitivities…"
        />
      </Modal>
    </div>
  );
}
