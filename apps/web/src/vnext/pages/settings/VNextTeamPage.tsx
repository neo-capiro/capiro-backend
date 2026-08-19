/**
 * vNext re-skin of pages/admin/TeamPage.tsx — identical endpoints, query keys,
 * copy, the invite modal (required + email validation), inline role select,
 * billing-admin switch semantics (grantable by an existing billing admin or
 * Capiro staff; server enforces the grant rule), and the remove confirmation.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { CapiroTooltip } from '../../components/menus/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { SvSwitch, useSvConfirm } from './settings-ui.js';

interface TeamRow {
  membershipId: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: 'capiro_admin' | 'user_admin' | 'standard_user' | 'client_portal_user';
  status: 'invited' | 'active' | 'removed';
  billingAdmin: boolean;
  joinedAt: string | null;
  lastSeenAt: string | null;
}

interface InvitationRow {
  id: string;
  email: string;
  role: 'user_admin' | 'standard_user';
  createdAt: string;
  expiresAt: string | null;
}

interface InviteFormState {
  email: string;
  role: 'user_admin' | 'standard_user';
  firstName: string;
  lastName: string;
}

const EMPTY_INVITE: InviteFormState = {
  email: '',
  role: 'standard_user',
  firstName: '',
  lastName: '',
};

export function VNextTeamPage() {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInviteForm] = useState<InviteFormState>(EMPTY_INVITE);
  const [inviteError, setInviteError] = useState<string | undefined>();
  const [tab, setTab] = useState<'members' | 'invitations'>('members');

  const team = useQuery<TeamRow[]>({
    queryKey: ['team'],
    queryFn: async () => (await api.get('/api/tenant-admin/team')).data,
  });
  const invitations = useQuery<InvitationRow[]>({
    queryKey: ['team', 'invitations'],
    queryFn: async () => (await api.get('/api/tenant-admin/team/invitations')).data,
  });

  const sendInvite = useMutation({
    mutationFn: async (input: {
      email: string;
      role: 'user_admin' | 'standard_user';
      firstName?: string;
      lastName?: string;
    }) => (await api.post('/api/tenant-admin/team/invite', input)).data,
    onSuccess: (_data, variables) => {
      toast.success(`Invitation sent to ${variables.email}`);
      setInviteOpen(false);
      setInviteForm(EMPTY_INVITE);
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['team', 'invitations'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (userId: string) =>
      (await api.delete(`/api/tenant-admin/team/${userId}`)).data,
    onSuccess: () => {
      toast.success('Member removed');
      qc.invalidateQueries({ queryKey: ['team'] });
    },
  });

  const updateRole = useMutation({
    mutationFn: async (input: { userId: string; role: 'user_admin' | 'standard_user' }) =>
      (await api.put(`/api/tenant-admin/team/${input.userId}/role`, { role: input.role })).data,
    onSuccess: () => {
      toast.success('Member role updated');
      qc.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const resend = useMutation({
    mutationFn: async (invitationId: string) =>
      (await api.post(`/api/tenant-admin/team/invitations/${invitationId}/resend`)).data,
    onSuccess: () => {
      toast.success('Invitation re-sent');
      qc.invalidateQueries({ queryKey: ['team', 'invitations'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // Billing permission (onboarding v1 "Super Admin" bit). Server enforces the
  // grant rule: capiro_admin or an existing billing admin.
  const setBillingAdmin = useMutation({
    mutationFn: async (input: { userId: string; billingAdmin: boolean }) =>
      (
        await api.put(`/api/tenant-admin/team/${input.userId}/billing-admin`, {
          billingAdmin: input.billingAdmin,
        })
      ).data,
    onSuccess: (_data, variables) => {
      toast.success(
        variables.billingAdmin ? 'Billing permission granted' : 'Billing permission removed',
      );
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const canGrantBilling = Boolean(me.data?.billingAdmin);

  const submitInvite = () => {
    const email = invite.email.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError('A valid email is required');
      return;
    }
    setInviteError(undefined);
    sendInvite.mutate({
      email,
      role: invite.role,
      ...(invite.firstName.trim() ? { firstName: invite.firstName.trim() } : {}),
      ...(invite.lastName.trim() ? { lastName: invite.lastName.trim() } : {}),
    });
  };

  return (
    <div className="stv-stack">
      <div className="stv-row stv-row--end">
        <CapiroButton variant="primary" onClick={() => setInviteOpen(true)}>
          Add team member
        </CapiroButton>
      </div>

      <CapiroTabs
        label="Team views"
        activeId={tab}
        onChange={(id) => setTab(id as 'members' | 'invitations')}
        items={[
          { id: 'members', label: `Members (${team.data?.length ?? 0})` },
          { id: 'invitations', label: `Pending invitations (${invitations.data?.length ?? 0})` },
        ]}
      />

      {tab === 'members' ? (
        team.isLoading ? (
          <div className="stv-stack" aria-label="Loading team">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="80%" />
          </div>
        ) : (
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Email</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Role</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>
                    <CapiroTooltip content="Billing admins can view billing, invoices, and purchase or upgrade client profiles. Grantable by an existing billing admin or Capiro staff.">
                      <span>Billing</span>
                    </CapiroTooltip>
                  </CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Joined</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell />
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {(team.data ?? []).map((r) => (
                  <tr key={r.membershipId}>
                    <CapiroTableCell>
                      {r.firstName || r.lastName
                        ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() + ` <${r.email}>`
                        : r.email}
                    </CapiroTableCell>
                    <CapiroTableCell>
                      {r.status === 'active' &&
                      (r.role === 'standard_user' || r.role === 'user_admin') &&
                      r.userId !== me.data?.user.id ? (
                        <span style={{ display: 'inline-block', width: 150 }}>
                          <CapiroSelect
                            label={`Role for ${r.email}`}
                            value={r.role}
                            disabled={updateRole.isPending}
                            onChange={(event) =>
                              updateRole.mutate({
                                userId: r.userId,
                                role: event.target.value as 'user_admin' | 'standard_user',
                              })
                            }
                            options={[
                              { value: 'standard_user', label: 'Standard user' },
                              { value: 'user_admin', label: 'User admin' },
                            ]}
                          />
                        </span>
                      ) : (
                        <CapiroBadge>{r.role.replace(/_/g, ' ')}</CapiroBadge>
                      )}
                    </CapiroTableCell>
                    <CapiroTableCell>
                      {r.status === 'active' && (r.role === 'user_admin' || r.billingAdmin) ? (
                        <SvSwitch
                          checked={r.billingAdmin}
                          aria-label={`Billing permission for ${r.email}`}
                          disabled={
                            !canGrantBilling ||
                            setBillingAdmin.isPending ||
                            (r.role !== 'user_admin' && !r.billingAdmin)
                          }
                          onChange={(billingAdmin) =>
                            setBillingAdmin.mutate({ userId: r.userId, billingAdmin })
                          }
                        />
                      ) : (
                        <CapiroBadge>—</CapiroBadge>
                      )}
                    </CapiroTableCell>
                    <CapiroTableCell>
                      <CapiroBadge
                        tone={
                          r.status === 'active'
                            ? 'success'
                            : r.status === 'removed'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {r.status}
                      </CapiroBadge>
                    </CapiroTableCell>
                    <CapiroTableCell>{r.joinedAt}</CapiroTableCell>
                    <CapiroTableCell>
                      {r.status === 'active' ? (
                        <CapiroButton
                          size="compact"
                          className="stv-btn-danger"
                          onClick={() =>
                            confirm({
                              title: 'Remove from tenant?',
                              okText: 'Remove',
                              danger: true,
                              onOk: () => remove.mutateAsync(r.userId),
                            })
                          }
                        >
                          Remove
                        </CapiroButton>
                      ) : null}
                    </CapiroTableCell>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
        )
      ) : invitations.isLoading ? (
        <div className="stv-stack" aria-label="Loading invitations">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="80%" />
        </div>
      ) : (
        <CapiroTableWrap>
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell>Email</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Role</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Sent</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Expires</CapiroTableHeaderCell>
                <CapiroTableHeaderCell />
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {(invitations.data ?? []).map((r) => (
                <tr key={r.id}>
                  <CapiroTableCell>{r.email}</CapiroTableCell>
                  <CapiroTableCell>
                    <CapiroBadge>{r.role.replace(/_/g, ' ')}</CapiroBadge>
                  </CapiroTableCell>
                  <CapiroTableCell>{r.createdAt}</CapiroTableCell>
                  <CapiroTableCell>{r.expiresAt}</CapiroTableCell>
                  <CapiroTableCell>
                    <CapiroButton size="compact" onClick={() => resend.mutate(r.id)}>
                      Resend
                    </CapiroButton>
                  </CapiroTableCell>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      )}

      <CapiroModal open={inviteOpen} title="Add team member" onClose={() => setInviteOpen(false)}>
        <form
          className="stv-stack"
          onSubmit={(event) => {
            event.preventDefault();
            submitInvite();
          }}
        >
          <div className="stv-grid-2">
            <CapiroInput
              label="First name"
              placeholder="Jane"
              value={invite.firstName}
              onChange={(e) => setInviteForm((c) => ({ ...c, firstName: e.target.value }))}
            />
            <CapiroInput
              label="Last name"
              placeholder="Doe"
              value={invite.lastName}
              onChange={(e) => setInviteForm((c) => ({ ...c, lastName: e.target.value }))}
            />
          </div>
          <CapiroInput
            label="Email"
            placeholder="teammate@example.com"
            value={invite.email}
            error={inviteError}
            onChange={(e) => setInviteForm((c) => ({ ...c, email: e.target.value }))}
          />
          <CapiroSelect
            label="Role"
            value={invite.role}
            onChange={(e) =>
              setInviteForm((c) => ({
                ...c,
                role: e.target.value as 'user_admin' | 'standard_user',
              }))
            }
            options={[
              { value: 'standard_user', label: 'Standard user' },
              { value: 'user_admin', label: 'User admin' },
            ]}
          />
          <div className="stv-row stv-row--end">
            <CapiroButton onClick={() => setInviteOpen(false)}>Cancel</CapiroButton>
            <CapiroButton variant="primary" type="submit" loading={sendInvite.isPending}>
              Send invitation
            </CapiroButton>
          </div>
        </form>
      </CapiroModal>

      {dialog}
    </div>
  );
}
