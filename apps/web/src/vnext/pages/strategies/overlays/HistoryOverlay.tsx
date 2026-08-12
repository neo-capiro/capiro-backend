/*
 * §7.10c — History overlay. Route: /strategies/:strategyId/history (over the editor).
 *
 * Newest-first revision list (useVersionsInfinite, cursor-paginated with
 * "Load older versions"), a detail pane per selected version, and the P0-1
 * restore path: the restore-impact preview (useRestoreImpact) renders BEFORE
 * restore is offered, restore itself (useRestoreVersion) sits behind an
 * explicit two-click confirm, and a blind restore is NEVER offered — when the
 * preview fails to load, the restore control stays disabled. Restore records
 * a NEW version; nothing is deleted and no step is rewound.
 *
 * Rendered like the canonical RestoreImpactModal (same disclosure copy —
 * banner text is product policy). Focus trap / Escape / dirty guard / route
 * sync live in StrategiesModalShell.
 */
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { relativeTime } from '../../../../pages/strategy/constants.js';
import type {
  RestoreImpact,
  RestoreImpactChangedNode,
  RestoreImpactNodeRef,
  StrategyVersion,
} from '../../../../pages/strategy/types.js';
import {
  memberName,
  useRestoreImpact,
  useRestoreVersion,
  useTenantMembers,
  useVersionsInfinite,
} from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

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

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function HistoryOverlay() {
  const { strategyId } = useParams<{ strategyId: string }>();
  const versions = useVersionsInfinite(strategyId ?? null);
  const members = useTenantMembers();
  const restore = useRestoreVersion(strategyId ?? '');

  const items = useMemo(() => (versions.data ?? []).flatMap((page) => page.items), [versions.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((v) => v.id === selectedId) ?? items[0] ?? null;
  const selectedIndex = selected ? items.findIndex((v) => v.id === selected.id) : -1;
  const isCurrent = selectedIndex === 0;

  const impact = useRestoreImpact(strategyId ?? null, selected?.id ?? null);
  const [confirming, setConfirming] = useState(false);
  const [restoredNote, setRestoredNote] = useState<string | null>(null);

  const authorOf = (version: StrategyVersion) =>
    version.authorKind === 'meri'
      ? 'Meri'
      : memberName(members.data, version.authorUserId, 'A teammate');

  const doRestore = () => {
    if (!selected || isCurrent || restore.isPending) return;
    restore.mutate(selected.id, {
      onSuccess: () => {
        setConfirming(false);
        setSelectedId(null);
        setRestoredNote('Restored as a new version. Nothing was deleted.');
      },
    });
  };

  /* Never offer a blind restore: without the impact preview the user cannot
   * see what they are authorising (P0-1). */
  const restoreOffered = Boolean(
    selected && !isCurrent && impact.data && !impact.isError && !restore.isPending,
  );

  return (
    <StrategiesModalShell
      eyebrow="History"
      title="Version history"
      subtitle="Every edit is snapshotted. Restoring creates a new version and never deletes steps or staged work."
      closeTo={`/strategies/${strategyId ?? ''}`}
      size="lg"
      headerMeta={
        items[0] ? (
          <span className="st-pill st-pill--info">Current · {relativeTime(items[0].createdAt)}</span>
        ) : null
      }
      primaryLabel="Close"
      onPrimary={undefined}
      footerNote="Meri's edits are logged for AI-use disclosure."
    >
      {restoredNote ? (
        <p className="st-rule" role="status" style={{ color: 'var(--st-success-fg)', marginBottom: 12 }}>
          · {restoredNote}
        </p>
      ) : null}

      {versions.isLoading ? (
        <div className="st-skel-stack">
          <CapiroSkeleton height={44} />
          <CapiroSkeleton height={44} />
          <CapiroSkeleton height={44} />
        </div>
      ) : versions.isError ? (
        <CapiroErrorState
          title="History could not be loaded"
          description="The version list is unavailable. Nothing here was changed."
          onRetry={() => void versions.refetch()}
        />
      ) : items.length === 0 ? (
        <CapiroEmptyState
          title="No versions yet"
          description="Versions appear here the first time this plan changes."
        />
      ) : (
        <div className="st-history">
          <div className="st-history__list" role="listbox" aria-label="Versions, newest first">
            {items.map((version, index) => {
              const isSelected = selected?.id === version.id;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  key={version.id}
                  className={`st-rev-item${isSelected ? ' is-selected' : ''}`}
                  onClick={() => {
                    setSelectedId(version.id);
                    setConfirming(false);
                    setRestoredNote(null);
                  }}
                >
                  <span className="st-rev-item__num">{index + 1}</span>
                  <span style={{ minWidth: 0 }}>
                    <span className="st-rev-item__title">{version.note || 'Plan revision'}</span>
                    <span className="st-rev-item__meta" style={{ display: 'block' }}>
                      {authorOf(version)} · {relativeTime(version.createdAt)}
                    </span>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {index === 0 ? <span className="st-pill st-pill--success">Current</span> : null}
                      {version.authorKind === 'meri' ? (
                        <span className="st-pill st-pill--info">Meri</span>
                      ) : null}
                      {version.restoredFromVersionId ? (
                        <span className="st-pill">Restore</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
            {versions.hasNextPage ? (
              <CapiroButton
                variant="quiet"
                size="compact"
                onClick={() => void versions.fetchNextPage()}
                disabled={versions.isFetchingNextPage}
              >
                {versions.isFetchingNextPage ? 'Loading…' : 'Load older versions'}
              </CapiroButton>
            ) : null}
          </div>

          <div className="st-history__detail">
            {selected ? (
              <>
                <div className="st-history__detail-head">
                  <div>
                    <strong>{selected.note || 'Plan revision'}</strong>
                    <p className="st-history__meta">
                      {authorOf(selected)} · {relativeTime(selected.createdAt)}
                      {isCurrent ? ' · This is the current plan.' : ''}
                    </p>
                  </div>
                  {!isCurrent ? (
                    <CapiroButton
                      variant="secondary"
                      size="compact"
                      disabled={!restoreOffered && !confirming}
                      onClick={() => setConfirming(true)}
                    >
                      Restore as new version
                    </CapiroButton>
                  ) : null}
                </div>

                {impact.isLoading ? (
                  <div className="st-skel-stack" style={{ marginTop: 12 }}>
                    <CapiroSkeleton height={14} width="60%" />
                    <CapiroSkeleton height={64} />
                    <CapiroSkeleton height={14} width="80%" />
                  </div>
                ) : impact.isError || !impact.data ? (
                  <CapiroErrorState
                    title="The restore preview could not be loaded"
                    description="Restoring without it is not offered — try again."
                    onRetry={() => void impact.refetch()}
                  />
                ) : (
                  <RestoreImpactPreview data={impact.data} />
                )}

                {confirming && !isCurrent ? (
                  <div className="st-modal__guard" role="alertdialog" aria-label="Confirm restore">
                    <span>
                      <strong>Restore this version?</strong> Nothing is deleted — steps this version
                      doesn't contain are archived and stay in history.
                    </span>
                    <span className="st-modal__guard-actions">
                      <CapiroButton size="compact" variant="secondary" onClick={() => setConfirming(false)}>
                        Cancel
                      </CapiroButton>
                      <CapiroButton
                        size="compact"
                        variant="primary"
                        disabled={!restoreOffered}
                        loading={restore.isPending}
                        onClick={doRestore}
                      >
                        Restore as new version
                      </CapiroButton>
                    </span>
                  </div>
                ) : null}
                {restore.isError ? (
                  <p className="st-modal__alert" role="alert" style={{ marginTop: 12 }}>
                    Could not restore that version. {(restore.error as Error)?.message || 'Please try again.'}
                  </p>
                ) : null}
                <p className="st-history__meta" style={{ marginTop: 14 }}>
                  Recorded as a new version and an undoable change-set.
                </p>
              </>
            ) : null}
          </div>
        </div>
      )}
    </StrategiesModalShell>
  );
}

/* ------------------------------------------------------- impact preview */
/* The disclosure half of P0-1, rendered like the canonical RestoreImpactModal:
 * the same summary, the same banner copy (product policy), the same change
 * lists — with vNext classes. */

function RestoreImpactPreview({ data }: { data: RestoreImpact }) {
  const cells: Array<{ label: string; value: number }> = [
    { label: 'Steps archived', value: data.nodes.removed.length },
    { label: 'Steps restored', value: data.nodes.added.length },
    { label: 'Steps revived', value: data.nodes.revived.length },
    { label: 'Steps changed', value: data.nodes.changed.length },
    { label: 'Steps unchanged', value: data.nodes.unchangedCount },
    { label: 'Artifacts deleted', value: data.artifacts.deleted },
  ];
  return (
    <div>
      {data.noOp ? (
        <p style={{ marginBottom: 12 }}>
          <span className="st-pill st-pill--info">No changes</span>{' '}
          <span style={{ fontSize: 13, color: 'var(--st-gray-500)' }}>
            This version matches the current plan. Restoring it would change nothing.
          </span>
        </p>
      ) : null}

      <div className="st-meta-grid" style={{ marginBottom: 12 }}>
        {cells.map((cell) => (
          <div className="st-meta-grid__item" key={cell.label}>
            <span className="st-meta-grid__key">{cell.label}</span>
            <span className="st-meta-grid__val">{cell.value}</span>
          </div>
        ))}
      </div>

      {data.runs.activeCount > 0 ? (
        <p className="st-modal__alert" role="alert">
          {data.runs.activeCount} in-flight execution{' '}
          {data.runs.activeCount === 1 ? 'run references' : 'runs reference'} a step this restore
          archives. {data.runs.activeCount === 1 ? 'It' : 'They'} stay readable, but will no longer
          point at a live step — cancel or finish {data.runs.activeCount === 1 ? 'it' : 'them'}{' '}
          first if that matters.
        </p>
      ) : null}

      {data.artifacts.workspaceDraftsAffected > 0 || data.artifacts.outreachRecordsAffected > 0 ? (
        <div className="st-gap" role="note" style={{ marginBottom: 12 }}>
          {data.artifacts.workspaceDraftsAffected} Workspace draft
          {data.artifacts.workspaceDraftsAffected === 1 ? '' : 's'} and{' '}
          {data.artifacts.outreachRecordsAffected} Outreach record
          {data.artifacts.outreachRecordsAffected === 1 ? '' : 's'} become historical. The documents
          themselves are not deleted and stay listed under detached steps.
        </div>
      ) : null}

      {data.provenance.nodesReCreatedWithoutProvenance > 0 &&
      !data.provenance.snapshotCarriesProvenance ? (
        <div className="st-gap" role="note" style={{ marginBottom: 12 }}>
          This snapshot predates grounding capture, so {data.provenance.nodesReCreatedWithoutProvenance}{' '}
          re-created step{data.provenance.nodesReCreatedWithoutProvenance === 1 ? '' : 's'} will come
          back without source citations.
        </div>
      ) : null}

      <ImpactNodeList
        title="Archived (kept in history)"
        tone="danger"
        nodes={data.nodes.removed}
        empty="No steps leave the plan."
      />
      <ImpactNodeList
        title="Re-created from this version"
        tone="success"
        nodes={data.nodes.added}
        empty="No steps are re-created."
      />
      <ImpactNodeList
        title="Revived from history"
        tone="success"
        nodes={data.nodes.revived}
        empty="No archived steps come back."
      />
      <ImpactChangedList nodes={data.nodes.changed} />
    </div>
  );
}

function ImpactNodeList({
  title,
  tone,
  nodes,
  empty,
}: {
  title: string;
  tone: 'danger' | 'success';
  nodes: RestoreImpactNodeRef[];
  empty: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 5px' }}>
        <span className={`st-pill st-pill--${tone}`}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--st-gray-400)' }}>{nodes.length}</span>
      </p>
      {nodes.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--st-gray-400)', margin: 0 }}>{empty}</p>
      ) : (
        <div>
          {nodes.map((node) => (
            <div className="st-change-row" key={node.id}>
              <span className="st-change-row__field">{node.kind}</span>
              <span className="st-change-chip st-change-chip--after">{node.title}</span>
              <span style={{ fontSize: 12, color: 'var(--st-gray-500)' }}>{node.subject}</span>
              <span />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImpactChangedList({ nodes }: { nodes: RestoreImpactChangedNode[] }) {
  return (
    <div>
      <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 5px' }}>
        <span className="st-pill st-pill--info">Changed in place</span>
        <span style={{ fontSize: 12, color: 'var(--st-gray-400)' }}>{nodes.length}</span>
      </p>
      {nodes.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--st-gray-400)', margin: 0 }}>No surviving step changes.</p>
      ) : (
        <div>
          {nodes.map((node) => (
            <div className="st-change-row" key={node.id}>
              <span className="st-change-row__field">{node.title}</span>
              <span className="st-change-chip st-change-chip--before">
                {node.changedFields.map(fieldLabel).join(', ')}
              </span>
              <span style={{ fontSize: 12, color: 'var(--st-gray-500)' }}>reverts to this version</span>
              <span />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
