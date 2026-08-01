import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FormInstance } from 'antd';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  EditOutlined,
  HistoryOutlined,
  RedoOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';
import { MemoryProposalQueue } from './MemoryProposalQueue.js';
import { MemoryReviewQueue } from './MemoryReviewQueue.js';
import './MemoryGovernanceCenter.css';

const { Paragraph, Text, Title } = Typography;

export type GovernanceTabKey =
  | 'overview'
  | 'active'
  | 'pending'
  | 'conflicts'
  | 'review_due'
  | 'history'
  | 'grants'
  | 'transitions'
  | 'projection';

export type GovernanceItemAction =
  | 'confirm'
  | 'mark_stale'
  | 'revoke'
  | 'second_approve'
  | 'correction'
  | 'restore'
  | 'resolve_conflict';

interface GovernanceOverview {
  enabled: boolean;
  reviewEnabled?: boolean;
  counts: {
    active: number;
    pendingReview: number;
    conflicts: number;
    reviewDue: number;
    history: number;
    activeGrants: number;
    projectionAttention: number;
  };
}

interface GovernanceCapabilities {
  confirm: boolean;
  markStale: boolean;
  revoke: boolean;
  proposeCorrection: boolean;
  restore: boolean;
  resolveConflict: boolean;
  secondApprove: boolean;
}

export interface GovernanceItem {
  id: string;
  title: string;
  type: string;
  clientId: string | null;
  clientName: string | null;
  ownerUserId: string | null;
  visibility: string;
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: string;
  governedStatus: string;
  legacyStatus: string;
  reviewState: string;
  confidence: number | null;
  lastConfirmedAt: string | null;
  reviewDueAt: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  legalHold: boolean;
  conflictStatus: string;
  conflictGroupId: string | null;
  controllingItemId: string | null;
  assertedByUserId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: string | null;
  sourceType: string;
  sourceId: string | null;
  originSurface: string | null;
  updatedAt: string;
  capabilities: GovernanceCapabilities;
}

interface GovernanceConflictMember {
  id: string;
  title: string;
  governedStatus: string;
  conflictStatus: string;
  controllingItemId: string | null;
  updatedAt: string;
}

interface GovernanceDetailResponse {
  enabled: boolean;
  item:
    | (GovernanceItem & {
        slug: string;
        sections: Array<{ key?: string; heading?: string; owner?: string; body?: string }>;
        provenance: Record<string, unknown>;
        temporal: Record<string, unknown>;
        approvals: Record<string, unknown>;
        governance: Record<string, unknown>;
        origin: Record<string, unknown>;
        actors: Record<string, { name: string; email: string }>;
        versions: Array<Record<string, unknown> & { id: string; createdAt: string }>;
        transitions: Array<Record<string, unknown> & { id: string; occurredAt: string }>;
        projection: Array<Record<string, unknown> & { id: string; createdAt: string }>;
        conflictMembers: GovernanceConflictMember[];
        createdAt: string;
      })
    | null;
}

interface GovernanceTransition {
  id: string;
  memoryItemId: string | null;
  memoryCandidateId: string | null;
  actorUserId: string | null;
  clientId: string | null;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string;
  reason: string;
  occurredAt: string;
}

