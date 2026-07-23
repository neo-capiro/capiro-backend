/*
 * Version history modal (HIS) — ported from the prototype sp-app HistoryModal.
 * Newest-first version list with author (or Meri spark roundel), change note,
 * relative time, and a "current" highlight on the head version (HIS-1); Restore
 * per non-current version with a confirm (HIS-2); AI-use disclosure footer
 * (HIS-3). Meri versions are visibly flagged.
 */
import { App } from 'antd';
import { Overlay, Icon, Ava, Chip, iconBtn, btnGhost } from './strategy-ui.js';
import { relativeTime } from './constants.js';
import { initialsOf, memberName, type TenantMember } from './members.js';
import { useVersions, useRestoreVersion } from './api.js';

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
  const { message, modal } = App.useApp();
  const versions = useVersions(strategyId, true);
  const restore = useRestoreVersion(strategyId);
  const items = (versions.data ?? []).flatMap((p) => p.items);

  const doRestore = (versionId: string) => {
    modal.confirm({
      title: 'Restore this version?',
      content: 'The current plan will be replaced. This action itself is recorded as a new version.',
      okText: 'Restore',
      onOk: () =>
        new Promise<void>((resolve, reject) => {
          restore.mutate(versionId, {
            onSuccess: () => {
              onRestored('Version restored.');
              onClose();
              resolve();
            },
            onError: () => {
              message.error('Could not restore that version.');
              reject(new Error('restore failed'));
            },
          });
        }),
    });
  };

  return (
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
              Every edit is snapshotted. Restore rolls back the plan and logs a new version.
            </div>
          </div>
          <button onClick={onClose} style={iconBtn}>
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
                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 2 }}>
                      {relativeTime(v.createdAt)}
                    </div>
                  </div>
                  {!isCurrent && (
                    <button
                      onClick={() => doRestore(v.id)}
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
  );
}
