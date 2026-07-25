/*
 * Version history modal (HIS) — ported from the prototype sp-app HistoryModal.
 * Newest-first version list with author (or Meri spark roundel), change note,
 * relative time, and a "current" highlight on the head version (HIS-1); Restore
 * per non-current version (HIS-2); AI-use disclosure footer (HIS-3). Meri
 * versions are visibly flagged.
 *
 * P0-1: Restore no longer goes through a one-line "the current plan will be
 * replaced" confirm. It opens RestoreImpactModal, which shows what the restore
 * would actually move (steps archived / re-created / revived / changed, the
 * Workspace + Outreach links that go historical, and any in-flight run that
 * references an affected step) and offers the audit's three controls. This modal
 * also surfaces DETACHED steps — the ones a past restore archived — so a staged
 * artifact whose step left the live plan stays discoverable.
 */
import { useState } from 'react';
import { App } from 'antd';
import { Overlay, Icon, Ava, Chip, iconBtn, btnGhost } from './strategy-ui.js';
import { relativeTime } from './constants.js';
import { initialsOf, memberName, type TenantMember } from './members.js';
import { useVersions, useRestoreVersion, useDetachedSurface } from './api.js';
import { RestoreImpactModal } from './RestoreImpactModal.js';
import type { DetachedSurface } from './types.js';

