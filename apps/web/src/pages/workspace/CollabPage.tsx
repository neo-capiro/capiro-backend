/**
 * Collaborate screen (Phase 7) — ported from the prototype `WsCollab`
 * (asset_11). Invite collaborators to a work product (the draft, surfaced as
 * "this document"), see People-with-access, and change/remove roles. Reached
 * from the editor toolbar's Share button (/workspace/collab/:draftId).
 *
 * Wired to the engine collaborator hooks (useCollaborators / useInviteCollaborator
 * / useUpdateCollaboratorRole / useRemoveCollaborator) and the identity resolver
 * (useTenantMembers → name/initials by Clerk user id). Internal vs external is
 * resolved on the client: a typed email matching a tenant member is sent as a
 * `subjectId` (joins active); any other email is sent raw (joins pending).
 *
 * Owner-only controls (the invite row, role dropdowns, remove) are shown only to
 * the document owner — the server enforces the same matrix regardless.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Spin } from 'antd';
import { Ava, Icon } from './kit.js';
import { StepsRail } from './StepsRail.js';
import type { WsAssignableRole, WsCollaborator } from './types.js';
import {
  initials as initialsOf,
  useCollaborators,
  useDraft,
  useInviteCollaborator,
  useRemoveCollaborator,
  useSendCollabInviteEmail,
  useTenantMembers,
  useUpdateCollaboratorRole,
  type WsTenantMember,
} from './api.js';
import { useMe } from '../../lib/me.js';

// Role label ↔ value + description (prototype ROLES + legend).
const ROLES: Array<{ value: WsAssignableRole; label: string; desc: string }> = [
  { value: 'editor', label: 'Editor', desc: 'Edit, draft & comment' },
  { value: 'reviewer', label: 'Reviewer', desc: 'Comment & approve' },
  { value: 'commenter', label: 'Commenter', desc: 'Comment only' },
  { value: 'viewer', label: 'Viewer', desc: 'Read & export' },
];

function roleLabel(role: string): string {
  if (role === 'owner') return 'Owner';
  return ROLES.find((r) => r.value === role)?.label ?? role;
}

export function CollabPage() {
  const { draftId } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const { data: draft, isLoading: draftLoading } = useDraft(draftId ?? null);
  const { data: collaborators, isLoading: collabLoading } = useCollaborators(draftId ?? null);
  const { data: members } = useTenantMembers();
  const { data: me } = useMe();

  const invite = useInviteCollaborator(draftId ?? '');
  const updateRole = useUpdateCollaboratorRole(draftId ?? '');
  const removeCollab = useRemoveCollaborator(draftId ?? '');
  const sendInviteEmail = useSendCollabInviteEmail();

  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WsAssignableRole>('editor');
  const [showRoleMenu, setShowRoleMenu] = useState(false);

  const selfClerkId = me?.user.clerkUserId ?? null;
  const isOwner = useMemo(() => {
    const owner = collaborators?.find((c) => c.isOwner);
    return !!owner && !!selfClerkId && owner.subjectId === selfClerkId;
  }, [collaborators, selfClerkId]);

  // Resolve a tenant member by Clerk user id (name + initials for the access list).
  const memberByClerk = useMemo(() => {
    const map = new Map<string, WsTenantMember>();
    (members ?? []).forEach((m) => map.set(m.clerkUserId, m));
    return map;
  }, [members]);

  const back = () => navigate(`/workspace/draft/${draftId}`);

  if (draftLoading || collabLoading || !draft) {
    return (
      <div className="ws-shell">
        <StepsRail active="draft" draftId={draftId} />
        <div className="ws-stage" style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      </div>
    );
  }

  const program = draft.config?.client || draft.product || 'Document';

  // The inviter's display name (current user, resolved via the tenant roster).
  const inviterName = (selfClerkId && memberByClerk.get(selfClerkId)?.name) || undefined;

  const onInvite = () => {
    const raw = email.trim();
    if (!raw) {
      message.warning('Enter an email to invite');
      return;
    }
    // Internal teammate? Match the typed email against a tenant member.
    const member = (members ?? []).find((m) => m.email.toLowerCase() === raw.toLowerCase());
    const body = member
      ? { subjectId: member.clerkUserId, name: member.name, role: inviteRole, inviterName }
      : { email: raw, role: inviteRole, inviterName };
    invite.mutate(body, {
      onSuccess: () => {
        setEmail('');
        // E-19: every invite is now pending until accepted; send the email too
        // (best-effort — the in-app notification is the source of truth).
        sendInviteEmail.mutate({
          toEmail: member?.email ?? raw,
          toName: member?.name ?? undefined,
          draftTitle: draft.docTitle,
          role: inviteRole,
          link: `${window.location.origin}/workspace/draft/${draftId}`,
          inviterName,
        });
        message.success(`Invitation sent to ${member?.name ?? raw}`);
      },
      onError: (e: unknown) => message.error(errMsg(e, 'Could not invite collaborator')),
    });
  };

  return (
    <div className="ws-shell">
      <StepsRail active="draft" draftId={draftId} product={draft.product} />
      <div className="ws-stage">
        {/* Top bar: Share kicker + title + Back to editor. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 18,
            maxWidth: 560,
            margin: '0 auto 18px',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: '0.09em',
                color: 'var(--ws-ink-3, var(--ink-3))',
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              Share · {program}
            </div>
            <h1
              style={{
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 23,
                letterSpacing: '-0.01em',
                margin: 0,
                lineHeight: 1.15,
              }}
            >
              {draft.docTitle}
            </h1>
          </div>
          <button className="btn sm" onClick={back}>
            <Icon name="ArrowLeft" size={13} />
            Back to editor
          </button>
        </div>

        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
              Invite collaborators
            </div>

            {/* Invite row — owner only (server enforces too). */}
            {isOwner && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <div
                    className="field"
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 11px',
                    }}
                  >
                    <Icon name="Mail" size={14} style={{ color: 'var(--ink-3)', flex: 'none' }} />
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onInvite();
                      }}
                      placeholder="name@firm.com"
                      style={{
                        flex: 1,
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        fontSize: 12.5,
                        fontFamily: 'var(--font-sans)',
                        color: 'var(--ink-1)',
                      }}
                    />
                  </div>
                  <div style={{ position: 'relative' }}>
                    <button
                      onClick={() => setShowRoleMenu((v) => !v)}
                      className="field"
                      style={{
                        width: 120,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '8px 10px',
                        fontSize: 12.5,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <span style={{ flex: 1, textAlign: 'left' }}>{roleLabel(inviteRole)}</span>
                      <Icon name="ChevronDown" size={13} style={{ color: 'var(--ink-3)' }} />
                    </button>
                    {showRoleMenu && (
                      <div
                        className="card"
                        style={{
                          position: 'absolute',
                          top: 'calc(100% + 4px)',
                          right: 0,
                          width: 200,
                          zIndex: 40,
                          padding: 5,
                          boxShadow: 'var(--shadow-2)',
                        }}
                      >
                        {ROLES.map((r) => (
                          <button
                            key={r.value}
                            onClick={() => {
                              setInviteRole(r.value);
                              setShowRoleMenu(false);
                            }}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 1,
                              width: '100%',
                              textAlign: 'left',
                              padding: '8px 10px',
                              border: 'none',
                              background:
                                inviteRole === r.value ? 'var(--accent-soft)' : 'transparent',
                              borderRadius: 6,
                              cursor: 'pointer',
                              fontFamily: 'var(--font-sans)',
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12.5,
                                fontWeight: 600,
                                color:
                                  inviteRole === r.value ? 'var(--accent-ink)' : 'var(--ink-1)',
                              }}
                            >
                              {r.label}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{r.desc}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className="btn btn-accent" onClick={onInvite} disabled={invite.isPending}>
                    Invite
                  </button>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-3)',
                    marginBottom: 16,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Icon name="Info" size={12} />
                  Internal firm teammates and client SMEs. Any role can comment.
                </div>
              </>
            )}

            {/* People with access. */}
            <div
              style={{
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                color: 'var(--ink-3)',
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              People with access
            </div>
            {(collaborators ?? []).map((c, i) => (
              <AccessRow
                key={c.id}
                collaborator={c}
                first={i === 0}
                self={!!selfClerkId && c.subjectId === selfClerkId}
                memberByClerk={memberByClerk}
                canManage={isOwner && !c.isOwner}
                firmName={draft.config?.client || me?.tenant.name || ''}
                onChangeRole={(role) =>
                  updateRole.mutate(
                    { id: c.id, role },
                    {
                      onError: (e: unknown) => message.error(errMsg(e, 'Could not change role')),
                    },
                  )
                }
                onRemove={() =>
                  removeCollab.mutate(c.id, {
                    onSuccess: () => message.success('Collaborator removed'),
                    onError: (e: unknown) => message.error(errMsg(e, 'Could not remove')),
                  })
                }
              />
            ))}

            {/* Roles legend. */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--border-1)',
              }}
            >
              {ROLES.map((r) => (
                <div key={r.value} style={{ minWidth: 120 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>{r.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{r.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Footer pointer to version history (lives in the editor toolbar). */}
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--ink-3)',
              marginTop: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              justifyContent: 'center',
            }}
          >
            <Icon name="History" size={13} />
            Looking for past edits? Version history is in the editor toolbar.
          </div>
        </div>
      </div>
    </div>
  );
}

/** One row in the People-with-access list. */
function AccessRow({
  collaborator: c,
  first,
  self,
  memberByClerk,
  canManage,
  firmName,
  onChangeRole,
  onRemove,
}: {
  collaborator: WsCollaborator;
  first: boolean;
  self: boolean;
  memberByClerk: Map<string, WsTenantMember>;
  canManage: boolean;
  firmName: string;
  onChangeRole: (role: WsAssignableRole) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // Resolve display name + initials: prefer a tenant-member match, then the
  // denormalized name, then the email local-part.
  const member = c.subjectId ? memberByClerk.get(c.subjectId) : undefined;
  const name =
    member?.name || c.name || (c.email ? c.email.split('@')[0] : undefined) || 'Collaborator';
  const avatar = member?.initials || initialsOf(name);
  const note =
    c.status === 'pending'
      ? `Pending · ${c.email ?? ''}`
      : c.email
        ? c.email
        : firmName || 'Internal teammate';

  return (
    <div
      ref={rowRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '10px 0',
        borderTop: first ? 'none' : '1px solid var(--border-1)',
      }}
    >
      <Ava x={avatar} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {name}
          {self && <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}> · you</span>}
          {c.status === 'pending' && (
            <span className="pill muted" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
              Invited
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--ink-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {note}
        </div>
      </div>

      {/* Owner shows the role as an info pill; others a role dropdown + remove. */}
      {c.isOwner || !canManage ? (
        <span className={c.isOwner ? 'pill info' : 'pill muted'}>{roleLabel(c.role)}</span>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setOpen((v) => !v)}
              className="field"
              style={{
                width: 116,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 9px',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <span style={{ flex: 1, textAlign: 'left' }}>{roleLabel(c.role)}</span>
              <Icon name="ChevronDown" size={12} style={{ color: 'var(--ink-3)' }} />
            </button>
            {open && (
              <div
                className="card"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  right: 0,
                  width: 200,
                  zIndex: 40,
                  padding: 5,
                  boxShadow: 'var(--shadow-2)',
                }}
              >
                {ROLES.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => {
                      setOpen(false);
                      if (r.value !== c.role) onChangeRole(r.value);
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      border: 'none',
                      background: c.role === r.value ? 'var(--accent-soft)' : 'transparent',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: c.role === r.value ? 'var(--accent-ink)' : 'var(--ink-1)',
                      }}
                    >
                      {r.label}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{r.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="btn sm"
            title="Remove access"
            onClick={onRemove}
            style={{ padding: '5px 8px' }}
          >
            <Icon name="X" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Pull a human message off an axios-ish error. */
function errMsg(e: unknown, fallback: string): string {
  const resp = (e as { response?: { data?: { message?: string | string[] } } })?.response;
  const m = resp?.data?.message;
  if (Array.isArray(m)) return m[0] ?? fallback;
  return m ?? fallback;
}
