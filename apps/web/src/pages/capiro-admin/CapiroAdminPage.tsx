import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import { AiKeysAdminPanel } from './AiKeysAdminPanel.js';

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  clerkOrgId: string | null;
  logoS3Key: string | null;
  createdAt: string;
  _count: { memberships: number; clients: number };
}

interface CreateTenantInput {
  slug: string;
  name: string;
  adminEmail: string;
  adminFirstName?: string;
  adminLastName?: string;
}

export function CapiroAdminPage() {
  return (
    <>
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 16 }}>
        Capiro Admin
      </Typography.Title>
      <Tabs
        defaultActiveKey="tenants"
        items={[
          { key: 'tenants', label: 'Tenants', children: <TenantsTab /> },
          { key: 'personnel-merge', label: 'Personnel Merge Queue', children: <PersonnelMergeTab /> },
          { key: 'ai-keys', label: 'AI Keys & Usage', children: <AiKeysAdminPanel /> },
        ]}
      />
    </>
  );
}

// ── Tab 1: Tenants (existing functionality) ─────────────────────────────────

function TenantsTab() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { start: startImpersonation } = useImpersonation();
  const [open, setOpen] = useState(false);
  const [impOpen, setImpOpen] = useState<TenantRow | null>(null);
  // Second-step delete confirmation: the Popconfirm arms this, the modal below
  // requires typing DELETE before the destructive mutation actually fires.
  const [deleteTarget, setDeleteTarget] = useState<TenantRow | null>(null);
  const [form] = Form.useForm<CreateTenantInput>();
  const [reasonForm] = Form.useForm<{ reason: string }>();
  const [deleteForm] = Form.useForm<{ confirm: string }>();
  const deleteConfirm = Form.useWatch('confirm', deleteForm);

  const tenants = useQuery<TenantRow[]>({
    queryKey: ['capiro-admin', 'tenants'],
    queryFn: async () => (await api.get('/api/capiro-admin/tenants')).data,
  });

  const create = useMutation({
    mutationFn: async (input: CreateTenantInput) =>
      (await api.post('/api/capiro-admin/tenants', input)).data,
    onSuccess: (_data, vars) => {
      message.success(`Tenant created. Invitation email sent to ${vars.adminEmail}`);
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenants'] });
    },
    onError: (err) => message.error((err as Error).message),
  });

  const deleteTenant = useMutation({
    mutationFn: async (tenantId: string) =>
      (await api.delete(`/api/capiro-admin/tenants/${tenantId}`)).data,
    onSuccess: (_data, tenantId) => {
      const t = tenants.data?.find((x) => x.id === tenantId);
      message.success(`Tenant ${t?.slug ?? ''} deleted`);
      setDeleteTarget(null);
      deleteForm.resetFields();
      qc.invalidateQueries({ queryKey: ['capiro-admin', 'tenants'] });
    },
    onError: (err) => message.error((err as Error).message),
  });

  const impersonate = useMutation({
    mutationFn: async (input: { tenantId: string; tenantSlug: string; reason: string }) =>
      (
        await api.post('/api/capiro-admin/impersonate', {
          tenantId: input.tenantId,
          reason: input.reason,
        })
      ).data,
    onSuccess: (_data, vars) => {
      startImpersonation(vars.tenantSlug);
      setImpOpen(null);
      reasonForm.resetFields();
      qc.invalidateQueries(); // any data is now from the impersonated tenant
      message.success(`Acting as ${vars.tenantSlug}. Use the chip in the header to end.`);
      navigate('/');
    },
    onError: (err) => message.error((err as Error).message),
  });

  return (
    <>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Tenants
        </Typography.Title>
        <Button type="primary" onClick={() => setOpen(true)}>
          Create tenant
        </Button>
      </Space>
      <Table<TenantRow>
        rowKey="id"
        loading={tenants.isLoading}
        dataSource={tenants.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Slug', dataIndex: 'slug', width: 200 },
          { title: 'Name', dataIndex: 'name' },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 110,
            render: (v) => (
              <Tag color={v === 'active' ? 'green' : v === 'suspended' ? 'red' : 'gold'}>{v}</Tag>
            ),
          },
          {
            title: 'Members',
            width: 100,
            render: (_v, r) => r._count.memberships,
          },
          {
            title: 'Clients',
            width: 100,
            render: (_v, r) => r._count.clients,
          },
          { title: 'Created', dataIndex: 'createdAt', width: 200 },
          {
            title: '',
            width: 200,
            render: (_v, r) => (
              <Space>
                <Popconfirm
                  title="Impersonate this tenant?"
                  description="A reason will be required and audit-logged."
                  okText="Continue"
                  onConfirm={() => setImpOpen(r)}
                >
                  <Button size="small">Impersonate</Button>
                </Popconfirm>
                <Popconfirm
                  title={`Delete tenant "${r.slug}"?`}
                  description="Permanently deletes the tenant, its Clerk org, all members, clients, meetings and data. This cannot be undone."
                  okText="Continue"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => {
                    deleteForm.resetFields();
                    setDeleteTarget(r);
                  }}
                >
                  <Button size="small" danger>
                    Delete
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      {/* Create tenant */}
      <Modal
        title="Create tenant + invite admin"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="Create + send invite"
      >
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
          <Form.Item
            name="slug"
            label="Tenant slug"
            extra="Lowercase, [a-z0-9-]. The first label of the tenant subdomain (slug.app.capiro.ai)."
            rules={[
              { required: true },
              {
                pattern: /^[a-z0-9][a-z0-9-]{1,62}$/,
                message: 'Lowercase, 2-63 chars, [a-z0-9-], cannot start with a hyphen',
              },
            ]}
          >
            <Input placeholder="acme-lobbying" />
          </Form.Item>
          <Form.Item name="name" label="Display name" rules={[{ required: true, min: 2 }]}>
            <Input placeholder="Acme Lobbying Group" />
          </Form.Item>
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="adminFirstName" label="Admin first name" style={{ flex: 1 }}>
              <Input placeholder="Jane" />
            </Form.Item>
            <Form.Item name="adminLastName" label="Admin last name" style={{ flex: 1 }}>
              <Input placeholder="Doe" />
            </Form.Item>
          </Space>
          <Form.Item
            name="adminEmail"
            label="Admin email"
            extra="An onboarding invitation email is sent to this address."
            rules={[{ required: true, type: 'email' }]}
          >
            <Input placeholder="admin@acme.com" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Reason for impersonation */}
      <Modal
        title={impOpen ? `Impersonate ${impOpen.slug}` : ''}
        open={!!impOpen}
        onCancel={() => setImpOpen(null)}
        onOk={() => reasonForm.submit()}
        confirmLoading={impersonate.isPending}
        okText="Start impersonation"
      >
        <Typography.Paragraph type="secondary">
          The reason is recorded in the audit log alongside your user id. Any data access during
          this session is attributed to you, not the tenant's admin.
        </Typography.Paragraph>
        <Form
          form={reasonForm}
          layout="vertical"
          onFinish={(v) =>
            impOpen &&
            impersonate.mutate({ tenantId: impOpen.id, tenantSlug: impOpen.slug, reason: v.reason })
          }
        >
          <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 10, max: 500 }]}>
            <Input.TextArea rows={3} placeholder="Investigating ticket #1234, invitation flow" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Second-step delete confirmation — type DELETE to arm the real deletion */}
      <Modal
        title="Permanently delete tenant"
        open={!!deleteTarget}
        onCancel={() => {
          setDeleteTarget(null);
          deleteForm.resetFields();
        }}
        onOk={() => deleteForm.submit()}
        okText="Delete tenant"
        okButtonProps={{
          danger: true,
          loading: deleteTenant.isPending,
          disabled: deleteConfirm !== 'DELETE',
        }}
        cancelButtonProps={{ disabled: deleteTenant.isPending }}
        maskClosable={false}
        keyboard={!deleteTenant.isPending}
      >
        <Typography.Paragraph style={{ marginBottom: 4 }}>
          You are about to permanently delete:
        </Typography.Paragraph>
        <Typography.Paragraph style={{ textAlign: 'center', margin: '12px 0 16px' }}>
          <Typography.Text strong style={{ fontSize: 26, lineHeight: 1.25 }}>
            {deleteTarget?.name}
          </Typography.Text>
          <br />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {deleteTarget?.slug}
          </Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph type="danger" style={{ marginBottom: 16 }}>
          This erases its Clerk org, all members, clients, meetings and data. This cannot be undone.
        </Typography.Paragraph>
        <Form
          form={deleteForm}
          layout="vertical"
          onFinish={() => {
            if (deleteTarget) deleteTenant.mutate(deleteTarget.id);
          }}
        >
          <Form.Item
            name="confirm"
            label={
              <span>
                Type <Typography.Text strong>DELETE</Typography.Text> to confirm
              </span>
            }
            rules={[
              {
                validator: (_rule, value) =>
                  value === 'DELETE'
                    ? Promise.resolve()
                    : Promise.reject(new Error('Type DELETE (all caps) to confirm')),
              },
            ]}
          >
            <Input autoFocus autoComplete="off" placeholder="DELETE" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// ── Tab 2: Personnel merge queue (Step 36) ──────────────────────────────────