interface ProjectionFailure {
  id: string;
  memoryItemId: string | null;
  title: string | null;
  operation: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface ProjectionHealth {
  enabled: boolean;
  counts: {
    pending: number;
    running: number;
    failed: number;
    completed: number;
    deadLetter: number;
    superseded: number;
  };
  oldestDueAt: string | null;
  recentFailures: ProjectionFailure[];
}

interface GovernanceClient {
  id: string;
  name: string;
  status: string;
  memoryWall: boolean;
}

interface MemoryGrant {
  id: string;
  clientId: string | null;
  userId: string;
  permissions: string[];
  status: string;
  grantedByUserId: string | null;
  reason: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActionState {
  kind: GovernanceItemAction;
  item: GovernanceItem;
}

interface ActionValues {
  reason?: string;
  content?: string;
  controllingItemId?: string;
}

interface GrantFormValues {
  userId: string;
  permissions: string[];
  reason: string;
  expiresAt: string;
}

export function governanceBucketForTab(
  tab: GovernanceTabKey,
): 'active' | 'review_due' | 'conflicts' | 'history' | null {
  if (tab === 'active') return 'active';
  if (tab === 'review_due') return 'review_due';
  if (tab === 'conflicts') return 'conflicts';
  if (tab === 'history') return 'history';
  return null;
}

export function governanceStatusLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    active: 'Active',
    stale: 'Review due',
    conflicted: 'Conflicted',
    superseded: 'Superseded',
    revoked: 'Revoked',
    rejected: 'Rejected',
    expired: 'Expired',
    pending_review: 'Pending review',
    suggested: 'Suggested',
    completed: 'Completed',
    failed: 'Failed',
    dead_letter: 'Dead letter',
    running: 'Running',
    pending: 'Pending',
  };
  return labels[String(value ?? '')] ?? 'Unknown';
}

export function governanceAuthorityLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    firm_approved: 'Firm approved',
    client_approved: 'Client approved',
    external_authoritative: 'External authoritative',
    user_asserted: 'User asserted',
    analyst_verified: 'Analyst verified',
    working_draft: 'Working draft',
    model_inferred: 'Model inferred',
    legacy_unclassified: 'Unclassified',
  };
  return labels[String(value ?? '')] ?? 'Unknown';
}

export function isGovernanceActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

export function buildGovernanceActionRequest(
  action: GovernanceItemAction,
  itemId: string,
  values: ActionValues = {},
): { method: 'post'; path: string; body: Record<string, unknown> } {
  if (action === 'confirm') {
    return { method: 'post', path: `/api/memory/governance/items/${itemId}/confirm`, body: {} };
  }
  if (action === 'mark_stale') {
    return {
      method: 'post',
      path: `/api/memory/governance/items/${itemId}/mark-stale`,
      body: { reason: values.reason?.trim() ?? '' },
    };
  }
  if (action === 'revoke') {
    return {
      method: 'post',
      path: `/api/memory/governance/items/${itemId}/revoke`,
      body: { reason: values.reason?.trim() ?? '' },
    };
  }
  if (action === 'second_approve') {
    return {
      method: 'post',
      path: `/api/memory/governance/items/${itemId}/second-approve`,
      body: {},
    };
  }
  if (action === 'correction') {
    return {
      method: 'post',
      path: `/api/memory/items/${itemId}/corrections`,
      body: { content: values.content?.trim() ?? '' },
    };
  }
  if (action === 'restore') {
    return { method: 'post', path: `/api/memory/items/${itemId}/restores`, body: {} };
  }
  return {
    method: 'post',
    path: `/api/memory/items/${itemId}/conflicts/resolve`,
    body: {
      controllingItemId: values.controllingItemId ?? '',
      reason: values.reason?.trim() ?? '',
    },
  };
}

export function shouldRenderMemoryGovernanceCenter(
  isAdmin: boolean,
  overview: GovernanceOverview | undefined,
): boolean {
  return isAdmin && overview?.enabled === true;
}

