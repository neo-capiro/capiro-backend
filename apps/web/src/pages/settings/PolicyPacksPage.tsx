import { useMemo, useState } from 'react';
import {
  AuditOutlined,
  EditOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ROLE_RANK, type TenantRole } from '@capiro/shared';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';

const { Paragraph, Text, Title } = Typography;

export type PolicyPackStatus =
  | 'draft'
  | 'pending_review'
  | 'reviewed'
  | 'published'
  | 'retired'
  | 'disabled_example';

export type PolicyOutcome = 'PASS' | 'WARN' | 'BLOCK';
export type PolicyJurisdiction =
  | 'all'
  | 'federal'
  | 'state'
  | 'local'
  | 'regulatory'
  | 'procurement'
  | 'grants';

export interface PolicyAuthority {
  type: 'approved_product_policy' | 'legal_authority' | 'client_policy' | 'example_only';
  title: string;
  sourceRef?: string;
  sourceVersion?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  outcome: PolicyOutcome;
  code?: string;
  tier?: 'low' | 'moderate' | 'high' | 'restricted';
  enabled: boolean;
  match: {
    tools?: string[];
    jurisdictions?: Exclude<PolicyJurisdiction, 'all'>[];
    actorRoles?: TenantRole[];
    channels?: Array<'internal' | 'email' | 'document' | 'filing' | 'automation' | 'crm'>;
    recipientTypes?: Array<'internal' | 'government' | 'client' | 'public' | 'unknown'>;
    clientIds?: string[];
    contextFlags?: Record<string, string | number | boolean>;
  };
  reason: string;
  authorityRef: string;
  tests: string[];
}

