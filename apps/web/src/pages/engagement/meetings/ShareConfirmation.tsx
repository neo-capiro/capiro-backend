import { useMemo, useState } from 'react';
import { App } from 'antd';
import { createPortal } from 'react-dom';
import { CheckCircle2, FolderOpen, Info, Lock, Users } from 'lucide-react';
import { useMe } from '../../../lib/me.js';
import { useShareArtifacts, type ShareArtifactRef } from './meetings-api.js';
import type { Meeting } from './meetings-types.js';

type ArtifactType = ShareArtifactRef['type'];

export interface ShareableItem {
  type: ArtifactType;
  id: string;
  label: string;
  sub?: string;
  approved: boolean;
  alreadyShared: boolean;
}

function authorName(author?: { firstName: string | null; lastName: string | null; email: string | null } | null): string | undefined {
  if (!author) return undefined;
  const name = [author.firstName, author.lastName].filter(Boolean).join(' ').trim();
  return name || author.email || undefined;
}

/**
 * Default selection: approved AND not-yet-shared. Unapproved items are never
 * selectable at all (never mind default-selected) — approval is required
 * before an artifact can be shared, full stop.
 */
export function defaultSelectedKeys(items: ShareableItem[]): Set<string> {
  return new Set(items.filter((i) => i.approved && !i.alreadyShared).map((i) => `${i.type}:${i.id}`));
}

/** Every artifact on the meeting that COULD be shared, approved or not — the
 *  panel shows all of them so the user can see what's blocked on approval. */
export function buildShareableItems(meeting: Meeting): ShareableItem[] {
  const items: ShareableItem[] = [];
  for (const p of meeting.preps) {
    items.push({
      type: 'prep',
      id: p.id,
      label: 'Meeting prep',
      approved: p.status === 'approved',
      alreadyShared: p.sharedAt != null,
    });
  }
  for (const n of meeting.notes) {
    items.push({
      type: 'note',
      id: n.id,
      label: 'Meeting note',
      sub: authorName(n.author) ? `by ${authorName(n.author)}` : undefined,
      approved: n.status === 'approved',
      alreadyShared: n.sharedAt != null,
    });
  }
  for (const d of meeting.debriefs) {
    items.push({
      type: 'debrief',
      id: d.id,
      label: 'Debrief',
      sub: authorName(d.author) ? `by ${authorName(d.author)}` : undefined,
      approved: d.status === 'approved',
      alreadyShared: d.sharedAt != null,
    });
  }
  for (const a of meeting.attachments) {
    items.push({
      type: 'attachment',
      id: a.id,
      label: a.fileName,
      approved: a.approvedAt != null,
      alreadyShared: a.sharedAt != null,
    });
  }
  return items;
}

/**
 * Share confirmation (Phase 2 §3.e rewrite) — lists every artifact on the
 * meeting individually with its approval/shared state. Only APPROVED
 * artifacts are selectable; sharing is explicit and per-artifact, never
 * inferred from "the meeting is shared." Default-selects approved,
 * not-yet-shared artifacts so a first share still feels like one click, but
 * the user sees and can deselect exactly what goes out.
 */
