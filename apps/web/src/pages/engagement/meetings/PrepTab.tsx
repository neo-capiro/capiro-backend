import { useEffect, useState } from 'react';
import { App } from 'antd';
import { FileText, Link as LinkIcon, TriangleAlert } from 'lucide-react';
import { useApprovePrep, useGeneratePrep, useUpdatePrep } from './meetings-api.js';
import { exportArtifactPdf } from './meetings-print.js';
import { formatDayTitle } from './meetings-format.js';
import { Empty, MeriGlyph, SectionLabel } from './meetings-ui.js';
import { ArtifactActionBar, GeneratingState } from './tab-kit.js';
import type { Meeting } from './meetings-types.js';
import { EngagementDialog } from './EngagementDialog.js';

interface PrepEditValues {
  summary: string;
  agenda: string;
  talkingPoints: string;
  risks: string;
  followUps: string;
  emailEvidence: string;
}

function prepEditValues(prep: Meeting['preps'][number]): PrepEditValues {
  return {
    summary: prep.summary ?? '',
    agenda: prep.agenda.join('\n'),
    talkingPoints: prep.talkingPoints.join('\n'),
    risks: prep.risks.join('\n'),
    followUps: prep.followUps.join('\n'),
    emailEvidence: prep.emailEvidence.join('\n'),
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Prep tab — a port of the prototype PrepPanel. Meri drafts prep; the user
 *  refines (add context), regenerates, exports, and approves. */
export function PrepTab({ meeting, aiConfigured }: { meeting: Meeting; aiConfigured: boolean }) {
  const { message } = App.useApp();
  const prep = meeting.preps[0] ?? null;
  const generate = useGeneratePrep();
  const approve = useApprovePrep();
  const update = useUpdatePrep();
  const [refine, setRefine] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editValues, setEditValues] = useState<PrepEditValues>(() =>
    prep
      ? prepEditValues(prep)
      : {
          summary: '',
          agenda: '',
          talkingPoints: '',
          risks: '',
          followUps: '',
          emailEvidence: '',
        },
  );
  useEffect(() => {
    setRefine('');
    setEditOpen(false);
  }, [meeting.id]);

  const runGenerate = async (additionalContext?: string) => {
    await generate.mutateAsync({ meetingId: meeting.id, additionalContext });
    message.success('Prep generated.');
  };

  if (generate.isPending) {
    return (
      <GeneratingState
        label="Meri is drafting prep…"
        sub="Pulling from the client profile, synced email, and any prior debriefs. Meri won't invent details."
      />
    );
  }

  if (!prep) {
    return (
      <Empty
        icon={<FileText size={20} />}
        title="No prep generated yet"
        body="Meri drafts prep from the client profile, synced email, and prior debriefs."
        action={
          <button
            type="button"
            className="btn sm btn-accent"
            style={{ marginTop: 2, gap: 6 }}
            disabled={!aiConfigured}
            onClick={() => runGenerate()}
          >
            <MeriGlyph size={15} tone="white" />
            Generate with Meri
          </button>
        }
      />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {prep.status === 'stale' ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '9px 12px',
            borderRadius: 8,
            background: 'var(--notable-soft)',
            fontSize: 12,
            color: 'var(--notable)',
            alignItems: 'center',
          }}
        >
          <TriangleAlert size={14} />
          <span>Context changed since this prep was generated — regenerate for the latest.</span>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '9px 12px',
            borderRadius: 8,
            background: 'var(--accent-soft)',
            fontSize: 12,
            color: 'var(--accent-ink)',
            alignItems: 'center',
          }}
        >
          <LinkIcon size={13} />
          <span>Meri drafted this prep from your client context and recent activity.</span>
        </div>
      )}

      {prep.summary && (
        <div>
          <SectionLabel style={{ marginBottom: 7 }}>Summary</SectionLabel>
          <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--ink-2)', margin: 0 }}>
            {prep.summary}
          </p>
        </div>
      )}

      {prep.agenda.length > 0 && (
        <div>
          <SectionLabel style={{ marginBottom: 7 }}>Agenda</SectionLabel>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              color: 'var(--ink-1)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {prep.agenda.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {prep.talkingPoints.length > 0 && (
        <div>
          <SectionLabel style={{ marginBottom: 9 }}>Talking points</SectionLabel>
          <ul
            style={{
              margin: 0,
              paddingLeft: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {prep.talkingPoints.map((t, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  gap: 10,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: 'var(--ink-1)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--accent)',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {prep.risks.length > 0 && (
        <div>
          <SectionLabel style={{ marginBottom: 9 }}>Watch-outs</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {prep.risks.map((r, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 9,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: 'var(--ink-2)',
                  padding: '9px 12px',
                  background: 'var(--notable-soft)',
                  borderRadius: 7,
                }}
              >
                <TriangleAlert
                  size={14}
                  style={{ color: 'var(--notable)', flexShrink: 0, marginTop: 1 }}
                />
                {r}
              </div>
            ))}
          </div>
        </div>
      )}

      {prep.followUps.length > 0 && (
        <div>
          <SectionLabel style={{ marginBottom: 7 }}>Follow-ups</SectionLabel>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              color: 'var(--ink-2)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {prep.followUps.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <ArtifactActionBar
        refine
        refineValue={refine}
        onRefineChange={setRefine}
        refinePlaceholder="Add additional context you'd like Meri to use, then Regenerate."
        onRegenerate={() => void runGenerate(refine.trim() || undefined)}
        regenerating={generate.isPending}
        regenerateDisabled={!aiConfigured}
        onEdit={() => {
          setEditValues(prepEditValues(prep));
          setEditOpen(true);
        }}
        onExport={onExport}
        approved={prep.status === 'approved'}
        shared={prep.sharedAt != null}
        onApprove={async () => {
          await approve.mutateAsync(prep.id);
          message.success('Prep approved.');
        }}
        approving={approve.isPending}
      />
      <EngagementDialog
        open={editOpen}
        eyebrow="Meeting · secondary actions"
        title="Edit prep"
        description="Update the approved working content without changing the meeting record itself."
        width={720}
        busy={update.isPending}
        dirty={JSON.stringify(editValues) !== JSON.stringify(prepEditValues(prep))}
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={update.isPending}
              onClick={() => setEditOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={update.isPending}
              onClick={async () => {
                try {
                  await update.mutateAsync({
                    prepId: prep.id,
                    summary: editValues.summary.trim() || null,
                    agenda: splitLines(editValues.agenda),
                    talkingPoints: splitLines(editValues.talkingPoints),
                    risks: splitLines(editValues.risks),
                    followUps: splitLines(editValues.followUps),
                    emailEvidence: splitLines(editValues.emailEvidence),
                  });
                  message.success('Prep updated.');
                  setEditOpen(false);
                } catch {
                  message.error('Could not update the prep.');
                }
              }}
            >
              {update.isPending ? 'Saving…' : 'Save prep'}
            </button>
          </>
        }
      >
        <div className="engagement-dialog__field-grid">
          <label className="engagement-dialog__field is-full">
            Summary
            <textarea
              rows={4}
              value={editValues.summary}
              onChange={(event) =>
                setEditValues((current) => ({ ...current, summary: event.target.value }))
              }
            />
          </label>
          <label className="engagement-dialog__field">
            Agenda <small>One item per line</small>
            <textarea
              rows={7}
              value={editValues.agenda}
              onChange={(event) =>
                setEditValues((current) => ({ ...current, agenda: event.target.value }))
              }
            />
          </label>
          <label className="engagement-dialog__field">
            Talking points <small>One item per line</small>
            <textarea
              rows={7}
              value={editValues.talkingPoints}
              onChange={(event) =>
                setEditValues((current) => ({ ...current, talkingPoints: event.target.value }))
              }
            />
          </label>
          <label className="engagement-dialog__field">
            Watch-outs <small>One item per line</small>
            <textarea
              rows={6}
              value={editValues.risks}
              onChange={(event) =>
                setEditValues((current) => ({ ...current, risks: event.target.value }))
              }
            />
          </label>
          <label className="engagement-dialog__field">
            Follow-ups <small>One item per line</small>
            <textarea
              rows={6}
              value={editValues.followUps}
              onChange={(event) =>
                setEditValues((current) => ({ ...current, followUps: event.target.value }))
              }
            />
          </label>
          <label className="engagement-dialog__field is-full">
            Email evidence <small>One source note per line</small>
            <textarea
              rows={5}
              value={editValues.emailEvidence}
              onChange={(event) =>
                setEditValues((current) => ({ ...current, emailEvidence: event.target.value }))
              }
            />
          </label>
        </div>
      </EngagementDialog>
    </div>
  );
}
