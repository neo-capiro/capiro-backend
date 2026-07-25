/*
 * P0-1 — restore impact preview.
 *
 * The audit's critical finding: restore used to replace the node set destructively,
 * silently taking Workspace/Outreach back-links and run linkage with it, behind a
 * one-line "the current plan will be replaced" confirm. The server side is now
 * non-destructive; this modal is the disclosure half — it shows exactly what the
 * restore will move BEFORE the user commits, with the three controls the audit
 * names: "Restore as new version", "View changes", "Cancel".
 *
 * Everything shown here comes from GET .../restore-impact, which the server derives
 * from the SAME diff module the restore write uses, so the preview cannot disagree
 * with the outcome.
 */
import { useState } from 'react';
import { Icon, Chip, Overlay, btnGhost, btnPrimary, iconBtn } from './strategy-ui.js';
import { useRestoreImpact } from './api.js';
import type { RestoreImpact, RestoreImpactChangedNode, RestoreImpactNodeRef } from './types.js';

/** Human labels for the compared field keys the diff reports. */
const FIELD_LABELS: Record<string, string> = {
  kind: 'type',
  subject: 'subject',
  title: 'title',
  note: 'notes',
  ownerUserId: 'owner',
  status: 'status',
  startsOn: 'start date',
  endsOn: 'end date',
  openEnded: 'ongoing flag',
  dependsOnIds: 'dependencies',
  targetRef: 'target',
};

function fieldLabel(f: string): string {
  return FIELD_LABELS[f] ?? f;
}