export interface PolicyPackRow {
  id: string;
  packKey: string;
  version: string;
  jurisdiction: PolicyJurisdiction;
  status: PolicyPackStatus;
  legalReviewStatus: 'not_required_product_policy' | 'pending' | 'approved' | 'rejected';
  authority: PolicyAuthority;
  effectiveFrom: string;
  effectiveUntil: string | null;
  ownerUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: string | null;
  publishedByUserId: string | null;
  publishedAt: string | null;
  fourEyesRequired: boolean;
  rules: PolicyRule[];
  fallback: PolicyOutcome;
  nonProduction: boolean;
  rulesHash: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface PolicyPackEvent {
  id: string;
  fromStatus: string | null;
  toStatus: string | null;
  action: string;
  actorUserId: string;
  actorRole: string;
  reason: string;
  occurredAt: string;
}

interface PolicyDecisionRow {
  id: string;
  packKey: string | null;
  packVersion: string | null;
  ruleId: string | null;
  outcome: PolicyOutcome;
  code: string | null;
  simulated: boolean;
  policySource: string;
  policyMode: string;
  tool: string;
  channel: string;
  jurisdiction: string;
  reason: string;
  decidedAt: string;
}

export interface PolicyRuleFormValue {
  id: string;
  description: string;
  outcome: PolicyOutcome;
  code?: string;
  tier?: 'low' | 'moderate' | 'high' | 'restricted';
  enabled?: boolean;
  tools?: string[];
  tests?: string[];
  authorityRef: string;
  reason: string;
  additionalMatchJson?: string;
}

export interface PolicyPackFormValues {
  packKey: string;
  version: string;
  jurisdiction: PolicyJurisdiction;
  legalReviewStatus: PolicyPackRow['legalReviewStatus'];
  authorityType: PolicyAuthority['type'];
  authorityTitle: string;
  authoritySourceRef?: string;
  authoritySourceVersion?: string;
  effectiveFrom: string;
  effectiveUntil?: string;
  fourEyesRequired?: boolean;
  fallback: PolicyOutcome;
  nonProduction?: boolean;
  rules: PolicyRuleFormValue[];
}

interface SimulationFormValues {
  tool: string;
  inputJson: string;
  jurisdiction?: Exclude<PolicyJurisdiction, 'all'>;
  clientId?: string;
}

interface ReasonState {
  action: 'submit-review' | 'review' | 'second-approve' | 'publish' | 'retire' | 'rollback';
  pack: PolicyPackRow;
  targetId?: string;
}

export interface PolicyPackActionState {
  canEdit: boolean;
  canSubmitReview: boolean;
  canReview: boolean;
  canSecondApprove: boolean;
  canPublish: boolean;
  canRetire: boolean;
  canRollback: boolean;
  canSimulate: boolean;
  reviewBlockedReason?: string;
  secondApprovalBlockedReason?: string;
}

export function policyPackActionState(
  pack: PolicyPackRow,
  currentUserId: string,
  retiredVersions: PolicyPackRow[] = [],
): PolicyPackActionState {
  const reviewBlockedReason =
    pack.ownerUserId === currentUserId
      ? 'The draft owner cannot review their own policy pack.'
      : pack.reviewedByUserId
        ? 'A first review is already recorded.'
        : undefined;
  const secondApprovalBlockedReason =
    pack.ownerUserId === currentUserId || pack.reviewedByUserId === currentUserId
      ? 'The second approver must be independent of the owner and first reviewer.'
      : undefined;
  return {
    canEdit: pack.status === 'draft',
    canSubmitReview: pack.status === 'draft',
    canReview:
      pack.status === 'pending_review' &&
      !pack.reviewedByUserId &&
      reviewBlockedReason === undefined,
    canSecondApprove:
      pack.status === 'pending_review' &&
      pack.fourEyesRequired &&
      Boolean(pack.reviewedByUserId) &&
      secondApprovalBlockedReason === undefined,
    canPublish: pack.status === 'reviewed' && !pack.nonProduction,
    canRetire: pack.status === 'published',
    canRollback:
      pack.status === 'published' &&
      retiredVersions.some(
        (candidate) => candidate.packKey === pack.packKey && !candidate.nonProduction,
      ),
    canSimulate: pack.status !== 'disabled_example',
    ...(reviewBlockedReason ? { reviewBlockedReason } : {}),
    ...(secondApprovalBlockedReason ? { secondApprovalBlockedReason } : {}),
  };
}

function parseObject(value: string | undefined, label: string): Record<string, unknown> {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function iso(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must be a valid date and time.`);
  return date.toISOString();
}

export function buildPolicyPackPayload(
  values: PolicyPackFormValues,
  revision = false,
): Record<string, unknown> {
  const effectiveFrom = iso(values.effectiveFrom, 'Effective from');
  if (!effectiveFrom) throw new Error('Effective from is required.');
  const effectiveUntil = iso(values.effectiveUntil, 'Effective until');
  const rules = (values.rules ?? []).map((rule, index): PolicyRule => {
    const extra = parseObject(rule.additionalMatchJson, `Rule ${index + 1} additional match`);
    const tools = (rule.tools ?? []).map((item) => item.trim()).filter(Boolean);
    const tests = (rule.tests ?? []).map((item) => item.trim()).filter(Boolean);
    if (!rule.id?.trim()) throw new Error(`Rule ${index + 1} needs an ID.`);
    if (!tests.length) throw new Error(`Rule ${rule.id} needs at least one regression test ID.`);
    return {
      id: rule.id.trim(),
      description: rule.description.trim(),
      outcome: rule.outcome,
      ...(rule.code?.trim() ? { code: rule.code.trim() } : {}),
      ...(rule.tier ? { tier: rule.tier } : {}),
      enabled: rule.enabled !== false,
      match: {
        ...extra,
        ...(tools.length ? { tools } : {}),
      },
      reason: rule.reason.trim(),
      authorityRef: rule.authorityRef.trim(),
      tests,
    };
  });
  const common = {
    jurisdiction: values.jurisdiction,
    legalReviewStatus: values.legalReviewStatus,
    authority: {
      type: values.authorityType,
      title: values.authorityTitle.trim(),
      ...(values.authoritySourceRef?.trim() ? { sourceRef: values.authoritySourceRef.trim() } : {}),
      ...(values.authoritySourceVersion?.trim()
        ? { sourceVersion: values.authoritySourceVersion.trim() }
        : {}),
    },
    effectiveFrom,
    ...(effectiveUntil ? { effectiveUntil } : { effectiveUntil: null }),
    fourEyesRequired: values.fourEyesRequired !== false,
    rules,
    fallback: values.fallback,
    nonProduction: values.nonProduction !== false,
  };
  return revision
    ? common
    : {
        packKey: values.packKey.trim(),
        version: values.version.trim(),
        ...common,
      };
}

export function buildSimulationPayload(values: SimulationFormValues): Record<string, unknown> {
  return {
    tool: values.tool.trim(),
    input: parseObject(values.inputJson, 'Simulation input'),
    ...(values.jurisdiction ? { jurisdiction: values.jurisdiction } : {}),
    ...(values.clientId?.trim() ? { clientId: values.clientId.trim() } : {}),
  };
}

function formValuesFor(pack: PolicyPackRow): PolicyPackFormValues {
  return {
    packKey: pack.packKey,
    version: pack.version,
    jurisdiction: pack.jurisdiction,
    legalReviewStatus: pack.legalReviewStatus,
    authorityType: pack.authority.type,
    authorityTitle: pack.authority.title,
    authoritySourceRef: pack.authority.sourceRef,
    authoritySourceVersion: pack.authority.sourceVersion,
    effectiveFrom: pack.effectiveFrom,
    effectiveUntil: pack.effectiveUntil ?? undefined,
    fourEyesRequired: pack.fourEyesRequired,
    fallback: pack.fallback,
    nonProduction: pack.nonProduction,
    rules: pack.rules.map((rule) => {
      const { tools, ...additionalMatch } = rule.match;
      return {
        id: rule.id,
        description: rule.description,
        outcome: rule.outcome,
        code: rule.code,
        tier: rule.tier,
        enabled: rule.enabled,
        tools: tools ?? [],
        tests: rule.tests,
        authorityRef: rule.authorityRef,
        reason: rule.reason,
        additionalMatchJson:
          Object.keys(additionalMatch).length > 0 ? JSON.stringify(additionalMatch, null, 2) : '',
      };
    }),
  };
}

function statusLabel(status: PolicyPackStatus): string {
  return {
    draft: 'Draft',
    pending_review: 'Pending review',
    reviewed: 'Reviewed',
    published: 'Published',
    retired: 'Retired',
    disabled_example: 'Disabled example',
  }[status];
}

function statusColor(status: PolicyPackStatus): string {
  return {
    draft: 'default',
    pending_review: 'gold',
    reviewed: 'blue',
    published: 'green',
    retired: 'default',
    disabled_example: 'red',
  }[status];
}

function outcomeColor(outcome: PolicyOutcome): string {
  return outcome === 'PASS' ? 'green' : outcome === 'WARN' ? 'gold' : 'red';
}

function errorMessage(error: unknown): string {
  const axiosError = error as {
    response?: { data?: { message?: string | string[] } };
    message?: string;
  };
  const message = axiosError.response?.data?.message;
  if (Array.isArray(message)) return message.join(' ');
  return message ?? axiosError.message ?? 'The policy-pack operation failed.';
}

export function PolicyPacksPage() {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [editorForm] = Form.useForm<PolicyPackFormValues>();
  const [reasonForm] = Form.useForm<{
    reason: string;
    legalReviewStatus?: 'not_required_product_policy' | 'approved';
    targetId?: string;
  }>();
  const [simulationForm] = Form.useForm<SimulationFormValues>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyPackRow | null>(null);
  const [reasonState, setReasonState] = useState<ReasonState | null>(null);
  const [simulationPack, setSimulationPack] = useState<PolicyPackRow | null>(null);
  const [simulationResult, setSimulationResult] = useState<Record<string, unknown> | null>(null);
  const [eventsPack, setEventsPack] = useState<PolicyPackRow | null>(null);
  const [activeSection, setActiveSection] = useState('packs');

  const isAdmin = Boolean(me.data && ROLE_RANK[me.data.role] >= ROLE_RANK.user_admin);
  const currentUserId = me.data?.user.id ?? '';

  const packs = useQuery<PolicyPackRow[]>({
    queryKey: ['meri-policy-packs'],
    queryFn: async () => (await api.get<PolicyPackRow[]>('/api/clio/policy-packs')).data,
    enabled: isAdmin,
    retry: false,
  });
  const decisions = useQuery<PolicyDecisionRow[]>({
    queryKey: ['meri-policy-decisions'],
    queryFn: async () =>
      (await api.get<PolicyDecisionRow[]>('/api/clio/policy-packs/decisions/recent')).data,
    enabled: isAdmin && activeSection === 'decisions',
    retry: false,
  });
  const events = useQuery<PolicyPackEvent[]>({
    queryKey: ['meri-policy-pack-events', eventsPack?.id],
    queryFn: async () =>
      (
        await api.get<PolicyPackEvent[]>(
          `/api/clio/policy-packs/${encodeURIComponent(eventsPack!.id)}/events`,
        )
      ).data,
    enabled: isAdmin && Boolean(eventsPack),
    retry: false,
  });

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['meri-policy-packs'] }),
      qc.invalidateQueries({ queryKey: ['meri-policy-decisions'] }),
    ]);
  };

  const operation = useMutation({
    mutationFn: async (request: {
      method: 'post' | 'patch';
      url: string;
      body?: Record<string, unknown>;
      success: string;
    }) => {
      const response =
        request.method === 'patch'
          ? await api.patch(request.url, request.body ?? {})
          : await api.post(request.url, request.body ?? {});
      return { data: response.data, success: request.success };
    },
    onSuccess: async ({ success }) => {
      message.success(success);
      setEditorOpen(false);
      setEditing(null);
      setReasonState(null);
      reasonForm.resetFields();
      await invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const simulate = useMutation({
    mutationFn: async (request: { packId: string; body: Record<string, unknown> }) =>
      (
        await api.post<Record<string, unknown>>(
          `/api/clio/policy-packs/${encodeURIComponent(request.packId)}/simulate`,
          request.body,
        )
      ).data,
    onSuccess: (result) => {
      setSimulationResult(result);
      message.success('Simulation completed. No approval binding was created.');
      void qc.invalidateQueries({ queryKey: ['meri-policy-decisions'] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const retired = useMemo(
    () => (packs.data ?? []).filter((pack) => pack.status === 'retired'),
    [packs.data],
  );

  const openCreate = () => {
    setEditing(null);
    editorForm.setFieldsValue({
      packKey: '',
      version: '',
      jurisdiction: 'all',
      legalReviewStatus: 'pending',
      authorityType: 'approved_product_policy',
      authorityTitle: '',
      effectiveFrom: new Date().toISOString(),
      fourEyesRequired: true,
      fallback: 'WARN',
      nonProduction: true,
      rules: [
        {
          id: '',
          description: '',
          outcome: 'WARN',
          enabled: true,
          tools: [],
          tests: [],
          authorityRef: '',
          reason: '',
          additionalMatchJson: '',
        },
      ],
    });
    setEditorOpen(true);
  };

  const openEdit = (pack: PolicyPackRow) => {
    setEditing(pack);
    editorForm.setFieldsValue(formValuesFor(pack));
    setEditorOpen(true);
  };

  const submitEditor = (values: PolicyPackFormValues) => {
    try {
      const body = buildPolicyPackPayload(values, Boolean(editing));
      operation.mutate({
        method: editing ? 'patch' : 'post',
        url: editing
          ? `/api/clio/policy-packs/${encodeURIComponent(editing.id)}`
          : '/api/clio/policy-packs',
        body,
        success: editing ? 'Policy-pack draft revised' : 'Policy-pack draft created',
      });
    } catch (error) {
      message.error(errorMessage(error));
    }
  };

  const submitReason = (values: {
    reason: string;
    legalReviewStatus?: 'not_required_product_policy' | 'approved';
    targetId?: string;
  }) => {
    if (!reasonState) return;
    const base = `/api/clio/policy-packs/${encodeURIComponent(reasonState.pack.id)}`;
    const body: Record<string, unknown> = { reason: values.reason.trim() };
    if (reasonState.action === 'review') {
      body.legalReviewStatus = values.legalReviewStatus ?? 'approved';
    }
    const targetId = values.targetId ?? reasonState.targetId;
    const url =
      reasonState.action === 'rollback'
        ? `${base}/rollback/${encodeURIComponent(targetId ?? '')}`
        : `${base}/${reasonState.action}`;
    const labels: Record<ReasonState['action'], string> = {
      'submit-review': 'Policy pack submitted for independent review',
      review: 'Independent review recorded',
      'second-approve': 'Second independent approval recorded',
      publish: 'Policy pack published',
      retire: 'Policy pack retired',
      rollback: 'Policy pack rolled back',
    };
    operation.mutate({ method: 'post', url, body, success: labels[reasonState.action] });
  };

  const columns: ColumnsType<PolicyPackRow> = [
    {
      title: 'Policy pack',
      key: 'pack',
      render: (_, pack) => (
        <Space direction="vertical" size={0}>
          <Text strong>{pack.packKey}</Text>
          <Text type="secondary">Version {pack.version}</Text>
        </Space>
      ),
    },
    {
      title: 'Scope',
      key: 'scope',
      render: (_, pack) => (
        <Space direction="vertical" size={0}>
          <Text>{pack.jurisdiction === 'all' ? 'All jurisdictions' : pack.jurisdiction}</Text>
          <Text type="secondary">
            {pack.rules.length} rule(s) · fallback {pack.fallback}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Lifecycle',
      key: 'status',
      render: (_, pack) => (
        <Space direction="vertical" size={2}>
          <Tag color={statusColor(pack.status)}>{statusLabel(pack.status)}</Tag>
          <Text type="secondary">Legal review: {pack.legalReviewStatus.replaceAll('_', ' ')}</Text>
          {pack.nonProduction && <Tag>Non-production</Tag>}
        </Space>
      ),
    },
    {
      title: 'Authority',
      key: 'authority',
      render: (_, pack) => (
        <Space direction="vertical" size={0}>
          <Text>{pack.authority.title}</Text>
          <Text type="secondary">{pack.authority.type.replaceAll('_', ' ')}</Text>
        </Space>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 390,
      render: (_, pack) => {
        const state = policyPackActionState(pack, currentUserId, retired);
        const retiredCandidates = retired.filter(
          (candidate) => candidate.packKey === pack.packKey && !candidate.nonProduction,
        );
        return (
          <Space wrap size={[4, 4]}>
            {state.canEdit && (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(pack)}>
                Edit
              </Button>
            )}
            {state.canSubmitReview && (
              <Button
                size="small"
                onClick={() => setReasonState({ action: 'submit-review', pack })}
              >
                Submit review
              </Button>
            )}
            {pack.status === 'pending_review' && !pack.reviewedByUserId && (
              <Tooltip title={state.reviewBlockedReason}>
                <span>
                  <Button
                    size="small"
                    disabled={!state.canReview}
                    onClick={() => setReasonState({ action: 'review', pack })}
                  >
                    Review
                  </Button>
                </span>
              </Tooltip>
            )}
            {pack.status === 'pending_review' && pack.fourEyesRequired && pack.reviewedByUserId && (
              <Tooltip title={state.secondApprovalBlockedReason}>
                <span>
                  <Button
                    size="small"
                    disabled={!state.canSecondApprove}
                    onClick={() => setReasonState({ action: 'second-approve', pack })}
                  >
                    Second approve
                  </Button>
                </span>
              </Tooltip>
            )}
            {state.canPublish && (
              <Button
                size="small"
                type="primary"
                icon={<SafetyCertificateOutlined />}
                onClick={() => setReasonState({ action: 'publish', pack })}
              >
                Publish
              </Button>
            )}
            {state.canRetire && (
              <Button
                size="small"
                danger
                onClick={() => setReasonState({ action: 'retire', pack })}
              >
                Retire
              </Button>
            )}
            {state.canRollback && (
              <Button
                size="small"
                icon={<RollbackOutlined />}
                onClick={() => {
                  reasonForm.setFieldValue('targetId', retiredCandidates[0]?.id);
                  setReasonState({ action: 'rollback', pack });
                }}
              >
                Roll back
              </Button>
            )}
            {state.canSimulate && (
              <Button
                size="small"
                icon={<ExperimentOutlined />}
                onClick={() => {
                  setSimulationPack(pack);
                  setSimulationResult(null);
                  simulationForm.setFieldsValue({
                    tool: 'send_email',
                    inputJson: '{\n  "to": "staff@example.gov"\n}',
                    jurisdiction: pack.jurisdiction === 'all' ? 'federal' : pack.jurisdiction,
                  });
                }}
              >
                Simulate
              </Button>
            )}
            <Button
              size="small"
              icon={<HistoryOutlined />}
              aria-label={`Lifecycle history for ${pack.packKey} ${pack.version}`}
              onClick={() => setEventsPack(pack)}
            />
          </Space>
        );
      },
    },
  ];

  if (me.isLoading) return <Card loading />;
  if (!isAdmin) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Policy-pack administration requires an administrator"
        description="The server also enforces this boundary. No policy data was requested."
      />
    );
  }

  return (
    <section className="settings-policy-packs" aria-labelledby="policy-packs-title">
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <Title id="policy-packs-title" level={4} style={{ marginBottom: 4 }}>
              Action policy packs
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0, maxWidth: 860 }}>
              Versioned, independently reviewed rules that decide whether Meri may perform an
              action, must request approval, or must block. Simulations are evidence-only and can
              never authorize an action. Publishing and rollback remain server-owned, audited
              transitions.
            </Paragraph>
          </div>
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={operation.isPending}
              onClick={() =>
                operation.mutate({
                  method: 'post',
                  url: '/api/clio/policy-packs/seed-baseline',
                  success: 'Reviewed baseline is available',
                })
              }
            >
              Install baseline
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New policy pack
            </Button>
          </Space>
        </div>

        <Alert
          type="info"
          showIcon
          icon={<AuditOutlined />}
          message="Activation is intentionally separate from authoring"
          description="Drafts and simulations do not affect live actions. A production pack must complete the configured independent review path before an administrator can publish it."
        />

        <Tabs
          activeKey={activeSection}
          onChange={setActiveSection}
          items={[
            {
              key: 'packs',
              label: 'Policy packs',
              children: (
                <Table<PolicyPackRow>
                  rowKey="id"
                  size="small"
                  columns={columns}
                  dataSource={packs.data ?? []}
                  loading={packs.isLoading}
                  pagination={false}
                  locale={{
                    emptyText: (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="No policy packs yet. Install the reviewed baseline or create a non-production draft."
                      />
                    ),
                  }}
                />
              ),
            },
            {
              key: 'decisions',
              label: 'Recent decisions',
              children: (
                <Table<PolicyDecisionRow>
                  rowKey="id"
                  size="small"
                  loading={decisions.isLoading}
                  dataSource={decisions.data ?? []}
                  pagination={{ pageSize: 25, hideOnSinglePage: true }}
                  columns={[
                    {
                      title: 'When',
                      dataIndex: 'decidedAt',
                      width: 180,
                      render: (value: string) => new Date(value).toLocaleString(),
                    },
                    {
                      title: 'Decision',
                      key: 'decision',
                      render: (_: unknown, row: PolicyDecisionRow) => (
                        <Space>
                          <Tag color={outcomeColor(row.outcome)}>{row.outcome}</Tag>
                          {row.simulated && <Tag>Simulation</Tag>}
                        </Space>
                      ),
                    },
                    {
                      title: 'Policy',
                      key: 'policy',
                      render: (_: unknown, row: PolicyDecisionRow) => (
                        <Space direction="vertical" size={0}>
                          <Text>{row.packKey ?? 'Fail-closed authority'}</Text>
                          <Text type="secondary">
                            {row.packVersion ?? 'unavailable'} · {row.ruleId ?? 'fallback'}
                          </Text>
                        </Space>
                      ),
                    },
                    { title: 'Tool', dataIndex: 'tool' },
                    {
                      title: 'Context',
                      key: 'context',
                      render: (_: unknown, row: PolicyDecisionRow) => (
                        <Text type="secondary">
                          {row.jurisdiction} · {row.channel} · {row.policySource}/{row.policyMode}
                        </Text>
                      ),
                    },
                    { title: 'Reason', dataIndex: 'reason' },
                  ]}
                />
              ),
            },
          ]}
        />
      </Space>

      <Modal
        title={editing ? `Revise ${editing.packKey} ${editing.version}` : 'New policy-pack draft'}
        open={editorOpen}
        width={900}
        okText={editing ? 'Save revision' : 'Create draft'}
        confirmLoading={operation.isPending}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onOk={() => editorForm.submit()}
        forceRender
      >
        <Form form={editorForm} layout="vertical" onFinish={submitEditor}>
          <Space wrap style={{ width: '100%' }} align="start">
            <Form.Item
              name="packKey"
              label="Pack key"
              rules={[{ required: true, message: 'Pack key is required' }]}
            >
              <Input disabled={Boolean(editing)} placeholder="firm-external-action-policy" />
            </Form.Item>
            <Form.Item
              name="version"
              label="Version"
              rules={[{ required: true, message: 'Version is required' }]}
            >
              <Input disabled={Boolean(editing)} placeholder="2026-08-01.v1" />
            </Form.Item>
            <Form.Item name="jurisdiction" label="Jurisdiction" rules={[{ required: true }]}>
              <Select
                style={{ width: 180 }}
                options={[
                  'all',
                  'federal',
                  'state',
                  'local',
                  'regulatory',
                  'procurement',
                  'grants',
                ].map((value) => ({ value, label: value === 'all' ? 'All' : value }))}
              />
            </Form.Item>
            <Form.Item name="fallback" label="Fallback" rules={[{ required: true }]}>
              <Select
                style={{ width: 120 }}
                options={['PASS', 'WARN', 'BLOCK'].map((value) => ({ value, label: value }))}
              />
            </Form.Item>
          </Space>

          <Space wrap style={{ width: '100%' }} align="start">
            <Form.Item
              name="effectiveFrom"
              label="Effective from"
              rules={[{ required: true, message: 'Effective date is required' }]}
            >
              <Input style={{ width: 260 }} placeholder="2026-08-01T00:00:00Z" />
            </Form.Item>
            <Form.Item name="effectiveUntil" label="Effective until (optional)">
              <Input style={{ width: 260 }} placeholder="2027-08-01T00:00:00Z" />
            </Form.Item>
            <Form.Item name="legalReviewStatus" label="Legal review status">
              <Select
                style={{ width: 220 }}
                options={[
                  { value: 'pending', label: 'Pending' },
                  { value: 'approved', label: 'Approved' },
                  {
                    value: 'not_required_product_policy',
                    label: 'Not required — product policy',
                  },
                  { value: 'rejected', label: 'Rejected' },
                ]}
              />
            </Form.Item>
          </Space>

          <Card size="small" title="Authority" style={{ marginBottom: 16 }}>
            <Space wrap align="start">
              <Form.Item name="authorityType" label="Authority type" rules={[{ required: true }]}>
                <Select
                  style={{ width: 230 }}
                  options={[
                    'approved_product_policy',
                    'legal_authority',
                    'client_policy',
                    'example_only',
                  ].map((value) => ({ value, label: value.replaceAll('_', ' ') }))}
                />
              </Form.Item>
              <Form.Item
                name="authorityTitle"
                label="Authority title"
                rules={[{ required: true, message: 'Authority title is required' }]}
              >
                <Input style={{ width: 300 }} />
              </Form.Item>
              <Form.Item name="authoritySourceRef" label="Source reference">
                <Input style={{ width: 300 }} placeholder="approved-policy:external-actions" />
              </Form.Item>
              <Form.Item name="authoritySourceVersion" label="Source version">
                <Input style={{ width: 220 }} />
              </Form.Item>
            </Space>
          </Card>

          <Space style={{ marginBottom: 16 }}>
            <Form.Item name="fourEyesRequired" valuePropName="checked" noStyle>
              <Checkbox>Require two independent reviewers</Checkbox>
            </Form.Item>
            <Form.Item name="nonProduction" valuePropName="checked" noStyle>
              <Checkbox>Non-production</Checkbox>
            </Form.Item>
          </Space>

          <Form.List name="rules">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                {fields.map((field, index) => (
                  <Card
                    key={field.key}
                    size="small"
                    title={`Rule ${index + 1}`}
                    extra={
                      <Button danger size="small" onClick={() => remove(field.name)}>
                        Remove
                      </Button>
                    }
                  >
                    <Space wrap align="start">
                      <Form.Item
                        {...field}
                        name={[field.name, 'id']}
                        label="Rule ID"
                        rules={[{ required: true }]}
                      >
                        <Input style={{ width: 230 }} />
                      </Form.Item>
                      <Form.Item
                        {...field}
                        name={[field.name, 'outcome']}
                        label="Outcome"
                        rules={[{ required: true }]}
                      >
                        <Select
                          style={{ width: 110 }}
                          options={['PASS', 'WARN', 'BLOCK'].map((value) => ({
                            value,
                            label: value,
                          }))}
                        />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'tier']} label="Risk tier">
                        <Select
                          allowClear
                          style={{ width: 140 }}
                          options={['low', 'moderate', 'high', 'restricted'].map((value) => ({
                            value,
                            label: value,
                          }))}
                        />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'code']} label="Decision code">
                        <Input style={{ width: 180 }} />
                      </Form.Item>
                      <Form.Item
                        {...field}
                        name={[field.name, 'enabled']}
                        label="Enabled"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </Space>
                    <Form.Item
                      {...field}
                      name={[field.name, 'description']}
                      label="Description"
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'tools']}
                      label="Matching tools"
                      tooltip="Type a server tool name and press Enter. Other server-derived matching conditions can be added below."
                    >
                      <Select mode="tags" open={false} tokenSeparators={[',']} />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'additionalMatchJson']}
                      label="Additional match conditions (JSON)"
                    >
                      <Input.TextArea
                        rows={3}
                        placeholder={
                          '{\n  "channels": ["email"],\n  "recipientTypes": ["government"]\n}'
                        }
                      />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'reason']}
                      label="Human-readable reason"
                      rules={[{ required: true }]}
                    >
                      <Input.TextArea rows={2} />
                    </Form.Item>
                    <Space wrap align="start" style={{ width: '100%' }}>
                      <Form.Item
                        {...field}
                        name={[field.name, 'authorityRef']}
                        label="Authority reference"
                        rules={[{ required: true }]}
                      >
                        <Input style={{ width: 330 }} />
                      </Form.Item>
                      <Form.Item
                        {...field}
                        name={[field.name, 'tests']}
                        label="Regression test IDs"
                        rules={[{ required: true }]}
                      >
                        <Select
                          mode="tags"
                          open={false}
                          tokenSeparators={[',']}
                          style={{ minWidth: 330 }}
                        />
                      </Form.Item>
                    </Space>
                  </Card>
                ))}
                <Button
                  icon={<PlusOutlined />}
                  onClick={() =>
                    add({
                      outcome: 'WARN',
                      enabled: true,
                      tools: [],
                      tests: [],
                      additionalMatchJson: '',
                    })
                  }
                >
                  Add rule
                </Button>
              </Space>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Modal
        title={
          reasonState
            ? `${reasonState.action.replaceAll('-', ' ')} ${reasonState.pack.version}`
            : ''
        }
        open={Boolean(reasonState)}
        okText="Confirm"
        confirmLoading={operation.isPending}
        onCancel={() => {
          setReasonState(null);
          reasonForm.resetFields();
        }}
        onOk={() => reasonForm.submit()}
        forceRender
      >
        <Form form={reasonForm} layout="vertical" onFinish={submitReason}>
          {reasonState?.action === 'review' && (
            <Form.Item
              name="legalReviewStatus"
              label="Review classification"
              initialValue="approved"
              rules={[{ required: true }]}
            >
              <Select
                options={[
                  { value: 'approved', label: 'Approved' },
                  {
                    value: 'not_required_product_policy',
                    label: 'Not required — approved product policy',
                  },
                ]}
              />
            </Form.Item>
          )}
          {reasonState?.action === 'rollback' && (
            <Form.Item
              name="targetId"
              label="Restore retired version"
              rules={[{ required: true, message: 'Select a rollback target' }]}
            >
              <Select
                options={retired
                  .filter(
                    (candidate) =>
                      candidate.packKey === reasonState.pack.packKey && !candidate.nonProduction,
                  )
                  .map((candidate) => ({
                    value: candidate.id,
                    label: `${candidate.version} · retired`,
                  }))}
              />
            </Form.Item>
          )}
          <Form.Item
            name="reason"
            label="Audit reason"
            rules={[{ required: true, message: 'An audit reason is required' }]}
          >
            <Input.TextArea rows={4} maxLength={4000} showCount />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={simulationPack ? `Simulate ${simulationPack.packKey} ${simulationPack.version}` : ''}
        open={Boolean(simulationPack)}
        width={720}
        okText="Run simulation"
        confirmLoading={simulate.isPending}
        onCancel={() => {
          setSimulationPack(null);
          setSimulationResult(null);
          simulationForm.resetFields();
        }}
        onOk={() => simulationForm.submit()}
        forceRender
      >
        <Alert
          type="warning"
          showIcon
          message="Simulation cannot authorize an action"
          description="The result is logged as simulated and is deliberately non-bindable."
          style={{ marginBottom: 16 }}
        />
        <Form
          form={simulationForm}
          layout="vertical"
          onFinish={(values) => {
            if (!simulationPack) return;
            try {
              simulate.mutate({
                packId: simulationPack.id,
                body: buildSimulationPayload(values),
              });
            } catch (error) {
              message.error(errorMessage(error));
            }
          }}
        >
          <Space wrap align="start">
            <Form.Item name="tool" label="Tool" rules={[{ required: true }]}>
              <Input style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="jurisdiction" label="Jurisdiction">
              <Select
                allowClear
                style={{ width: 180 }}
                options={['federal', 'state', 'local', 'regulatory', 'procurement', 'grants'].map(
                  (value) => ({ value, label: value }),
                )}
              />
            </Form.Item>
            <Form.Item name="clientId" label="Client ID (optional)">
              <Input style={{ width: 300 }} />
            </Form.Item>
          </Space>
          <Form.Item name="inputJson" label="Canonical tool input" rules={[{ required: true }]}>
            <Input.TextArea rows={8} />
          </Form.Item>
        </Form>
        {simulationResult && (
          <Descriptions bordered size="small" column={2} style={{ marginTop: 16 }}>
            <Descriptions.Item label="Outcome">
              <Tag color={outcomeColor(simulationResult.outcome as PolicyOutcome)}>
                {String(simulationResult.outcome)}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Bindable">No</Descriptions.Item>
            <Descriptions.Item label="Rule">
              {String(simulationResult.ruleId ?? 'fallback')}
            </Descriptions.Item>
            <Descriptions.Item label="Reason">
              {String(simulationResult.reason ?? '')}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>

      <Drawer
        title={eventsPack ? `Lifecycle history · ${eventsPack.packKey} ${eventsPack.version}` : ''}
        open={Boolean(eventsPack)}
        width={600}
        onClose={() => setEventsPack(null)}
      >
        {events.isLoading ? (
          <Card loading />
        ) : events.data?.length ? (
          <Collapse
            items={events.data.map((event) => ({
              key: event.id,
              label: (
                <Space>
                  <Tag>{event.action.replaceAll('_', ' ')}</Tag>
                  <Text>{new Date(event.occurredAt).toLocaleString()}</Text>
                </Space>
              ),
              children: (
                <Space direction="vertical">
                  <Text>
                    {event.fromStatus ?? 'none'} → {event.toStatus ?? 'none'}
                  </Text>
                  <Text>{event.reason}</Text>
                  <Text type="secondary">
                    Actor {event.actorUserId} · {event.actorRole}
                  </Text>
                </Space>
              ),
            }))}
          />
        ) : (
          <Empty description="No lifecycle events found" />
        )}
      </Drawer>
    </section>
  );
}
