/**
 * Workspace › Documents — the management list, ported to full fidelity from the
 * locked prototype (WsDocuments, asset_08) with the Phase-final LOCKED decisions:
 *
 *  - Header (Kicker + serif H1 + "New document" → useCreateDraft → Setup) + WsTabs.
 *  - Scope filter (All / Created by me / Shared with me) → useDrafts({scope}).
 *  - Sector select (All sectors + industries) → useDrafts({sector}). Live count
 *    (NO "due this week" string).
 *  - Columns: Document · Client · Type · Ask · State · Last edited · Team. The
 *    Deadline column is REMOVED (Q-DOC-1). No pagination (Q-DOC-3 — show all).
 *  - Document cell: Files/FileText icon, name, "Packet · N" badge when isPacket.
 *    The "Unsaved" pill is dropped (Q-DOC-pills); a "Shared" pill shows when the
 *    row isn't owned by the current user (useMe clerk id vs draft.ownerId; if
 *    ownership isn't resolvable, Shared only shows in the 'shared' scope).
 *  - State pill: Draft ↔ Complete toggle that PERSISTS via useUpdateDraft (Q-DOC-state).
 *  - Last edited: relative time from updatedAt + editor name ("You" if owned by me,
 *    else resolved via useTenantMembers, else "—").
 *  - Team: a single owner Ava resolved via tenant-members (lightweight — no per-row
 *    collaborator fan-out).
 *  - Row click opens THAT document by id (Q-DOC-2): /workspace/draft/:id.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { Icon, Ava, Kicker } from './kit.js';
import { WsTabs } from './WsTabs.js';
import {
  useCreateDraft,
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

  // Resolve a tenant member by Capiro user id (drafts carry ownerId = Capiro user
  // id) for the editor name + owner avatar.
  const memberById = useMemo(() => {
    const map = new Map<string, WsTenantMember>();
    (members ?? []).forEach((m) => map.set(m.id, m));
    return map;
  }, [members]);

  // The owning draft is "mine" when the draft.ownerId resolves to the signed-in
  // user. Drafts store the Capiro user id; map it to a clerk id for the compare.
  const isMine = (d: WsDraft): boolean => {
    if (!selfClerkId) return false;
    const owner = memberById.get(d.ownerId);
    return !!owner && owner.clerkUserId === selfClerkId;
  };

  // Show "Shared" when the row isn't owned by me. If ownership can't be resolved
  // (no member match yet), only surface Shared in the explicit 'shared' scope.
  const isShared = (d: WsDraft): boolean => {
    const owner = memberById.get(d.ownerId);
    if (!owner || !selfClerkId) return scope === 'shared';
    return owner.clerkUserId !== selfClerkId;
  };

  const editorName = (d: WsDraft): string => {
    if (isMine(d)) return 'You';
    return memberById.get(d.ownerId)?.name ?? '—';
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
                {['Document', 'Client', 'Type', 'Ask', 'State', 'Last edited', 'Team'].map(
                  (h, i) => (
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
                  ),
                )}
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
                    editor={editorName(d)}
                    ownerInitials={memberById.get(d.ownerId)?.initials ?? null}
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

/** One document row. State pill persists; row click opens the draft by id. */
function DocRow({
  draft: d,
  first,
  shared,
  editor,
  ownerInitials,
  onOpen,
}: {
  draft: WsDraft;
  first: boolean;
  shared: boolean;
  editor: string;
  ownerInitials: string | null;
  onOpen: () => void;
}) {
  const { message } = AntApp.useApp();
  const update = useUpdateDraft(d.id);
  const isComplete = d.status === 'complete';

  const toggleStatus = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = isComplete ? 'draft' : 'complete';
    update.mutate(
      { status: next },
      {
        onSuccess: () => message.success(next === 'complete' ? 'Marked complete' : 'Marked draft'),
        onError: () => message.error('Could not update'),
      },
    );
  };

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

      {/* State: Complete / Draft toggle — PERSISTS via useUpdateDraft */}
      <td style={{ padding: '12px 14px' }}>
        <button
          onClick={toggleStatus}
          disabled={update.isPending}
          title="Toggle complete / draft"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '4px 11px',
            borderRadius: 20,
            border: '1.5px solid',
            borderColor: isComplete ? 'var(--success)' : 'var(--border-1)',
            background: isComplete ? 'rgba(46,107,67,.09)' : 'var(--bg-surface)',
            color: isComplete ? 'var(--success)' : 'var(--ink-3)',
            fontSize: 11.5,
            fontWeight: 600,
            cursor: update.isPending ? 'wait' : 'pointer',
            fontFamily: 'var(--font-sans)',
            whiteSpace: 'nowrap',
            transition: 'all 0.12s',
            opacity: update.isPending ? 0.6 : 1,
          }}
        >
          <Icon name={isComplete ? 'CheckCircle2' : 'Circle'} size={12} />
          {isComplete ? 'Complete' : 'Draft'}
        </button>
      </td>

      <td style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink-1)' }}>{editor}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)' }} className="num">
          {relativeTime(d.updatedAt)}
        </div>
      </td>
      <td style={{ padding: '12px 14px' }}>
        {ownerInitials ? (
          <Ava x={ownerInitials} size={24} />
        ) : (
          <span style={{ color: 'var(--ink-4)' }}>—</span>
        )}
      </td>
    </tr>
  );
}
