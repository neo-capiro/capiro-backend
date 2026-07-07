// 1.7 Role Designation — F1Roles (prototype/02-flow1.jsx).
import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Btn,
  Card,
  FunnelShell,
  Icon,
  ScreenTitle,
  SelectInput,
  Tag,
  TextInput,
} from '../../ui/primitives';
import {
  useAdvanceSession,
  useFunnelApi,
  useFunnelSession,
  type FunnelSession,
  type RoleDesignation,
  type RoleMode,
} from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

type InviteRole = 'Super Admin' | 'Admin';
interface InviteRow {
  email: string;
  role: InviteRole;
}

export function AdminsPage() {
  const session = useFunnelSession();
  if (!session.data) return null;
  return <F1Roles session={session.data} />;
}

function F1Roles({ session }: { session: FunnelSession }) {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();

  const [roleMode, setRoleMode] = React.useState<RoleMode>(session.roleMode ?? 'self');
  const [invites, setInvites] = React.useState<InviteRow[]>(() => {
    const fromSession = (session.roleDesignations ?? []).map(
      (d): InviteRow => ({ email: d.email, role: d.role === 'super' ? 'Super Admin' : 'Admin' }),
    );
    return fromSession.length ? fromSession : [{ email: '', role: 'Super Admin' }];
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const setInvite = (i: number, patch: Partial<InviteRow>) => {
    setInvites(
      invites.map((row, idx) =>
        idx === i ? { email: patch.email ?? row.email, role: patch.role ?? row.role } : row,
      ),
    );
  };
  const hasSuper =
    roleMode === 'self' || invites.some((v) => v.role === 'Super Admin' && v.email.includes('@'));

  const submit = async () => {
    if (!hasSuper || busy) return;
    setBusy(true);
    setError(null);
    try {
      const designations: RoleDesignation[] =
        roleMode === 'invite'
          ? invites
              .filter((v) => v.email)
              .map((v) => ({ email: v.email, role: v.role === 'Super Admin' ? 'super' : 'admin' }))
          : [];
      await api.setRoles({ roleMode, designations });
      advanceSession({ state: 'roles_designated', roleMode, roleDesignations: designations });
      navigate('/clients');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <FunnelShell step={5} maxWidth={560}>
      <ScreenTitle
        title="Who will manage your organization's Capiro account?"
        sub="At least one Super Admin is required — this is the first platform account created."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-1)',
            borderRadius: 8,
            padding: '12px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
            <Icon name="ShieldCheck" size={14} style={{ color: 'var(--accent)' }} />
            <b style={{ fontSize: 12.5 }}>Super Admin</b>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
            Manages the entire firm on Capiro, <b>plus billing decisions and upgrades</b>.
          </div>
        </div>
        <div
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-1)',
            borderRadius: 8,
            padding: '12px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
            <Icon name="UserCog" size={14} style={{ color: 'var(--ink-3)' }} />
            <b style={{ fontSize: 12.5 }}>Admin</b>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>
            Everything a Super Admin can do — <b>except billing</b>, which stays hidden.
          </div>
        </div>
      </div>
      <Card>
        <div
          style={{
            display: 'flex',
            gap: 0,
            border: '1px solid var(--border-1)',
            borderRadius: 6,
            overflow: 'hidden',
            marginBottom: 18,
          }}
        >
          {(
            [
              ['self', "I'll be the Super Admin"],
              ['invite', 'Invite someone else'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setRoleMode(id)}
              style={{
                flex: 1,
                padding: '9px 0',
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: 'var(--font-sans)',
                cursor: 'pointer',
                border: 'none',
                background: roleMode === id ? 'var(--accent)' : '#fff',
                color: roleMode === id ? '#fff' : 'var(--ink-2)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {roleMode === 'self' ? (
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 6,
              padding: '12px 14px',
            }}
          >
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: 'linear-gradient(135deg,#2A57CE,#1A3F9F)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {(session.firstName[0] || '') + (session.lastName[0] || '')}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {session.firstName} {session.lastName}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{session.email}</div>
            </div>
            <Tag tone="blue">Super Admin</Tag>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {invites.map((v, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10 }}>
                <TextInput
                  placeholder="name@firm.com"
                  value={v.email}
                  onChange={(e) => setInvite(i, { email: e.target.value })}
                />
                <SelectInput
                  options={['Super Admin', 'Admin']}
                  value={v.role}
                  onChange={(r) => setInvite(i, { role: r as InviteRole })}
                />
              </div>
            ))}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setInvites([...invites, { email: '', role: 'Admin' }]);
              }}
              style={{ fontSize: 12.5, color: 'var(--accent)', fontWeight: 600 }}
            >
              + Add another
            </a>
            {!hasSuper && (
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--critical)',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                <Icon name="TriangleAlert" size={12} />
                Designate at least one Super Admin with a valid email.
              </div>
            )}
          </div>
        )}
        <div
          style={{
            marginTop: 16,
            fontSize: 11.5,
            color: 'var(--ink-3)',
            lineHeight: 1.5,
            background: 'var(--bg-sunken)',
            borderRadius: 6,
            padding: '10px 12px',
            display: 'flex',
            gap: 8,
          }}
        >
          <Icon name="Info" size={13} style={{ marginTop: 1, flexShrink: 0 }} />
          Super Admin is the only role that can purchase or upgrade client profiles.
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <Btn
          variant="primary"
          disabled={!hasSuper || busy}
          onClick={() => void submit()}
          style={{ width: '100%', marginTop: 16 }}
        >
          Continue
        </Btn>
      </Card>
      <div
        style={{
          marginTop: 16,
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent)',
          borderRadius: 8,
          padding: '14px 16px',
          display: 'flex',
          gap: 11,
        }}
      >
        <Icon
          name="Users"
          size={17}
          style={{ color: 'var(--accent-ink)', marginTop: 1, flexShrink: 0 }}
        />
        <div
          style={{ fontSize: 13, color: 'var(--accent-ink)', lineHeight: 1.55, textWrap: 'pretty' }}
        >
          <b>Invite the people who will set up your firm on Capiro.</b> These admins get access
          first — they authorize your firm's email, import your clients, and configure firm AI
          settings. Only once that firm-level setup is done is the rest of your team invited to log
          in.
        </div>
      </div>
    </FunnelShell>
  );
}