/** Administrator-only governed-memory administration surface. */
export function MemoryGovernanceCenter({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [tab, setTab] = useState<GovernanceTabKey>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [actionForm] = Form.useForm<ActionValues>();

  const overview = useQuery<GovernanceOverview>({
    queryKey: ['memory-governance-overview'],
    queryFn: async () => (await api.get<GovernanceOverview>('/api/memory/governance')).data,
    enabled: isAdmin,
    retry: 1,
    staleTime: 10_000,
  });

  const bucket = governanceBucketForTab(tab);
  const items = useQuery<{ enabled: boolean; items: GovernanceItem[] }>({
    queryKey: ['memory-governance-items', bucket],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; items: GovernanceItem[] }>(
          `/api/memory/governance/items?bucket=${bucket}&limit=250`,
        )
      ).data,
    enabled: shouldRenderMemoryGovernanceCenter(isAdmin, overview.data) && bucket !== null,
    staleTime: 10_000,
  });

  const detail = useQuery<GovernanceDetailResponse>({
    queryKey: ['memory-governance-item', selectedId],
    queryFn: async () =>
      (await api.get<GovernanceDetailResponse>(`/api/memory/governance/items/${selectedId}`)).data,
    enabled: Boolean(selectedId),
  });

  const transitions = useQuery<{ enabled: boolean; transitions: GovernanceTransition[] }>({
    queryKey: ['memory-governance-transitions'],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; transitions: GovernanceTransition[] }>(
          '/api/memory/governance/transitions?limit=250',
        )
      ).data,
    enabled: tab === 'transitions' && overview.data?.enabled === true,
  });

  const projection = useQuery<ProjectionHealth>({
    queryKey: ['memory-governance-projection'],
    queryFn: async () =>
      (await api.get<ProjectionHealth>('/api/memory/governance/projection-health')).data,
    enabled: tab === 'projection' && overview.data?.enabled === true,
  });

  const actionMutation = useMutation({
    mutationFn: async (input: { state: ActionState; values?: ActionValues }) => {
      const request = buildGovernanceActionRequest(
        input.state.kind,
        input.state.item.id,
        input.values,
      );
      return (await api.post<Record<string, unknown>>(request.path, request.body)).data;
    },
    onSuccess: (result, input) => {
      message.success(actionOutcomeMessage(input.state.kind, result));
      setAction(null);
      actionForm.resetFields();
      invalidateGovernance(qc, input.state.item.id);
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });

  const retryProjection = useMutation({
    mutationFn: async (jobId: string) =>
      (
        await api.post<Record<string, unknown>>(
          `/api/memory/governance/projection-jobs/${jobId}/retry`,
          {},
        )
      ).data,
    onSuccess: (result) => {
      message.success(
        result.outcome === 'already_retryable'
          ? 'Projection job is already queued or running'
          : 'Projection retry queued',
      );
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-projection'] });
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });

  const openAction = (kind: GovernanceItemAction, item: GovernanceItem) => {
    if (kind === 'confirm' || kind === 'second_approve' || kind === 'restore') {
      actionMutation.mutate({ state: { kind, item } });
      return;
    }
    actionForm.resetFields();
    setAction({ kind, item });
  };

  if (!isAdmin) return null;
  if (overview.isLoading) return <Card loading aria-label="Loading Memory Governance Center" />;
  if (overview.isError) {
    return <Alert type="error" showIcon message="Memory Governance Center could not be loaded" />;
  }
  if (!overview.data?.enabled) return null;

  const tabItems = governanceTabs(overview.data).map((item) => ({
    ...item,
    children:
      item.key === 'overview' ? (
        <GovernanceOverviewPanel overview={overview.data} />
      ) : item.key === 'pending' ? (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <MemoryReviewQueue />
          <MemoryProposalQueue />
        </Space>
      ) : item.key === 'grants' ? (
        <MemoryGrantManager />
      ) : item.key === 'transitions' ? (
        <TransitionPanel
          data={transitions.data?.transitions ?? []}
          loading={transitions.isLoading}
        />
      ) : item.key === 'projection' ? (
        <ProjectionPanel
          data={projection.data}
          loading={projection.isLoading}
          retryingId={retryProjection.variables ?? null}
          onRetry={(id) => retryProjection.mutate(id)}
        />
      ) : (
        <MemoryItemTable
          items={items.data?.items ?? []}
          loading={items.isLoading}
          onOpen={setSelectedId}
        />
      ),
  }));

  return (
    <Card className="memory-governance-center" aria-label="Memory Governance Center">
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>
            Memory Governance Center
          </Title>
          <Text type="secondary">
            Review institutional truth, permissions, conflicts, history, and projection health.
            Every action is re-authorized by the server.
          </Text>
        </div>
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as GovernanceTabKey)}
          items={tabItems}
        />
      </Space>

      <MemoryDetailDrawer
        data={detail.data?.item ?? null}
        loading={detail.isLoading}
        onClose={() => setSelectedId(null)}
        onAction={openAction}
      />

      <GovernanceActionModal
        state={action}
        form={actionForm}
        pending={actionMutation.isPending}
        onCancel={() => {
          setAction(null);
          actionForm.resetFields();
        }}
        onSubmit={async () => {
          if (!action) return;
          const values = await actionForm.validateFields();
          actionMutation.mutate({ state: action, values });
        }}
        conflictMembers={detail.data?.item?.conflictMembers ?? []}
      />
    </Card>
  );
}

