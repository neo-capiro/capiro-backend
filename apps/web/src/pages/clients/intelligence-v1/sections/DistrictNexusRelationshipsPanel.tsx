import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Alert,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
} from 'antd';
import { EditOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import { useApi } from '../../../../lib/use-api.js';
import { formatMoney } from '../../../intelligence/district-nexus/district-nexus-format.js';
import {
  DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES,
  createDistrictNexusRelationship,
  getDistrictNexusRelationships,
  rejectDistrictNexusRelationship,
  searchDistrictNexusAssistanceAwards,
  updateDistrictNexusRelationship,
  type DistrictNexusAssistanceAwardOption,
  type DistrictNexusAwardRelationshipType,
  type DistrictNexusRelationshipMutation,
  type DistrictNexusRelationshipRecord,
  type DistrictNexusRelationshipStatus,
} from '../district-nexus-relationships-api.js';

const RELATIONSHIP_LABELS: Record<DistrictNexusAwardRelationshipType, string> = {
  direct_recipient: 'Direct recipient',
  subrecipient: 'Subrecipient',
  project_site: 'Project site',
  research_partner: 'Research partner',
  coalition_partner: 'Coalition partner',
  beneficiary: 'Beneficiary',
  matching_contributor: 'Matching contributor',
};

const STATUS_COLORS: Record<DistrictNexusRelationshipStatus, string> = {
  unverified: 'gold',
  verified: 'green',
  rejected: 'default',
};

interface Props {
  clientId: string;
  canManage: boolean;
}

interface FormValues {
  assistanceAwardId: string;
  relationshipType: DistrictNexusAwardRelationshipType;
  facilityId?: string;
  relationshipDescription?: string;
  attributableAmount?: number;
  beneficiaryCount?: number;
  evidenceSourceRef?: string;
  verificationStatus: DistrictNexusRelationshipStatus;
  externalUseApproved?: boolean;
  effectiveStart?: string;
  effectiveEnd?: string;
}

function awardLabel(award: DistrictNexusAssistanceAwardOption): string {
  const identity = award.fain ?? award.awardUniqueId;
  const recipient = award.recipientName ?? 'Unnamed recipient';
  const amount = formatMoney(award.totalObligatedAmount);
  return `${recipient} · ${identity} · ${amount}`;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { message?: string | string[] } } }).response;
    const message = response?.data?.message;
    if (Array.isArray(message)) return message.join(' ');
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : 'The relationship could not be saved.';
}

function toFormValues(row: DistrictNexusRelationshipRecord): FormValues {
  return {
    assistanceAwardId: row.assistanceAwardId,
    relationshipType: row.relationshipType,
    facilityId: row.facilityId ?? undefined,
    relationshipDescription: row.relationshipDescription ?? undefined,
    attributableAmount: row.attributableAmount ?? undefined,
    beneficiaryCount: row.beneficiaryCount ?? undefined,
    evidenceSourceRef: row.evidenceSourceRef ?? undefined,
    verificationStatus: row.verificationStatus,
    externalUseApproved: row.externalUseApproved,
    effectiveStart: row.effectiveStart ?? undefined,
    effectiveEnd: row.effectiveEnd ?? undefined,
  };
}

function toMutation(values: FormValues): DistrictNexusRelationshipMutation {
  return {
    assistanceAwardId: values.assistanceAwardId,
    relationshipType: values.relationshipType,
    facilityId: values.facilityId || null,
    relationshipDescription: values.relationshipDescription?.trim() || null,
    attributableAmount: values.attributableAmount ?? null,
    beneficiaryCount: values.beneficiaryCount ?? null,
    evidenceSourceRef: values.evidenceSourceRef?.trim() || null,
    verificationStatus: values.verificationStatus,
    externalUseApproved: values.externalUseApproved ?? false,
    effectiveStart: values.effectiveStart || null,
    effectiveEnd: values.effectiveEnd || null,
  };
}