interface MergePersonDetail {
  id: string;
  fullName: string;
  organization: string | null;
  title: string | null;
  role: string | null;
  service: string | null;
  status: string;
  confidence: number;
  sources: Array<{ source: string; sourceUrl: string | null; observedAt: string }>;
}

interface MergeCandidate {
  id: string;
  primaryPersonId: string;
  secondaryPersonId: string;
  similarityScore: number;
  status: string;
  createdAt: string;
  primaryPerson: MergePersonDetail | null;
  secondaryPerson: MergePersonDetail | null;
}

interface MergeQueueResponse {
  data: MergeCandidate[];
  total: number;
  page: number;
  limit: number;
}

type MergeDecision = 'merge' | 'keep_separate' | 'reject_a' | 'reject_b';

function PersonRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 4 }}>
      <Typography.Text type="secondary" style={{ minWidth: 96 }}>
        {label}
      </Typography.Text>
      <span>{value ?? <Typography.Text type="secondary">—</Typography.Text>}</span>
    </div>
  );
}

function PersonCard({ person, side }: { person: MergePersonDetail | null; side: string }) {
  if (!person) {
    return (
      <Card size="small" title={`${side} (missing)`}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Person record not found" />
      </Card>
    );
  }
  return (
    <Card size="small" title={`${side} · ${person.fullName}`}>
      <PersonRow label="Organization" value={person.organization} />
      <PersonRow label="Title" value={person.title} />
      <PersonRow label="Role" value={person.role} />
      <PersonRow label="Service" value={person.service} />
      <PersonRow
        label="Status"
        value={<Tag color={person.status === 'active' ? 'green' : 'default'}>{person.status}</Tag>}
      />
      <PersonRow label="Confidence" value={`${Math.round(person.confidence * 100)}%`} />
      <PersonRow
        label="Sources"
        value={
          person.sources.length === 0 ? (
            '—'
          ) : (
            <Space size={4} wrap>
              {person.sources.map((s, i) => (
                <Tag key={`${s.source}-${i}`}>{s.source}</Tag>
              ))}
            </Space>
          )
        }
      />
    </Card>
  );
}