function GovernanceOverviewPanel({ overview }: { overview: GovernanceOverview }) {
  const stats = [
    ['Active', overview.counts.active],
    ['Pending review', overview.counts.pendingReview],
    ['Conflicts', overview.counts.conflicts],
    ['Review due', overview.counts.reviewDue],
    ['History', overview.counts.history],
    ['Active grants', overview.counts.activeGrants],
    ['Projection attention', overview.counts.projectionAttention],
  ] as const;
  return (
    <Space wrap size="middle">
      {stats.map(([title, value]) => (
        <Card key={title} size="small" style={{ minWidth: 150 }}>
          <Statistic title={title} value={value} />
        </Card>
      ))}
    </Space>
  );
}

function MemoryItemTable({
  items,
  loading,
  onOpen,
}: {
  items: GovernanceItem[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const activate = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (!isGovernanceActivationKey(event.key)) return;
    event.preventDefault();
    onOpen(id);
  };
  return (
    <Table<GovernanceItem>
      rowKey="id"
      loading={loading}
      dataSource={items}
      scroll={{ x: 900 }}
      locale={{ emptyText: <Empty description="No memory in this category" /> }}
      pagination={{ pageSize: 25, showSizeChanger: true }}
      onRow={(record) => ({
        onClick: () => onOpen(record.id),
        onKeyDown: (event) => activate(event, record.id),
        tabIndex: 0,
        role: 'button',
        'aria-label': `Open memory ${record.title}`,
        className: 'memory-governance-center__row',
      })}
      columns={[
        {
          title: 'Memory',
          key: 'memory',
          render: (_, item) => (
            <Space direction="vertical" size={0}>
              <Text strong>{item.title}</Text>
              <Text type="secondary">{item.clientName ?? item.memoryScope}</Text>
            </Space>
          ),
        },
        {
          title: 'Class / authority',
          key: 'class',
          render: (_, item) => (
            <Space direction="vertical" size={0}>
              <Text>{humanize(item.memoryClass)}</Text>
              <Text type="secondary">{governanceAuthorityLabel(item.memoryAuthority)}</Text>
            </Space>
          ),
        },
        {
          title: 'State',
          dataIndex: 'governedStatus',
          render: (status: string) => <Tag>{governanceStatusLabel(status)}</Tag>,
        },
        {
          title: 'Review due',
          dataIndex: 'reviewDueAt',
          render: (value: string | null) => dateText(value),
        },
        {
          title: 'Updated',
          dataIndex: 'updatedAt',
          render: (value: string) => dateText(value),
        },
      ]}
    />
  );
}

function MemoryDetailDrawer({
  data,
  loading,
  onClose,
  onAction,
}: {
  data: GovernanceDetailResponse['item'];
  loading: boolean;
  onClose: () => void;
  onAction: (kind: GovernanceItemAction, item: GovernanceItem) => void;
}) {
  return (
    <Drawer
      title={data?.title ?? 'Memory detail'}
      width="min(720px, 100vw)"
      open={Boolean(data) || loading}
      onClose={onClose}
    >
      {loading && <Card loading />}
      {!loading && data && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Space wrap>{renderActions(data, onAction)}</Space>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 1, md: 2 }}>
            <Descriptions.Item label="Scope">
              {data.clientName ?? humanize(data.memoryScope)}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              {governanceStatusLabel(data.governedStatus)}
            </Descriptions.Item>
            <Descriptions.Item label="Class">{humanize(data.memoryClass)}</Descriptions.Item>
            <Descriptions.Item label="Authority">
              {governanceAuthorityLabel(data.memoryAuthority)}
            </Descriptions.Item>
            <Descriptions.Item label="Confidence">
              {data.confidence ?? 'Unscored'}
            </Descriptions.Item>
            <Descriptions.Item label="Legal hold">
              {data.legalHold ? 'Yes' : 'No'}
            </Descriptions.Item>
            <Descriptions.Item label="Conflict">{humanize(data.conflictStatus)}</Descriptions.Item>
            <Descriptions.Item label="Review state">{humanize(data.reviewState)}</Descriptions.Item>
          </Descriptions>

          <DetailBlock title="Content">
            {data.sections.length === 0 ? (
              <Empty description="No rendered sections" />
            ) : (
              data.sections.map((section, index) => (
                <div key={section.key ?? index}>
                  <Text strong>{section.heading ?? `Section ${index + 1}`}</Text>
                  <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{section.body || '—'}</Paragraph>
                </div>
              ))
            )}
          </DetailBlock>
          <ObjectDescriptions title="Provenance" value={data.provenance} />
          <ObjectDescriptions
            title="Approvals"
            value={withActorNames(data.approvals, data.actors)}
          />
          <ObjectDescriptions title="Temporal validity" value={data.temporal} />
          <ObjectDescriptions
            title="Governance"
            value={withActorNames(data.governance, data.actors)}
          />
          <ObjectDescriptions title="Origin trace" value={data.origin} />

          <DetailBlock title="Versions">
            <List
              dataSource={data.versions}
              locale={{ emptyText: 'No version lineage' }}
              renderItem={(version) => (
                <List.Item>
                  <Space direction="vertical" size={0}>
                    <Text strong>{String(version.title ?? version.id)}</Text>
                    <Text type="secondary">
                      {governanceStatusLabel(String(version.governedStatus ?? ''))} ·{' '}
                      {dateText(String(version.createdAt))}
                    </Text>
                  </Space>
                </List.Item>
              )}
            />
          </DetailBlock>

          <DetailBlock title="Conflict control">
            <List
              dataSource={data.conflictMembers}
              locale={{ emptyText: 'No conflict group' }}
              renderItem={(member) => (
                <List.Item>
                  <Space wrap>
                    <Text>{member.title}</Text>
                    <Tag>{humanize(member.conflictStatus)}</Tag>
                    {member.controllingItemId === member.id && <Tag color="green">Controlling</Tag>}
                  </Space>
                </List.Item>
              )}
            />
          </DetailBlock>

          <DetailBlock title="Transition history">
            <List
              dataSource={data.transitions}
              locale={{ emptyText: 'No transition evidence' }}
              renderItem={(transition) => (
                <List.Item>
                  <Space direction="vertical" size={0}>
                    <Text strong>{humanize(String(transition.reasonCode ?? 'transition'))}</Text>
                    <Text>{String(transition.reason ?? '')}</Text>
                    <Text type="secondary">{dateText(String(transition.occurredAt))}</Text>
                  </Space>
                </List.Item>
              )}
            />
          </DetailBlock>

          <DetailBlock title="Projection state">
            <List
              dataSource={data.projection}
              locale={{ emptyText: 'No projection obligations' }}
              renderItem={(job) => (
                <List.Item>
                  <Space wrap>
                    <Tag>{governanceStatusLabel(String(job.status ?? ''))}</Tag>
                    <Text>{humanize(String(job.operation ?? 'projection'))}</Text>
                    {typeof job.lastError === 'string' && job.lastError ? (
                      <Text type="danger">{job.lastError}</Text>
                    ) : null}
                  </Space>
                </List.Item>
              )}
            />
          </DetailBlock>
        </Space>
      )}
    </Drawer>
  );
}