export function DistrictNexusRelationshipsPanel({ clientId, canManage }: Props) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DistrictNexusRelationshipRecord | null>(null);
  const [awardSearch, setAwardSearch] = useState('');
  const relationshipType = Form.useWatch('relationshipType', form);
  const verificationStatus = Form.useWatch('verificationStatus', form);

  const relationships = useQuery({
    queryKey: ['district-nexus-relationships', clientId],
    queryFn: () => getDistrictNexusRelationships(api, clientId),
    enabled: Boolean(clientId),
    staleTime: 60_000,
    retry: 1,
  });

  const awardOptions = useQuery({
    queryKey: ['district-nexus-assistance-award-search', awardSearch.trim()],
    queryFn: () => searchDistrictNexusAssistanceAwards(api, awardSearch.trim()),
    enabled: open && awardSearch.trim().length >= 2,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const selectableAwards = useMemo(() => {
    const byId = new Map<string, DistrictNexusAssistanceAwardOption>();
    if (editing) byId.set(editing.award.id, editing.award);
    for (const award of awardOptions.data ?? []) byId.set(award.id, award);
    return [...byId.values()];
  }, [awardOptions.data, editing]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['district-nexus-relationships', clientId] }),
      queryClient.invalidateQueries({ queryKey: ['client-district-nexus-v2', clientId] }),
      queryClient.invalidateQueries({ queryKey: ['district-nexus', 'map'] }),
      queryClient.invalidateQueries({ queryKey: ['district-nexus', 'detail'] }),
    ]);
  };

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = toMutation(values);
      return editing
        ? updateDistrictNexusRelationship(api, clientId, editing.id, payload)
        : createDistrictNexusRelationship(api, clientId, payload);
    },
    onSuccess: async () => {
      await refresh();
      message.success(editing ? 'Grant relationship updated.' : 'Grant relationship added.');
      setOpen(false);
      setEditing(null);
      setAwardSearch('');
      form.resetFields();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const reject = useMutation({
    mutationFn: (id: string) => rejectDistrictNexusRelationship(api, clientId, id),
    onSuccess: async () => {
      await refresh();
      message.success('Relationship rejected and removed from the nexus score.');
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const beginCreate = () => {
    setEditing(null);
    setAwardSearch('');
    form.resetFields();
    form.setFieldsValue({
      relationshipType: 'subrecipient',
      verificationStatus: 'unverified',
      externalUseApproved: false,
    });
    setOpen(true);
  };

  const beginEdit = (row: DistrictNexusRelationshipRecord) => {
    setEditing(row);
    setAwardSearch(row.award.recipientName ?? row.award.fain ?? '');
    form.setFieldsValue(toFormValues(row));
    setOpen(true);
  };

  const rows = relationships.data?.relationships ?? [];
  const activeRows = rows.filter((row) => row.verificationStatus !== 'rejected');
  const rejectedRows = rows.filter((row) => row.verificationStatus === 'rejected');

  return (
    <div className="iv1-surface" style={{ marginTop: 14 }}>
      <div className="iv1-surface-head">
        <div>
          <h3>Reviewed grant relationships</h3>
          <span className="iv1-surface-sub">
            Explicit subrecipient, project-site, partner, beneficiary, and matching-fund evidence
          </span>
        </div>
        {canManage ? (
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={beginCreate}>
            Add relationship
          </Button>
        ) : null}
      </div>

      {relationships.isLoading ? <Spin size="small" /> : null}
      {relationships.isError ? (
        <Alert
          type="error"
          showIcon
          message="Grant relationships could not load"
          description="This is a request failure, not confirmation that no relationships exist."
          action={<Button size="small" onClick={() => void relationships.refetch()}>Retry</Button>}
        />
      ) : null}

      {!relationships.isLoading && !relationships.isError && activeRows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            canManage
              ? 'No reviewed award-bearing grant relationships have been entered.'
              : 'No reviewed award-bearing grant relationships are on file.'
          }
        />
      ) : null}

      {activeRows.length ? (
        <div className="iv1-dnx-list">
          {activeRows.map((row) => (
            <div className="iv1-dnx-row" key={row.id}>
              <div className="iv1-dnx-row-top">
                <span className="iv1-dnx-district">{RELATIONSHIP_LABELS[row.relationshipType]}</span>
                <Tag color={STATUS_COLORS[row.verificationStatus]}>
                  {row.verificationStatus.replace(/_/g, ' ')}
                </Tag>
                {row.externalUseApproved ? <Tag color="blue">External use approved</Tag> : null}
                <span className="iv1-dnx-amt">{formatMoney(row.attributableAmount)}</span>
              </div>
              <div className="iv1-dnx-row-sub">
                <b>{row.award.recipientName ?? 'Unnamed recipient'}</b>
                {' · '}
                {row.award.fain ?? row.award.awardUniqueId}
                {row.award.assistanceListingNumber
                  ? ` · ALN ${row.award.assistanceListingNumber}`
                  : ''}
              </div>
              <div className="iv1-dnx-row-sub">
                Geography: {row.facility
                  ? `${row.facility.name}${row.facility.state ? `, ${row.facility.state}` : ''}`
                  : row.award.state && row.award.congressionalDistrict
                    ? `${row.award.state}-${row.award.congressionalDistrict} (${row.award.geographyBasis.replace(/_/g, ' ')})`
                    : 'not district-resolved'}
                {row.beneficiaryCount != null
                  ? ` · ${row.beneficiaryCount.toLocaleString()} beneficiaries`
                  : ''}
              </div>
              {row.relationshipDescription ? (
                <div className="iv1-dnx-row-sub">{row.relationshipDescription}</div>
              ) : null}
              {row.evidenceSourceRef ? (
                <div className="iv1-dnx-row-sub">Source: {row.evidenceSourceRef}</div>
              ) : null}
              {canManage ? (
                <Space size={8} style={{ marginTop: 8 }}>
                  <Button size="small" icon={<EditOutlined />} onClick={() => beginEdit(row)}>
                    Edit
                  </Button>
                  <Popconfirm
                    title="Reject this relationship?"
                    description="It will remain in the audit history but stop contributing to District Nexus."
                    okText="Reject"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => reject.mutate(row.id)}
                  >
                    <Button size="small" danger icon={<StopOutlined />} loading={reject.isPending}>
                      Reject
                    </Button>
                  </Popconfirm>
                </Space>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {rejectedRows.length ? (
        <div className="iv1-dnx-disclaimer" style={{ marginTop: 10 }}>
          {rejectedRows.length} rejected relationship{rejectedRows.length === 1 ? '' : 's'} retained in the audit history.
        </div>
      ) : null}

      <Modal
        title={editing ? 'Edit grant relationship' : 'Add grant relationship'}
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
          setAwardSearch('');
          form.resetFields();
        }}
        okText={editing ? 'Save changes' : 'Add relationship'}
        confirmLoading={save.isPending}
        onOk={() => void form.validateFields().then((values) => save.mutate(values))}
        destroyOnClose
        width={720}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Enter only evidence you can substantiate"
          description="Direct-recipient rows may use the full federal obligation. Every other role contributes presence unless an attributable amount is explicitly documented."
        />
        <Form<FormValues> form={form} layout="vertical" requiredMark="optional">
          <Form.Item
            label="Federal assistance award"
            name="assistanceAwardId"
            rules={[{ required: true, message: 'Select the underlying federal assistance award.' }]}
          >
            <Select
              showSearch
              filterOption={false}
              onSearch={setAwardSearch}
              notFoundContent={
                awardSearch.trim().length < 2
                  ? 'Type at least two characters'
                  : awardOptions.isFetching
                    ? <Spin size="small" />
                    : 'No matching awards'
              }
              options={selectableAwards.map((award) => ({
                value: award.id,
                label: awardLabel(award),
              }))}
              placeholder="Search recipient, FAIN, UEI, award ID, or Assistance Listing"
            />
          </Form.Item>

          <Form.Item
            label="Relationship type"
            name="relationshipType"
            rules={[{ required: true }]}
          >
            <Select
              options={DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES.map((value) => ({
                value,
                label: RELATIONSHIP_LABELS[value],
              }))}
            />
          </Form.Item>

          <Form.Item
            label="Client facility / project site"
            name="facilityId"
            rules={
              relationshipType === 'project_site'
                ? [{ required: true, message: 'Project-site evidence requires a client facility.' }]
                : undefined
            }
          >
            <Select
              allowClear
              placeholder="Use award geography unless a verified site is known"
              options={(relationships.data?.facilities ?? []).map((facility) => ({
                value: facility.id,
                label: `${facility.name}${facility.city ? ` · ${facility.city}` : ''}${facility.state ? `, ${facility.state}` : ''}`,
              }))}
            />
          </Form.Item>

          <Form.Item label="Relationship description" name="relationshipDescription">
            <Input.TextArea
              rows={3}
              maxLength={2_000}
              showCount
              placeholder="Describe the client's role and why it creates a district connection."
            />
          </Form.Item>

          <Space size={16} align="start" style={{ width: '100%' }}>
            <Form.Item label="Attributable amount" name="attributableAmount">
              <InputNumber<number>
                min={0}
                precision={2}
                style={{ width: 210 }}
                prefix="$"
                placeholder="Leave blank if unknown"
              />
            </Form.Item>
            <Form.Item label="Beneficiary count" name="beneficiaryCount">
              <InputNumber<number>
                min={0}
                precision={0}
                style={{ width: 180 }}
                placeholder="Optional"
              />
            </Form.Item>
          </Space>

          <Form.Item label="Evidence source" name="evidenceSourceRef">
            <Input
              maxLength={1_000}
              placeholder="Document URL, file reference, agreement name, or reviewer note"
            />
          </Form.Item>

          <Space size={16} align="start" style={{ width: '100%' }}>
            <Form.Item label="Effective start" name="effectiveStart">
              <Input type="date" style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="Effective end" name="effectiveEnd">
              <Input type="date" style={{ width: 180 }} />
            </Form.Item>
          </Space>

          <Form.Item
            label="Review status"
            name="verificationStatus"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 'unverified', label: 'Unverified — user-provided evidence' },
                { value: 'verified', label: 'Verified — reviewed and substantiated' },
                { value: 'rejected', label: 'Rejected — does not contribute to the score' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label="Approved for external materials"
            name="externalUseApproved"
            valuePropName="checked"
            extra="Only verified relationships may be approved for use in client-facing or external materials."
          >
            <Switch disabled={verificationStatus !== 'verified'} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
