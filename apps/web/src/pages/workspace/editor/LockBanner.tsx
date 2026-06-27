/**
 * Concurrent-edit lock banner (Phase 6b, Q-ED-2) — ported from the prototype's
 * lock banner (asset_14), extended with the active-editor receive-request UI the
 * prototype omitted.
 *
 * Two sides:
 *  - VIEWER (someone else holds the lock): a notable banner "{name} is currently
 *    editing · view-only" with **Request to edit** → "Request sent". If the
 *    holder has gone inactive (> 10 min, `holderInactive`), a **Take over**
 *    button appears.
 *  - ACTIVE EDITOR (I hold the lock) with an incoming request: a banner
 *    "[name] wants to edit" with **Save & release** (flush + release + transfer)
 *    and **Keep editing** (dismiss the request locally).
 *
 * Commenting stays available in view-only mode (the rail is not disabled).
 */
import { Icon } from '../kit.js';
import type { WsLockStatus } from '../types.js';

const BAR_STYLE: React.CSSProperties = {
  background: 'rgba(212,160,23,.08)',
  borderBottom: '1px solid rgba(212,160,23,.25)',
  padding: '7px 24px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flex: 'none',
  flexWrap: 'wrap',
};

const ACCENT_BAR_STYLE: React.CSSProperties = {
  ...BAR_STYLE,
  background: 'var(--accent-soft)',
  borderBottom: '1px solid var(--accent)',
};

export function LockBanner({
  lock,
  requestPending,
  requestBusy,
  takeOverBusy,
  releasing,
  onRequest,
  onTakeOver,
  onSaveAndRelease,
  onKeepEditing,
}: {
  lock: WsLockStatus;
  /** The current user has sent a request (local optimistic state). */
  requestPending: boolean;
  requestBusy: boolean;
  takeOverBusy: boolean;
  releasing: boolean;
  onRequest: () => void;
  onTakeOver: () => void;
  onSaveAndRelease: () => void;
  onKeepEditing: () => void;
}) {
  // ── Active editor receiving a request ──────────────────────────────────────
  if (lock.heldByMe && lock.hasIncomingRequest) {
    return (
      <div style={ACCENT_BAR_STYLE}>
        <Icon name="Bell" size={14} style={{ color: 'var(--accent)', flex: 'none' }} />
        <span style={{ fontSize: 12.5, color: 'var(--ink-1)' }}>
          <b>{lock.requestedByName ?? 'A teammate'}</b> wants to edit
        </span>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="btn sm btn-accent"
            style={{ flex: 'none' }}
            disabled={releasing}
            onClick={onSaveAndRelease}
          >
            <Icon name="Save" size={12} />
            {releasing ? 'Saving…' : 'Save & release'}
          </button>
          <button
            className="btn sm btn-ghost"
            style={{ color: 'var(--ink-2)', flex: 'none' }}
            onClick={onKeepEditing}
          >
            <Icon name="X" size={12} />
            Keep editing
          </button>
        </div>
      </div>
    );
  }

  // ── I hold the lock, no request — no banner. ───────────────────────────────
  if (lock.heldByMe) return null;

  // ── No one holds it (free) — no banner; the editor auto-acquires. ──────────
  if (!lock.holderId) return null;

  // ── Viewer: someone else holds the lock ────────────────────────────────────
  const holder = lock.holderName ?? 'Someone';
  return (
    <div style={BAR_STYLE}>
      <Icon name="Lock" size={14} style={{ color: 'var(--notable)', flex: 'none' }} />
      <span style={{ fontSize: 12.5, color: 'var(--ink-1)' }}>
        <b>{holder}</b> is currently editing · you&rsquo;re in view-only mode
      </span>
      <span style={{ flex: 1 }} />

      {lock.holderInactive ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            Editor appears inactive
          </span>
          {!requestPending && (
            <button
              className="btn sm btn-ghost"
              style={{ color: 'var(--notable)', borderColor: 'rgba(212,160,23,.35)', flex: 'none' }}
              disabled={requestBusy}
              onClick={onRequest}
            >
              <Icon name="Bell" size={12} />
              Request to edit
            </button>
          )}
          <button
            className="btn sm btn-ghost"
            style={{ color: 'var(--ink-2)', flex: 'none' }}
            disabled={takeOverBusy}
            onClick={onTakeOver}
          >
            <Icon name="Unlock" size={12} />
            {takeOverBusy ? 'Taking over…' : 'Take over (editor inactive)'}
          </button>
        </div>
      ) : requestPending ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            Notifying {holder}…
          </span>
          <button
            className="btn sm btn-ghost"
            disabled
            style={{ color: 'var(--ink-4)', opacity: 0.55, flex: 'none' }}
          >
            <Icon name="Clock" size={12} />
            Request sent
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            This notifies {holder} that you&rsquo;d like to edit.
          </span>
          <button
            className="btn sm btn-ghost"
            style={{ color: 'var(--notable)', borderColor: 'rgba(212,160,23,.35)', flex: 'none' }}
            disabled={requestBusy}
            onClick={onRequest}
          >
            <Icon name="Bell" size={12} />
            Request to edit
          </button>
        </div>
      )}
    </div>
  );
}