export function ShareConfirmation({
  meeting,
  open,
  onClose,
}: {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
}) {
  const me = useMe();
  const { message } = App.useApp();
  const share = useShareArtifacts();

  const items = useMemo(() => (meeting ? buildShareableItems(meeting) : []), [meeting]);
  const defaultSelected = useMemo(() => defaultSelectedKeys(items), [items]);
  const [selected, setSelected] = useState<Set<string>>(defaultSelected);
  // Re-derive the default selection whenever the meeting identity changes
  // (opening the modal for a different meeting, or a fresh approval landed).
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (meeting && seededFor !== meeting.id) {
    setSeededFor(meeting.id);
    setSelected(defaultSelected);
  }

  if (!open || !meeting) return null;
  const clientName = meeting.client?.name ?? null;
  const coShared = Boolean(meeting.sharedBy) && meeting.sharedBy?.userId !== me.data?.user.id;

  const toggle = (key: string, approved: boolean) => {
    if (!approved) return; // "Approve first" — never selectable.
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const confirm = async () => {
    const artifacts: ShareArtifactRef[] = items
      .filter((i) => selected.has(`${i.type}:${i.id}`))
      .map((i) => ({ type: i.type, id: i.id }));
    if (!artifacts.length) return;
    try {
      await share.mutateAsync({ meetingId: meeting.id, artifacts });
      message.success(`Saved to ${clientName ?? 'the client'} · Documents.`);
      onClose();
    } catch {
      message.error('Could not share the selected artifacts.');
    }
  };

  return createPortal(
    // className="redesign" is required here: this is a raw createPortal to
    // document.body, so it sits OUTSIDE the page's <section className="...
    // redesign"> DOM subtree and doesn't inherit that scope's font/antd
    // overrides (same fix as SendMeriModal).
    <div
      onClick={onClose}
      className="redesign"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,26,56,0.34)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(1.5px)',
        // var(--font-sans) is not a global token (it's only defined inside a
        // handful of OTHER unrelated component scopes) — use the real one.
        fontFamily: 'var(--font-sans-rd)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: 460,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 12,
          padding: 0,
          boxShadow: '0 20px 60px rgba(12,26,56,0.28)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-1)',
          }}
        >
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'var(--success-soft)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--success)',
            }}
          >
            <Users size={16} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-1)' }}>
              Share artifacts with your organization?
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{meeting.subject}</div>
          </div>
        </div>

        <div style={{ padding: '10px 20px 4px', overflowY: 'auto', flex: 1 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              fontSize: 11.5,
              color: 'var(--ink-3)',
              marginBottom: 8,
            }}
          >
            <FolderOpen size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Selected artifacts appear in {clientName ?? 'the client'} → Documents, and your
              firm's Meeting Library. Everyone in your organization can see them.
            </span>
          </div>

          {items.length === 0 && (
            <div style={{ padding: '18px 4px', fontSize: 12.5, color: 'var(--ink-3)' }}>
              Nothing on this meeting can be shared yet.
            </div>
          )}

          {items.map((i) => {
            const key = `${i.type}:${i.id}`;
            const checked = selected.has(key);
            return (
              <div
                key={key}
                onClick={() => toggle(key, i.approved)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 6px',
                  borderRadius: 6,
                  cursor: i.approved ? 'pointer' : 'default',
                  opacity: i.approved ? 1 : 0.6,
                }}
              >
                <span style={{ marginTop: 2, flexShrink: 0, color: 'var(--ink-3)' }}>
                  {i.approved ? (
                    <CheckCircle2
                      size={16}
                      style={{ color: checked ? 'var(--success)' : 'var(--ink-4)' }}
                      fill={checked ? 'var(--success)' : 'none'}
                    />
                  ) : (
                    <Lock size={14} />
                  )}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-1)' }}>
                      {i.label}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: 'var(--ink-3)',
                      }}
                    >
                      {i.type}
                    </span>
                    {i.alreadyShared && (
                      <span className="pill success" style={{ fontSize: 9 }}>
                        Already shared
                      </span>
                    )}
                  </div>
                  {i.sub && (
                    <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 1 }}>{i.sub}</div>
                  )}
                  {!i.approved && (
                    <div style={{ fontSize: 11, color: 'var(--notable)', marginTop: 1 }}>
                      Approve first — go to its tab to approve.
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {coShared && (
          <div
            style={{
              margin: '4px 20px 0',
              display: 'flex',
              gap: 9,
              padding: '10px 12px',
              background: 'var(--notable-soft)',
              border: '1px solid var(--notable)',
              borderRadius: 8,
              flexShrink: 0,
            }}
          >
            <Info size={15} style={{ color: 'var(--notable)', marginTop: 1, flexShrink: 0 }} />
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-1)' }}>
              <strong>{meeting.sharedBy?.name ?? 'A colleague'}</strong> already shared material on
              this meeting to {clientName ?? 'this client'}. Your selection is added{' '}
              <strong>alongside</strong> theirs — nothing already shared is affected.
            </div>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '13px 20px',
            borderTop: '1px solid var(--border-1)',
            background: 'var(--bg-surface-2)',
            flexShrink: 0,
          }}
        >
          <button type="button" onClick={onClose} className="btn sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!clientName || share.isPending || selected.size === 0}
            className="btn sm"
            style={{ gap: 6, background: 'var(--success)', color: '#fff', border: 'none' }}
          >
            <Users size={13} />
            {share.isPending
              ? 'Sharing…'
              : `Share${selected.size ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
