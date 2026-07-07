import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';

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

export function TeamPage() {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [form] = Form.useForm<{
    email: string;
    role: 'user_admin' | 'standard_user';
    firstName?: string;
    lastName?: string;
  }>();

  const team = useQuery<TeamRow[]>({
    queryKey: ['team'],
    queryFn: async () => (await api.get('/api/tenant-admin/team')).data,
  });
  const invitations = useQuery<InvitationRow[]>({
    queryKey: ['team', 'invitations'],
    queryFn: async () => (await api.get('/api/tenant-admin/team/invitations')).data,
  });

  const invite = useMutation({
    mutationFn: async (input: {
      email: string;
      role: 'user_admin' | 'standard_user';
      firstName?: string;
      lastName?: string;
    }) => (await api.post('/api/tenant-admin/team/invite', input)).data,
    onSuccess: (_data, variables) => {
      message.success(`Invitation sent to ${variables.email}`);
      setInviteOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['team', 'invitations'] });
    },
    onError: (err) => message.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (userId: string) =>
      (await api.delete(`/api/tenant-admin/team/${userId}`)).data,
    onSuccess: () => {
      message.success('Member removed');
      qc.invalidateQueries({ queryKey: ['team'] });
    },
  });

  const updateRole = useMutation({
    mutationFn: async (input: { userId: string; role: 'user_admin' | 'standard_user' }) =>
      (await api.put(`/api/tenant-admin/team/${input.userId}/role`, { role: input.role })).data,
    onSuccess: () => {
      message.success('Member role updated');
      qc.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (err) => message.error((err as Error).message),
  });

  const resend = useMutation({
    mutationFn: async (invitationId: string) =>
      (await api.post(`/api/tenant-admin/team/invitations/${invitationId}/resend`)).data,
    onSuccess: () => {
      message.success('Invitation re-sent');
      qc.invalidateQueries({ queryKey: ['team', 'invitations'] });
    },
    onError: (err) => message.error((err as Error).message),
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
      message.success(
        variables.billingAdmin ? 'Billing permission granted' : 'Billing permission removed',
      );
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => message.error((err as Error).message),
  });
  const canGrantBilling = Boolean(me.data?.billingAdmin);

  return (
    <>
      <Space style={{ marginBottom: 16, justifyContent: 'flex-end', width: '100%' }}>
        <Button type="primary" onClick={() => setInviteOpen(true)}>
          Add team member
        </Button>
      </Space>
      <Tabs
        items={[
          {
            key: 'members',
            label: `Members (${team.data?.length ?? 0})`,
            children: (
              <Table<TeamRow>
                rowKey="membershipId"
                loading={team.isLoading}
                dataSource={team.data ?? []}
                pagination={false}
                columns={[
                  {
                    title: 'Email',
                    dataIndex: 'email',
                    render: (v, r) =>
                      r.firstName || r.lastName
                        ? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() + ` <${v}>`
                        : v,
                  },
                  {
                    title: 'Role',
                    dataIndex: 'role',
                    width: 160,
                    render: (v: TeamRow['role'], r) =>
                      r.status === 'active' &&
                      (v === 'standard_user' || v === 'user_admin') &&
                      r.userId !== me.data?.user.id ? (
                        <Select
                          size="small"
                          value={v}
                          disabled={updateRole.isPending}
                          onChange={(role: 'user_admin' | 'standard_user') =>
                            updateRole.mutate({ userId: r.userId, role })
                          }
                          options={[
                            { value: 'standard_user', label: 'Standard user' },
                            { value: 'user_admin', label: 'User admin' },
                          ]}
                          style={{ width: 150 }}
                        />
                      ) : (
                        <Tag>{v.replace(/_/g, ' ')}</Tag>
                      ),
                  },
                  {
                    title: (
                      <Tooltip title="Billing admins can view billing, invoices, and purchase or upgrade client profiles. Grantable by an existing billing admin or Capiro staff.">
                        Billing
                      </Tooltip>
                    ),
                    dataIndex: 'billingAdmin',
                    width: 90,
                    render: (v: boolean, r) =>
                      r.status === 'active' && (r.role === 'user_admin' || v) ? (
                        <Switch
                          size="small"
                          checked={v}
                          disabled={
                            !canGrantBilling ||
                            setBillingAdmin.isPending ||
                            (r.role !== 'user_admin' && !v)
                          }
                          onChange={(billingAdmin) =>
                            setBillingAdmin.mutate({ userId: r.userId, billingAdmin })
                          }
                        />
                      ) : (
                        <Tag>—</Tag>
                      ),
                  },
                  {
                    title: 'Status',
                    dataIndex: 'status',
                    width: 110,
                    render: (v: TeamRow['status']) => (
                      <Tag color={v === 'active' ? 'green' : v === 'removed' ? 'default' : 'gold'}>
                        {v}
                      </Tag>
                    ),
                  },
                  { title: 'Joined', dataIndex: 'joinedAt', width: 200 },
                  {
                    title: '',
                    width: 100,
                    render: (_v, r) =>
                      r.status === 'active' ? (
                        <Popconfirm
                          title="Remove from tenant?"
                          okText="Remove"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => remove.mutate(r.userId)}
                        >
                          <Button danger size="small">
                            Remove
                          </Button>
                        </Popconfirm>
                      ) : null,
                  },
                ]}
              />
            ),
          },
          {
            key: 'invitations',
            label: `Pending invitations (${invitations.data?.length ?? 0})`,
            children: (
              <Table<InvitationRow>
                rowKey="id"
                loading={invitations.isLoading}
                dataSource={invitations.data ?? []}
                pagination={false}
                columns={[
                  { title: 'Email', dataIndex: 'email' },
                  {
                    title: 'Role',
                    dataIndex: 'role',
                    width: 160,
                    render: (v) => <Tag>{v.replace(/_/g, ' ')}</Tag>,
                  },
                  { title: 'Sent', dataIndex: 'createdAt', width: 200 },
                  { title: 'Expires', dataIndex: 'expiresAt', width: 200 },
                  {
                    title: '',
                    width: 110,
                    render: (_v, r) => (
                      <Button size="small" onClick={() => resend.mutate(r.id)}>
                        Resend
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Modal
        title="Add team member"
        open={inviteOpen}
        onCancel={() => setInviteOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={invite.isPending}
        okText="Send invitation"
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ role: 'standard_user' }}
          onFinish={(values) => invite.mutate(values)}
        >
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="firstName" label="First name" style={{ flex: 1 }}>
              <Input placeholder="Jane" />
            </Form.Item>
            <Form.Item name="lastName" label="Last name" style={{ flex: 1 }}>
              <Input placeholder="Doe" />
            </Form.Item>
          </Space>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input placeholder="teammate@example.com" />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'standard_user', label: 'Standard user' },
                { value: 'user_admin', label: 'User admin' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