export function RestoreImpactModal({
  strategyId,
  versionId,
  versionLabel,
  restoring,
  onConfirm,
  onClose,
}: {
  strategyId: string;
  versionId: string;
  /** Relative time of the version being restored, for the header line. */
  versionLabel: string;
  restoring: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const impact = useRestoreImpact(strategyId, versionId);
  const [showChanges, setShowChanges] = useState(false);
  const data = impact.data;

  return (
    <Overlay onClose={onClose}>
      <div
        style={{
          width: 620,
          maxHeight: '84vh',
          background: 'var(--bg-surface)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(12,26,56,0.28)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '16px 22px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--ink-1)' }}>
              Restore as new version
            </div>
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 2 }}>
              Restoring the version from {versionLabel}. Nothing is deleted — steps this version
              doesn't contain are archived and stay in history.
            </div>
          </div>
          <button onClick={onClose} style={iconBtn} aria-label="Close">
            <Icon name="x" size={16} color="var(--ink-3)" />
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '14px 22px' }}>
          {impact.isLoading ? (
            <div style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)', padding: '10px 0' }}>
              Checking what this restore would change…
            </div>
          ) : impact.isError || !data ? (
            <div
              style={{
                background: 'var(--critical-soft)',
                color: 'var(--critical)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 'var(--text-sm)',
              }}
            >
              Could not load the restore preview. Restoring without it is not offered — close this
              and try again.
            </div>
          ) : (
            <>
              {data.noOp && (
                <Banner tone="info">
                  This version matches the current plan. Restoring it would change nothing.
                </Banner>
              )}

              <SummaryGrid data={data} />

              {data.runs.activeCount > 0 && (
                <Banner tone="critical">
                  {data.runs.activeCount} in-flight execution{' '}
                  {data.runs.activeCount === 1 ? 'run references' : 'runs reference'} a step this
                  restore archives. {data.runs.activeCount === 1 ? 'It' : 'They'} stay readable, but
                  will no longer point at a live step — cancel or finish{' '}
                  {data.runs.activeCount === 1 ? 'it' : 'them'} first if that matters.
                </Banner>
              )}

              {(data.artifacts.workspaceDraftsAffected > 0 ||
                data.artifacts.outreachRecordsAffected > 0) && (
                <Banner tone="notable">
                  {data.artifacts.workspaceDraftsAffected} Workspace draft
                  {data.artifacts.workspaceDraftsAffected === 1 ? '' : 's'} and{' '}
                  {data.artifacts.outreachRecordsAffected} Outreach record
                  {data.artifacts.outreachRecordsAffected === 1 ? '' : 's'} become historical. The
                  documents themselves are not deleted and stay listed under detached steps.
                </Banner>
              )}

              {data.provenance.nodesReCreatedWithoutProvenance > 0 &&
                !data.provenance.snapshotCarriesProvenance && (
                  <Banner tone="notable">
                    This snapshot predates grounding capture, so{' '}
                    {data.provenance.nodesReCreatedWithoutProvenance} re-created step
                    {data.provenance.nodesReCreatedWithoutProvenance === 1 ? '' : 's'} will come
                    back without source citations.
                  </Banner>
                )}

              {showChanges && <ChangeDetail data={data} />}
            </>
          )}
        </div>

        <div
          style={{
            padding: '12px 22px',
            borderTop: '1px solid var(--border-1)',
            background: 'var(--bg-surface-2)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ flex: 1, fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
            Recorded as a new version and an undoable change-set.
          </div>
          <button
            onClick={() => setShowChanges((v) => !v)}
            disabled={!data}
            style={{ ...btnGhost, padding: '7px 13px', fontSize: 'var(--text-sm)' }}
          >
            {showChanges ? 'Hide changes' : 'View changes'}
          </button>
          <button
            onClick={onClose}
            style={{ ...btnGhost, padding: '7px 13px', fontSize: 'var(--text-sm)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            // Never offer a blind restore: without the impact preview the user
            // cannot see what they are authorising, which is the P0-1 defect.
            disabled={restoring || !data}
            style={{
              ...btnPrimary,
              padding: '7px 14px',
              fontSize: 'var(--text-sm)',
              opacity: restoring || !data ? 0.55 : 1,
            }}
          >
            <Icon name="refresh" size={13} color="#fff" />{' '}
            {restoring ? 'Restoring…' : 'Restore as new version'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: 'info' | 'notable' | 'critical';
  children: React.ReactNode;
}) {
  const map: Record<string, [string, string]> = {
    info: ['var(--info-soft)', 'var(--info)'],
    notable: ['var(--notable-soft)', 'var(--notable)'],
    critical: ['var(--critical-soft)', 'var(--critical)'],
  };
  const [bg, fg] = map[tone] ?? map.info!;
  return (
    <div
      style={{
        background: bg,
        color: fg,
        borderRadius: 8,
        padding: '9px 12px',
        fontSize: 'var(--text-xs)',
        lineHeight: 1.5,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function SummaryGrid({ data }: { data: RestoreImpact }) {
  const cells: Array<{
    label: string;
    value: number;
    tone: 'critical' | 'success' | 'info' | 'ink';
  }> = [
    { label: 'Steps archived', value: data.nodes.removed.length, tone: 'critical' },
    { label: 'Steps restored', value: data.nodes.added.length, tone: 'success' },
    { label: 'Steps revived', value: data.nodes.revived.length, tone: 'success' },
    { label: 'Steps changed', value: data.nodes.changed.length, tone: 'info' },
    { label: 'Steps unchanged', value: data.nodes.unchangedCount, tone: 'ink' },
    { label: 'Artifacts deleted', value: data.artifacts.deleted, tone: 'success' },
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 8,
        marginBottom: 12,
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            border: '1px solid var(--border-1)',
            borderRadius: 8,
            padding: '9px 11px',
            background: 'var(--bg-surface-2)',
          }}
        >
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--ink-1)' }}>
            {c.value}
          </div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 1 }}>
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChangeDetail({ data }: { data: RestoreImpact }) {
  return (
    <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12 }}>
      <NodeList
        title="Archived (kept in history)"
        tone="critical"
        nodes={data.nodes.removed}
        empty="No steps leave the plan."
      />
      <NodeList
        title="Re-created from this version"
        tone="success"
        nodes={data.nodes.added}
        empty="No steps are re-created."
      />
      <NodeList
        title="Revived from history"
        tone="success"
        nodes={data.nodes.revived}
        empty="No archived steps come back."
      />
      <ChangedList nodes={data.nodes.changed} />
    </div>
  );
}

function NodeList({
  title,
  tone,
  nodes,
  empty,
}: {
  title: string;
  tone: 'critical' | 'success';
  nodes: RestoreImpactNodeRef[];
  empty: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <Chip tone={tone}>{title}</Chip>
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>{nodes.length}</span>
      </div>
      {nodes.length === 0 ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)' }}>{empty}</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {nodes.map((n) => (
            <li
              key={n.id}
              style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.7 }}
            >
              {n.title}{' '}
              <span style={{ color: 'var(--ink-4)' }}>
                ({n.kind} · {n.subject})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangedList({ nodes }: { nodes: RestoreImpactChangedNode[] }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <Chip tone="info">Changed in place</Chip>
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>{nodes.length}</span>
      </div>
      {nodes.length === 0 ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)' }}>
          No surviving step changes.
        </div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {nodes.map((n) => (
            <li
              key={n.id}
              style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.7 }}
            >
              {n.title}{' '}
              <span style={{ color: 'var(--ink-4)' }}>
                — reverts {n.changedFields.map(fieldLabel).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