export function HistoryModal({
  strategyId,
  members,
  onClose,
  onRestored,
}: {
  strategyId: string;
  members: TenantMember[];
  onClose: () => void;
  onRestored: (msg: string) => void;
}) {
  const { message } = App.useApp();
  const versions = useVersions(strategyId, true);
  const restore = useRestoreVersion(strategyId);
  const detached = useDetachedSurface(strategyId, true);
  /** The version whose impact preview is open, if any. */
  const [pending, setPending] = useState<{ id: string; label: string } | null>(null);
  const [showDetached, setShowDetached] = useState(false);
  const items = (versions.data ?? []).flatMap((p) => p.items);
  const detachedNodes = detached.data?.nodes ?? [];

  const doRestore = (versionId: string) => {
    restore.mutate(versionId, {
      onSuccess: () => {
        setPending(null);
        onRestored('Restored as a new version. Nothing was deleted.');
        onClose();
      },
      onError: () => message.error('Could not restore that version.'),
    });
  };

  return (
    <>
      <Overlay onClose={onClose}>
        <div
          style={{
            width: 560,
            maxHeight: '80vh',
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
                Version history
              </div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 2 }}>
                Every edit is snapshotted. Restoring creates a new version and never deletes steps
                or staged work.
              </div>
            </div>
            <button onClick={onClose} style={iconBtn} aria-label="Close">
              <Icon name="x" size={16} color="var(--ink-3)" />
            </button>
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
            {versions.isLoading ? (
              <div style={{ padding: 24, color: 'var(--ink-3)', fontSize: 'var(--text-sm)' }}>
                Loading history…
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: 24, color: 'var(--ink-3)', fontSize: 'var(--text-sm)' }}>
                No versions yet.
              </div>
            ) : (
              items.map((v, i) => {
                const isCurrent = i === 0;
                const isMeri = v.authorKind === 'meri';
                const author = isMeri ? 'Meri' : memberName(members, v.authorUserId, 'A teammate');
                return (
                  <div
                    key={v.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 22px',
                      borderBottom: '1px solid var(--border-1)',
                      background: isCurrent ? 'var(--accent-soft)' : 'transparent',
                    }}
                  >
                    <Ava id={isMeri ? 'meri' : initialsOf(author)} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 'var(--text-sm)',
                          fontWeight: 700,
                          color: 'var(--ink-1)',
                        }}
                      >
                        {author}
                        {isMeri && <Chip tone="accent">Meri</Chip>}
                        {isCurrent && <Chip tone="success">Current</Chip>}
                        {v.restoredFromVersionId && <Chip tone="info">Restore</Chip>}
                      </div>
                      <div
                        style={{
                          fontSize: 'var(--text-xs)',
                          color: 'var(--ink-2)',
                          marginTop: 2,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {v.note}
                      </div>
                      <div
                        style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 2 }}
                      >
                        {relativeTime(v.createdAt)}
                      </div>
                    </div>
                    {!isCurrent && (
                      <button
                        onClick={() => setPending({ id: v.id, label: relativeTime(v.createdAt) })}
                        disabled={restore.isPending}
                        style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--text-sm)' }}
                      >
                        <Icon name="refresh" size={13} color="var(--ink-2)" /> Restore
                      </button>
                    )}
                  </div>
                );
              })
            )}
            {versions.hasNextPage && (
              <div style={{ padding: '10px 22px', textAlign: 'center' }}>
                <button
                  onClick={() => versions.fetchNextPage()}
                  disabled={versions.isFetchingNextPage}
                  style={{ ...btnGhost, padding: '6px 14px', fontSize: 'var(--text-sm)' }}
                >
                  {versions.isFetchingNextPage ? 'Loading…' : 'Load older versions'}
                </button>
              </div>
            )}

            {detachedNodes.length > 0 && (
              <DetachedSection
                data={detached.data!}
                members={members}
                open={showDetached}
                onToggle={() => setShowDetached((v) => !v)}
              />
            )}
          </div>

          <div
            style={{
              padding: '10px 22px',
              borderTop: '1px solid var(--border-1)',
              background: 'var(--bg-surface-2)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--ink-3)',
            }}
          >
            Meri's edits are logged for AI-use disclosure.
          </div>
        </div>
      </Overlay>

      {pending && (
        <RestoreImpactModal
          strategyId={strategyId}
          versionId={pending.id}
          versionLabel={pending.label}
          restoring={restore.isPending}
          onConfirm={() => doRestore(pending.id)}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}

/**
 * P0-1 "detached artifacts remain discoverable": the steps a past restore archived,
 * with the Workspace drafts / Outreach records still attached to them. Collapsed by
 * default — this is history, not the working plan.
 */
function DetachedSection({
  data,
  members,
  open,
  onToggle,
}: {
  data: DetachedSurface;
  members: TenantMember[];
  open: boolean;
  onToggle: () => void;
}) {
  const artifactsByNode = new Map<string, DetachedSurface['artifacts']>();
  for (const a of data.artifacts) {
    const list = artifactsByNode.get(a.nodeId) ?? [];
    list.push(a);
    artifactsByNode.set(a.nodeId, list);
  }
  return (
    <div style={{ borderTop: '1px solid var(--border-1)', marginTop: 4 }}>
      <button
        onClick={onToggle}
        style={{
          ...btnGhost,
          width: '100%',
          border: 'none',
          borderRadius: 0,
          justifyContent: 'flex-start',
          padding: '11px 22px',
          fontSize: 'var(--text-sm)',
        }}
      >
        <Icon name={open ? 'chevdown' : 'chevron'} size={13} color="var(--ink-3)" />
        <span style={{ fontWeight: 700, color: 'var(--ink-2)' }}>
          Detached steps ({data.nodes.length})
        </span>
        <span style={{ color: 'var(--ink-4)', fontSize: 'var(--text-2xs)' }}>
          archived by a restore · {data.artifacts.length} linked item
          {data.artifacts.length === 1 ? '' : 's'} kept
        </span>
      </button>
      {open &&
        data.nodes.map((n) => {
          const arts = artifactsByNode.get(n.id) ?? [];
          const who = memberName(members, n.archivedByUserId, 'A teammate');
          return (
            <div
              key={n.id}
              style={{
                padding: '10px 22px 10px 40px',
                borderTop: '1px solid var(--border-1)',
                background: 'var(--bg-surface-2)',
              }}
            >
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-2)' }}>
                {n.title}
              </div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 2 }}>
                {n.kind} · {n.subject} · archived by {who}
                {n.archivedAt ? ` ${relativeTime(n.archivedAt)}` : ''}
              </div>
              {arts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {arts.map((a) => (
                    <Chip key={a.id} tone="ink">
                      {a.artifactType === 'workspace_draft' ? 'Workspace draft' : 'Outreach record'}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
