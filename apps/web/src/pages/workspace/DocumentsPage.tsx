/**
 * Workspace › Documents — the management list, ported to full fidelity from the
 * locked prototype (WsDocuments, asset_08) with the Phase-final LOCKED decisions:
 *
 *  - Header (Kicker + serif H1 + "New document" → useCreateDraft → Setup) + WsTabs.
 *  - Scope filter (All / Created by me / Shared with me) → useDrafts({scope}).
 *  - Sector select (All sectors + industries) → useDrafts({sector}). Live count
 *    (NO "due this week" string).
 *  - Columns: Document · Client · Type · Ask · Status · Last edited · (actions).
 *    Deadline + Team columns are REMOVED. No pagination (show all).
 *  - Document cell: Files/FileText icon, name, "Packet · N" badge when isPacket.
 *    A "Shared" pill shows when the row isn't owned by the current user (clerk id
 *    vs draft.ownerId; if self isn't known, Shared only shows in the 'shared' scope).
 *  - Status: a Draft (left) | Complete (right) segmented toggle that PERSISTS via
 *    useUpdateDraft.
 *  - Last edited: the avatar + name of whoever last edited (draft.lastEditedById,
 *    a Clerk id resolved via useTenantMembers; falls back to the owner) + relative
 *    time from updatedAt.
 *  - Actions: a Delete control on documents the signed-in user OWNS (useDeleteDraft).
 *  - Row click opens THAT document by id: /workspace/draft/:id.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { Icon, Ava, Kicker } from './kit.js';
import { WsTabs } from './WsTabs.js';
import {
  useCreateDraft,
  useDeleteDraft,
  useDrafts,
  useIndustries,
  useTenantMembers,
  useUpdateDraft,
  type WsTenantMember,
} from './api.js';
import { useMe } from '../../lib/me.js';
import type { WsDraft } from './types.js';

type Scope = 'all' | 'mine' | 'shared';

const SCOPES: Array<[Scope, string]> = [
  ['all', 'All documents'],
  ['mine', 'Created by me'],
  ['shared', 'Shared with me'],
];

/** Format the draft ask into a display amount, or an em-dash. */
function askText(ask: WsDraft['ask']): string {
  if (!ask || ask === 'n/a') return '—';
  if (typeof ask === 'object' && ask.amount) return ask.amount;
  return '—';
}