function renderActions(
  item: GovernanceItem,
  onAction: (kind: GovernanceItemAction, item: GovernanceItem) => void,
) {
  const actions: Array<[boolean, GovernanceItemAction, string, ReactNode, boolean?]> = [
    [item.capabilities.confirm, 'confirm', 'Confirm', <CheckOutlined />],
    [item.capabilities.markStale, 'mark_stale', 'Mark stale', <HistoryOutlined />],
    [
      item.capabilities.secondApprove,
      'second_approve',
      'Second approve',
      <SafetyCertificateOutlined />,
    ],
    [item.capabilities.proposeCorrection, 'correction', 'Suggest correction', <EditOutlined />],
    [item.capabilities.restore, 'restore', 'Restore as new version', <SyncOutlined />],
    [
      item.capabilities.resolveConflict,
      'resolve_conflict',
      'Resolve conflict',
      <SafetyCertificateOutlined />,
    ],
    [item.capabilities.revoke, 'revoke', 'Revoke', <StopOutlined />, true],
  ];
  return actions
    .filter(([visible]) => visible)
    .map(([, kind, label, icon, danger]) => (
      <Button key={kind} icon={icon} danger={danger} onClick={() => onAction(kind, item)}>
        {label}
      </Button>
    ));
}

function GovernanceActionModal({
  state,
  form,
  pending,
  onCancel,
  onSubmit,
  conflictMembers,
}: {
  state: ActionState | null;
  form: FormInstance<ActionValues>;
  pending: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  conflictMembers: GovernanceConflictMember[];
}) {
  const kind = state?.kind;
  return (
    <Modal
      open={Boolean(state)}
      title={kind ? actionTitle(kind) : 'Memory action'}
      confirmLoading={pending}
      okText={kind === 'revoke' ? 'Revoke memory' : 'Submit'}
      okButtonProps={{ danger: kind === 'revoke' }}
      onCancel={onCancel}
      onOk={onSubmit}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        {kind === 'correction' && (
          <Form.Item
            name="content"
            label="Corrected memory"
            rules={[
              { required: true, whitespace: true, message: 'Corrected content is required.' },
            ]}
          >
            <Input.TextArea rows={8} maxLength={20_000} showCount />
          </Form.Item>
        )}
        {kind === 'resolve_conflict' && (
          <Form.Item
            name="controllingItemId"
            label="Controlling memory"
            rules={[{ required: true, message: 'Select the controlling memory.' }]}
          >
            <Select
              options={conflictMembers.map((member) => ({ value: member.id, label: member.title }))}
            />
          </Form.Item>
        )}
        {(kind === 'mark_stale' || kind === 'revoke' || kind === 'resolve_conflict') && (
          <Form.Item
            name="reason"
            label="Reason"
            rules={[{ required: true, whitespace: true, message: 'A reason is required.' }]}
          >
            <Input.TextArea rows={4} maxLength={500} showCount />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

function MemoryGrantManager() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [clientId, setClientId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<GrantFormValues>();

  const clients = useQuery<{ enabled: boolean; clients: GovernanceClient[] }>({
    queryKey: ['memory-governance-clients'],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; clients: GovernanceClient[] }>(
          '/api/memory/governance/clients',
        )
      ).data,
  });
  const permissions = useQuery<{ permissions: string[] }>({
    queryKey: ['memory-grant-permissions'],
    queryFn: async () =>
      (await api.get<{ permissions: string[] }>('/api/memory/grants/permissions')).data,
  });
  const grants = useQuery<{ grants: MemoryGrant[] }>({
    queryKey: ['memory-client-grants', clientId],
    queryFn: async () =>
      (await api.get<{ grants: MemoryGrant[] }>(`/api/memory/clients/${clientId}/grants`)).data,
    enabled: Boolean(clientId),
  });

  const createGrant = useMutation({
    mutationFn: async (values: GrantFormValues) => {
      if (!clientId) throw new Error('Select a client.');
      const expiresAt = new Date(values.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()))
        throw new Error('Expiration must be a valid date.');
      return (
        await api.post(`/api/memory/clients/${clientId}/grants`, {
          ...values,
          expiresAt: expiresAt.toISOString(),
        })
      ).data;
    },
    onSuccess: () => {
      message.success('Memory access grant created');
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['memory-client-grants', clientId] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });

  const revokeGrant = useMutation({
    mutationFn: async (userId: string) => {
      if (!clientId) throw new Error('Select a client.');
      return (await api.delete(`/api/memory/clients/${clientId}/grants/${userId}`)).data;
    },
    onSuccess: () => {
      message.success('Memory access grant revoked');
      qc.invalidateQueries({ queryKey: ['memory-client-grants', clientId] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          style={{ minWidth: 280, maxWidth: '100%' }}
          placeholder="Select a client"
          value={clientId}
          onChange={setClientId}
          options={(clients.data?.clients ?? []).map((client) => ({
            value: client.id,
            label: `${client.name}${client.memoryWall ? ' · Ethical wall' : ''}`,
          }))}
        />
        <Button type="primary" disabled={!clientId} onClick={() => setOpen(true)}>
          Add grant
        </Button>
      </Space>
      {!clientId ? (
        <Empty description="Select a client to manage grants" />
      ) : (
        <Table<MemoryGrant>
          rowKey="id"
          loading={grants.isLoading}
          dataSource={grants.data?.grants ?? []}
          scroll={{ x: 900 }}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: 'User ID', dataIndex: 'userId' },
            {
              title: 'Permissions',
              dataIndex: 'permissions',
              render: (values: string[]) => (
                <Space wrap>
                  {values.map((value) => (
                    <Tag key={value}>{humanize(value)}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: 'Status',
              dataIndex: 'status',
              render: (value: string) => <Tag>{humanize(value)}</Tag>,
            },
            {
              title: 'Expires',
              dataIndex: 'expiresAt',
              render: (value: string | null) => dateText(value),
            },
            { title: 'Reason', dataIndex: 'reason' },
            {
              title: 'Action',
              render: (_, grant) =>
                grant.status === 'active' ? (
                  <Button danger size="small" onClick={() => revokeGrant.mutate(grant.userId)}>
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      <Modal
        open={open}
        title="Grant client memory access"
        confirmLoading={createGrant.isPending}
        onCancel={() => setOpen(false)}
        onOk={async () => createGrant.mutate(await form.validateFields())}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="userId"
            label="Active tenant member user ID"
            rules={[{ required: true, whitespace: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="permissions" label="Permissions" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={(permissions.data?.permissions ?? []).map((value) => ({
                value,
                label: humanize(value),
              }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="Reason" rules={[{ required: true, whitespace: true }]}>
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="expiresAt" label="Expires at" rules={[{ required: true }]}>
            <Input type="datetime-local" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function TransitionPanel({ data, loading }: { data: GovernanceTransition[]; loading: boolean }) {
  return (
    <List
      loading={loading}
      dataSource={data}
      locale={{ emptyText: 'No transition evidence' }}
      renderItem={(transition) => (
        <List.Item>
          <Space direction="vertical" size={0}>
            <Text strong>{humanize(transition.reasonCode)}</Text>
            <Text>{transition.reason}</Text>
            <Text type="secondary">
              {transition.fromStatus ? `${governanceStatusLabel(transition.fromStatus)} → ` : ''}
              {governanceStatusLabel(transition.toStatus)} · {dateText(transition.occurredAt)}
            </Text>
          </Space>
        </List.Item>
      )}
    />
  );
}

function ProjectionPanel({
  data,
  loading,
  retryingId,
  onRetry,
}: {
  data: ProjectionHealth | undefined;
  loading: boolean;
  retryingId: string | null;
  onRetry: (id: string) => void;
}) {
  if (loading) return <Card loading />;
  if (!data) return <Empty description="Projection health unavailable" />;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space wrap>
        {Object.entries(data.counts).map(([key, value]) => (
          <Card key={key} size="small">
            <Statistic title={humanize(key)} value={value} />
          </Card>
        ))}
      </Space>
      {(data.counts.failed > 0 || data.counts.deadLetter > 0) && (
        <Alert
          type="error"
          showIcon
          message="Projection work needs attention"
          description="Canonical memory remains authoritative; failed secondary projections are retained for authorized retry or investigation."
        />
      )}
      <List
        dataSource={data.recentFailures}
        locale={{ emptyText: 'No recent projection failures' }}
        renderItem={(failure) => (
          <List.Item
            actions={[
              <Button
                key="retry"
                icon={<RedoOutlined />}
                loading={retryingId === failure.id}
                onClick={() => onRetry(failure.id)}
              >
                Retry
              </Button>,
            ]}
          >
            <Space direction="vertical" size={0}>
              <Text strong>{failure.title ?? failure.memoryItemId ?? failure.id}</Text>
              <Text>
                {humanize(failure.operation)} · {governanceStatusLabel(failure.status)}
              </Text>
              <Text type="danger">{failure.lastError ?? 'Unknown projection error'}</Text>
            </Space>
          </List.Item>
        )}
      />
    </Space>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <Title level={5}>{title}</Title>
      {children}
    </section>
  );
}

function ObjectDescriptions({ title, value }: { title: string; value: Record<string, unknown> }) {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== null && item !== undefined && item !== '',
  );
  return (
    <DetailBlock title={title}>
      {entries.length === 0 ? (
        <Text type="secondary">No recorded values</Text>
      ) : (
        <Descriptions bordered size="small" column={1}>
          {entries.map(([key, item]) => (
            <Descriptions.Item key={key} label={humanize(key)}>
              {typeof item === 'object' ? JSON.stringify(item) : dateOrText(item)}
            </Descriptions.Item>
          ))}
        </Descriptions>
      )}
    </DetailBlock>
  );
}

function governanceTabs(overview: GovernanceOverview) {
  return [
    { key: 'overview', label: 'Overview' },
    { key: 'active', label: `Active (${overview.counts.active})` },
    { key: 'pending', label: `Pending review (${overview.counts.pendingReview})` },
    { key: 'conflicts', label: `Conflicts (${overview.counts.conflicts})` },
    { key: 'review_due', label: `Review due (${overview.counts.reviewDue})` },
    { key: 'history', label: `History (${overview.counts.history})` },
    { key: 'grants', label: `Access grants (${overview.counts.activeGrants})` },
    { key: 'transitions', label: 'Transition history' },
    { key: 'projection', label: `Projection health (${overview.counts.projectionAttention})` },
  ] as Array<{ key: GovernanceTabKey; label: string }>;
}

function actionTitle(kind: GovernanceItemAction): string {
  const labels: Record<GovernanceItemAction, string> = {
    confirm: 'Confirm memory',
    mark_stale: 'Mark memory stale',
    revoke: 'Revoke memory',
    second_approve: 'Record second approval',
    correction: 'Suggest a correction',
    restore: 'Restore as a new version',
    resolve_conflict: 'Resolve memory conflict',
  };
  return labels[kind];
}

function actionOutcomeMessage(kind: GovernanceItemAction, result: Record<string, unknown>): string {
  const outcome = String(result.outcome ?? 'completed');
  if (outcome === 'pending_review') return 'Proposal submitted for independent review';
  if (outcome === 'duplicate') return 'Existing controlling memory was confirmed';
  if (outcome === 'already_stale') return 'Memory was already marked for review';
  if (outcome === 'already_second_approved') return 'Second approval was already recorded';
  return `${actionTitle(kind)} completed`;
}

function invalidateGovernance(qc: QueryClient, itemId: string): void {
  qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
  qc.invalidateQueries({ queryKey: ['memory-governance-items'] });
  qc.invalidateQueries({ queryKey: ['memory-governance-item', itemId] });
  qc.invalidateQueries({ queryKey: ['memory-governance-transitions'] });
  qc.invalidateQueries({ queryKey: ['memory-governance-projection'] });
  qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
  qc.invalidateQueries({ queryKey: ['memory-own-proposals'] });
  qc.invalidateQueries({ queryKey: ['memory-item'] });
}

function withActorNames(
  value: Record<string, unknown>,
  actors: Record<string, { name: string; email: string }>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!key.toLowerCase().endsWith('userid') || typeof item !== 'string') return [key, item];
      const actor = actors[item];
      return [key.replace(/UserId$/, ''), actor ? `${actor.name} · ${actor.email}` : item];
    }),
  );
}

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function dateText(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
}

function dateOrText(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  const date = new Date(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : value;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    if (typeof response?.data?.message === 'string') return response.data.message;
  }
  return error instanceof Error ? error.message : 'Memory governance action failed';
}
