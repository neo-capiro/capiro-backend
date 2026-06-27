/**
 * Version-history popover (Phase 6b) — ported from the prototype `VersionPopover`
 * (asset_10), wired to the engine (useVersions / useRestoreVersion) and the
 * identity resolver (useTenantMembers → author name/initials by Clerk user id).
 *
 * The newest version is rendered as "current" (accent-soft row, no Restore).
 * Meri-authored versions show the Meri sparkle avatar; person versions show the
 * tenant-member avatar. Footer carries the AI-use disclosure note.
 */
import { Spin, App as AntApp } from 'antd';
import { Ava, Icon } from '../kit.js';
import {
  initials as initialsOf,
  useRestoreVersion,
  useTenantMembers,
  useVersions,
} from '../api.js';
import type { WsDocVersion } from '../types.js';

function whenLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function VersionPopover({
  draftId,
  selfClerkId,
  selfName,
  onClose,
  onRestored,
}: {
  draftId: string;
  selfClerkId: string | null;
  selfName: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { message } = AntApp.useApp();
  const { data: versions, isLoading } = useVersions(draftId);
  const { data: members } = useTenantMembers();
  const restore = useRestoreVersion(draftId);

  const nameFor = (v: WsDocVersion): { name: string; initials: string } => {
    if (v.authorKind === 'meri') return { name: 'Meri', initials: '' };
    if (selfClerkId && v.authorId === selfClerkId) {
      return { name: selfName || 'You', initials: initialsOf(selfName || 'You') };
    }
    const m = members?.find((x) => x.clerkUserId === v.authorId);
    if (m) return { name: m.name, initials: m.initials };
    return { name: 'Teammate', initials: '··' };
  };

  const onRestore = (v: WsDocVersion) => {
    restore.mutate(v.id, {
      onSuccess: () => {
        message.success('Restored version');
        onRestored();
      },
      onError: () => message.error('Could not restore this version'),
    });
  };

  const list = versions ?? [];

  return (
    <div style={{ position: 'absolute', top: 14, right: 18, width: 300, zIndex: 30 }}>
      <div className="card" style={{ boxShadow: 'var(--shadow-2)', overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '11px 14px',
            borderBottom: '1px solid var(--border-1)',
          }}
        >
          <Icon name="History" size={15} style={{ color: 'var(--ink-2)', marginRight: 8 }} />
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Version history</span>
          <button
            onClick={onClose}
            className="tb-iconbtn"
            style={{ width: 26, height: 26, border: 'none', background: 'transparent' }}
          >
            <Icon name="X" size={15} />
          </button>
        </div>

        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {isLoading && (
            <div style={{ textAlign: 'center', padding: 20 }}>
              <Spin size="small" />
            </div>
          )}
          {!isLoading && list.length === 0 && (
            <div style={{ padding: '16px 14px', fontSize: 12, color: 'var(--ink-3)' }}>
              No saved versions yet. "Save draft" creates one.
            </div>
          )}
          {list.map((v, i) => {
            const who = nameFor(v);
            const now = i === 0; // newest = current
            const meri = v.authorKind === 'meri';
            return (
              <div
                key={v.id}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '11px 14px',
                  borderTop: i ? '1px solid var(--border-1)' : 'none',
                  background: now ? 'var(--accent-soft)' : 'transparent',
                }}
              >
                {meri ? (
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      background: 'var(--accent-soft)',
                      color: 'var(--accent)',
                      display: 'grid',
                      placeItems: 'center',
                      flex: 'none',
                    }}
                  >
                    <Icon name="Sparkles" size={13} />
                  </span>
                ) : (
                  <Ava x={who.initials} size={26} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    {who.name}
                    {now && (
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}> · current</span>
                    )}
                  </div>
                  {v.label && (
                    <div style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{v.label}</div>
                  )}
                  <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }} className="num">
                    {whenLabel(v.createdAt)}
                  </div>
                </div>
                {!now && (
                  <a
                    onClick={() => onRestore(v)}
                    style={{
                      fontSize: 11,
                      color: 'var(--accent)',
                      fontWeight: 600,
                      cursor: restore.isPending ? 'wait' : 'pointer',
                      alignSelf: 'center',
                      opacity: restore.isPending ? 0.6 : 1,
                    }}
                  >
                    Restore
                  </a>
                )}
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: '9px 14px',
            borderTop: '1px solid var(--border-1)',
            fontSize: 11,
            color: 'var(--ink-3)',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <Icon name="ShieldCheck" size={12} />
          Meri's edits are logged for AI-use disclosure.
        </div>
      </div>
    </div>
  );
}