/** Compact relative time ("2h ago", "Yesterday", "Jan 24"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function DocumentsPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [scope, setScope] = useState<Scope>('all');
  const [sector, setSector] = useState<string>('all');

  const { data: industries } = useIndustries();
  const { data: drafts, isLoading } = useDrafts({
    scope,
    sector: sector === 'all' ? undefined : sector,
  });
  const { data: members } = useTenantMembers();
  const { data: me } = useMe();
  const createDraft = useCreateDraft();

  const selfClerkId = me?.user.clerkUserId ?? null;

  // Drafts carry ownerId AND lastEditedById as CLERK user ids, so resolve member
  // info by clerkUserId (not the Capiro user id).
  const memberByClerk = useMemo(() => {
    const map = new Map<string, WsTenantMember>();
    (members ?? []).forEach((m) => map.set(m.clerkUserId, m));
    return map;
  }, [members]);

  const isMine = (d: WsDraft): boolean => !!selfClerkId && d.ownerId === selfClerkId;

  // Show "Shared" when the row isn't owned by me. If self isn't known yet, only
  // surface Shared in the explicit 'shared' scope.
  const isShared = (d: WsDraft): boolean => {
    if (!selfClerkId) return scope === 'shared';
    return d.ownerId !== selfClerkId;
  };

  // The person who last edited (icon + name) — falls back to the owner for legacy
  // rows with no recorded editor.
  const lastEditor = (d: WsDraft): { name: string; initials: string | null } => {
    const id = d.lastEditedById || d.ownerId;
    const m = memberByClerk.get(id);
    const isMe = !!selfClerkId && id === selfClerkId;
    const name = isMe ? 'You' : (m?.name ?? '—');
    const initials = m?.initials ?? (name && name !== '—' ? name.slice(0, 2).toUpperCase() : null);
    return { name, initials };
  };

  const newDocument = async () => {
    try {
      const d = await createDraft.mutateAsync({});
      navigate(`/workspace/setup/${d.id}`);
    } catch {
      message.error('Could not start a new document. Please try again.');
    }
  };

  const rows = drafts ?? [];

  return (
    <div className="ws-stage">
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div>
            <Kicker style={{ marginBottom: 8 }}>Workspace</Kicker>
            <h1
              style={{
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 32,
                letterSpacing: '-0.01em',
                margin: 0,
                lineHeight: 1.05,
              }}
            >
              Documents
            </h1>
          </div>
          <button
            className="btn btn-primary"
            onClick={newDocument}
            disabled={createDraft.isPending}
          >
            <Icon name="Plus" size={14} />
            New document
          </button>
        </header>

        <WsTabs active="documents" onNav={(k) => navigate(`/workspace/${k}`)} />

        {/* Filters: scope chips + sector select + live count */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 14,
            flexWrap: 'wrap',
          }}
        >
          {SCOPES.map(([k, l]) => (
            <button
              key={k}
              onClick={() => setScope(k)}
              className="btn sm"
              style={{
                borderColor: scope === k ? 'var(--accent)' : 'var(--border-1)',
                color: scope === k ? 'var(--accent)' : 'var(--ink-2)',
                background: scope === k ? 'var(--accent-soft)' : 'var(--bg-surface)',
              }}
            >
              {l}
            </button>
          ))}
          <span style={{ width: 1, height: 22, background: 'var(--border-1)', margin: '0 2px' }} />
          <div
            className="field"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 10px',
              fontSize: 12.5,
              width: 'auto',
              background: 'var(--bg-surface)',
            }}
          >
            <Icon name="Filter" size={13} style={{ color: 'var(--ink-3)' }} />
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              style={{
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 12.5,
                fontFamily: 'var(--font-sans)',
                color: 'var(--ink-1)',
                cursor: 'pointer',
              }}
            >
              <option value="all">All sectors</option>
              {(industries ?? []).map((ind) => (
                <option key={ind} value={ind}>
                  {ind}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }} className="num">
            {rows.length} {rows.length === 1 ? 'document' : 'documents'}
          </span>
        </div>

        {/* Table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)' }}>
                {['Document', 'Client', 'Type', 'Ask', 'Status', 'Last edited', ''].map((h, i) => (
                  <th
                    key={h}
                    style={{
                      textAlign: i === 3 ? 'right' : 'left',
                      fontSize: 10.5,
                      textTransform: 'uppercase',
                      letterSpacing: '0.07em',
                      color: 'var(--ink-3)',
                      fontWeight: 600,
                      padding: '10px 14px',
                      borderBottom: '1px solid var(--border-1)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      padding: '32px 14px',
                      textAlign: 'center',
                      color: 'var(--ink-3)',
                      fontSize: 12.5,
                    }}
                  >
                    Loading documents…
                  </td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      padding: '32px 14px',
                      textAlign: 'center',
                      color: 'var(--ink-3)',
                      fontSize: 12.5,
                    }}
                  >
                    No documents in {sector === 'all' ? 'this view' : sector} yet.
                  </td>
                </tr>
              )}
              {!isLoading &&
                rows.map((d, i) => (
                  <DocRow
                    key={d.id}
                    draft={d}
                    first={i === 0}
                    shared={isShared(d)}
                    lastEditor={lastEditor(d)}
                    canDelete={isMine(d)}
                    onOpen={() => navigate(`/workspace/draft/${d.id}`)}
                  />
                ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            fontSize: 11.5,
            color: 'var(--ink-3)',
            marginTop: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Icon name="Info" size={13} />
          Documents shared with you appear here. Open any row to edit, comment, or manage access.
          The Complete/Draft label is for your own organization only.
        </div>
      </div>
    </div>
  );
}

/** One document row. Status toggle persists; row click opens the draft by id. */
function DocRow({
  draft: d,
  first,
  shared,
  lastEditor,
  canDelete,
  onOpen,
}: {
  draft: WsDraft;
  first: boolean;
  shared: boolean;
  lastEditor: { name: string; initials: string | null };
  canDelete: boolean;
  onOpen: () => void;
}) {
  const { message, modal } = AntApp.useApp();
  const update = useUpdateDraft(d.id);
  const del = useDeleteDraft();
  const isComplete = d.status === 'complete';

  const setStatus = (next: 'draft' | 'complete') => {
    if ((next === 'complete') === isComplete) return; // already there
    update.mutate(
      { status: next },
      {
        onSuccess: () => message.success(next === 'complete' ? 'Marked complete' : 'Marked draft'),
        onError: () => message.error('Could not update'),
      },
    );
  };

  const confirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    modal.confirm({
      title: 'Delete this document?',
      content: `"${d.docTitle}" will be permanently deleted. This cannot be undone.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () =>
        del
          .mutateAsync(d.id)
          .then(() => message.success('Document deleted'))
          .catch(() => message.error('Could not delete the document')),
    });
  };

  const seg = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    fontSize: 11.5,
    fontWeight: 600,
    border: 'none',
    cursor: update.isPending ? 'wait' : 'pointer',
    fontFamily: 'var(--font-sans)',
    background: active ? (isComplete ? 'rgba(46,107,67,.12)' : 'var(--bg-sunken)') : 'transparent',
    color: active ? (isComplete ? 'var(--success)' : 'var(--ink-1)') : 'var(--ink-3)',
  });

  return (
    <tr
      onClick={onOpen}
      style={{ cursor: 'pointer', borderTop: first ? 'none' : '1px solid var(--border-1)' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Document name + packet indicator + Shared pill */}
      <td style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 26,
              height: 30,
              borderRadius: 4,
              background: d.isPacket ? 'var(--accent-soft)' : 'var(--bg-sunken)',
              display: 'grid',
              placeItems: 'center',
              color: d.isPacket ? 'var(--accent)' : 'var(--ink-3)',
              flex: 'none',
            }}
          >
            <Icon name={d.isPacket ? 'Files' : 'FileText'} size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{d.docTitle}</span>
              {d.isPacket && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: 'var(--accent)',
                    background: 'var(--accent-soft)',
                    border: '1px solid #C9D5F2',
                    borderRadius: 5,
                    padding: '1px 7px',
                    whiteSpace: 'nowrap',
                    flex: 'none',
                  }}
                >
                  <Icon name="Files" size={10} />
                  Packet · {d.docCount || 2}
                </span>
              )}
              {shared && (
                <span className="pill muted" style={{ verticalAlign: 'middle' }}>
                  Shared
                </span>
              )}
            </div>
          </div>
        </div>
      </td>

      <td style={{ padding: '12px 14px', color: 'var(--ink-2)' }}>{d.client ?? '—'}</td>
      <td style={{ padding: '12px 14px', color: 'var(--ink-2)' }}>{d.product ?? '—'}</td>
      <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 600 }} className="num">
        {askText(d.ask)}
      </td>

      {/* Status: Draft (left) | Complete (right) segmented toggle — PERSISTS */}
      <td style={{ padding: '12px 14px' }}>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            display: 'inline-flex',
            border: '1px solid var(--border-1)',
            borderRadius: 20,
            overflow: 'hidden',
            opacity: update.isPending ? 0.6 : 1,
          }}
        >
          <button
            onClick={() => setStatus('draft')}
            disabled={update.isPending}
            style={seg(!isComplete)}
          >
            Draft
          </button>
          <button
            onClick={() => setStatus('complete')}
            disabled={update.isPending}
            style={{ ...seg(isComplete), borderLeft: '1px solid var(--border-1)' }}
          >
            Complete
          </button>
        </div>
      </td>

      {/* Last edited: who + when */}
      <td style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastEditor.initials ? (
            <Ava x={lastEditor.initials} size={24} />
          ) : (
            <span style={{ color: 'var(--ink-4)' }}>—</span>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: 'var(--ink-1)' }}>{lastEditor.name}</div>
            <div style={{ fontSize: 11, color: 'var(--ink-3)' }} className="num">
              {relativeTime(d.updatedAt)}
            </div>
          </div>
        </div>
      </td>

      {/* Actions: delete (owner only) */}
      <td style={{ padding: '12px 14px', textAlign: 'right' }}>
        {canDelete && (
          <button
            onClick={confirmDelete}
            disabled={del.isPending}
            title="Delete document"
            className="btn sm btn-ghost"
            style={{ color: 'var(--ink-3)', cursor: del.isPending ? 'wait' : 'pointer' }}
          >
            <Icon name="Trash2" size={14} />
          </button>
        )}
      </td>
    </tr>
  );
}