// Exported (additive — behavior unchanged) so the Analyst Console can mount this
// merge-candidates queue as a tab without duplicating its logic.
export function PersonnelMergeTab() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [pending, setPending] = useState<{ id: string; decision: MergeDecision } | null>(null);

  const queue = useQuery<MergeQueueResponse>({
    queryKey: ['capiro-admin', 'personnel-merge-queue', 'open'],
    queryFn: async () =>
      (
        await api.get<MergeQueueResponse>('/api/admin/acquisition-personnel/merge-queue', {
          params: { status: 'open' },
        })
      ).data,
  });

  const resolve = useMutation({
    mutationFn: async (input: { id: string; decision: MergeDecision }) =>
      (
        await api.post(`/api/admin/acquisition-personnel/merge-queue/${input.id}/resolve`, {
          decision: input.decision,
        })
      ).data,
    onMutate: (input) => setPending(input),
    onSuccess: (_data, input) => {
      const label =
        input.decision === 'merge'
          ? 'Merged'
          : input.decision === 'keep_separate'
            ? 'Kept separate'
            : 'Rejected';
      message.success(`${label}`);
      void qc.invalidateQueries({ queryKey: ['capiro-admin', 'personnel-merge-queue'] });
    },
    onError: (err) => message.error((err as Error).message),
    onSettled: () => setPending(null),
  });

  const candidates = queue.data?.data ?? [];
  const isPending = (id: string, decision: MergeDecision) =>
    resolve.isPending && pending?.id === id && pending?.decision === decision;
  const anyPendingFor = (id: string) => resolve.isPending && pending?.id === id;

  return (
    <>
      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Personnel Merge Queue
        </Typography.Title>
        <Button size="small" onClick={() => queue.refetch()} loading={queue.isFetching}>
          Refresh
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">
        Near-duplicate acquisition personnel flagged by the writer (name match with a differing
        organization, or 0.70–0.92 trigram similarity). Review each side-by-side and decide: merge
        into one record, keep them separate, or mark one as the wrong record.
      </Typography.Paragraph>

      {queue.isLoading ? (
        <Card loading />
      ) : candidates.length === 0 ? (
        <Empty description="No open merge candidates." />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {candidates.map((c) => (
            <Card
              key={c.id}
              size="small"
              title={
                <Space>
                  <span>Similarity</span>
                  <Tag color={c.similarityScore >= 0.85 ? 'volcano' : 'gold'}>
                    {(c.similarityScore * 100).toFixed(0)}%
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>
                    queued {new Date(c.createdAt).toLocaleString()}
                  </Typography.Text>
                </Space>
              }
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <PersonCard person={c.primaryPerson} side="Record A (primary)" />
                <PersonCard person={c.secondaryPerson} side="Record B (secondary)" />
              </div>
              <Space wrap>
                <Popconfirm
                  title="Merge these into one record?"
                  description="Record B will be consolidated into Record A and deleted."
                  okText="Merge"
                  onConfirm={() => resolve.mutate({ id: c.id, decision: 'merge' })}
                >
                  <Button type="primary" loading={isPending(c.id, 'merge')} disabled={anyPendingFor(c.id)}>
                    Merge
                  </Button>
                </Popconfirm>
                <Button
                  loading={isPending(c.id, 'keep_separate')}
                  disabled={anyPendingFor(c.id)}
                  onClick={() => resolve.mutate({ id: c.id, decision: 'keep_separate' })}
                >
                  Keep separate
                </Button>
                <Button
                  danger
                  loading={isPending(c.id, 'reject_a')}
                  disabled={anyPendingFor(c.id)}
                  onClick={() => resolve.mutate({ id: c.id, decision: 'reject_a' })}
                >
                  Mark A wrong
                </Button>
                <Button
                  danger
                  loading={isPending(c.id, 'reject_b')}
                  disabled={anyPendingFor(c.id)}
                  onClick={() => resolve.mutate({ id: c.id, decision: 'reject_b' })}
                >
                  Mark B wrong
                </Button>
              </Space>
            </Card>
          ))}
        </Space>
      )}
    </>
  );
}
